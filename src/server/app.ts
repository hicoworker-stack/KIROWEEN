import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBaselineNodes,
  DIFFERENTIAL_SCENARIOS,
  generateBaselineSeries,
  NETWORK_PIPES,
} from '../core/networkData';
import {
  computeRiskPriorityScore,
  evaluateTelemetryReading,
  parseCsvTelemetry,
} from '../core/deterministicEngine';
import { enrichAnomalyWithNetworkContext } from '../core/graphHydrology';
import { appendLedgerEntry, verifyLedgerChain } from '../core/cryptoLedger';
import {
  AnomalyCategory,
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  OfflineReportRecord,
  ScenarioId,
  SignedAnchor,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
  WorkOrderStatus,
} from '../core/types';
import {
  attachEvidence,
  buildChecklist,
  closureBlockers,
  ensureChecklist,
  normalizeAssignee,
  parseEvidenceDataUrl,
  sanitizeFileName,
  setChecklistItem,
  WorkOrderError,
} from '../core/workOrders';
import { evaluateConcordance, ConcordanceReport } from '../core/evidenceConcordance';
import { selectVisionForAnomaly, visionRoleForAnomaly } from '../core/evidenceLinking';
import { diagnoseHydraulics, HydraulicDiagnosis, toHydraulicEvidence } from '../core/hydraulicDiagnosis';
import {
  readingDedupKey,
  readingFingerprint,
  validateReadingBatch,
} from '../core/telemetryValidation';
import { classifyOfflineReport } from '../core/offlineConflict';
import { repairTelemetryState } from '../core/stateRepair';
import { auditStateConsistency } from '../core/consistency';
import { SealedContent } from '../core/dossier';
import { buildScenarioFrames } from '../sim/scenarioGenerator';
import {
  analyzeVisionEvidence,
  buildFallbackDiagnosis,
  buildFallbackVisionAnalysis,
  createBudget,
  getGeminiLimits,
  getProviderStatus,
  probeGemini,
  synthesizeDiagnosis,
  validateImagePayload,
} from './aiProvider';
import { DEFAULT_STATE_PATH, loadPersistedState } from './persistence';
import { defaultEvidenceDir, readEvidence, saveEvidence } from './evidenceStore';
import { buildSnapshot, describePersistence, restoreEvidence, validateSnapshot } from './snapshot';
import { Mutex, PersistenceTracker } from './runtime';
import { errorMiddleware, HttpError, installAsyncSafety } from './http';
import { actorLabel, bigBody, destructiveGuard, installSecurityPipeline, limitUser, SecurityDeps } from './authApi';
import { AuditLog } from './auditLog';
import { AUTHENTICATED_ONLY, can, needs } from './authz';
import { AuthStore, AuthStoreOptions, DEFAULT_ABSOLUTE_MS, DEFAULT_IDLE_MS } from './authStore';
import { loadSecurityConfig, SecurityConfig } from './netSecurity';
import { OperationTokens } from './operationTokens';
import { assertPublicStateIsSynthetic, isPublicModeEnabled, redactForVisitor } from './publicMode';
import { RateLimiter, parseRateLimitEnv, LimitSpec, BucketName } from './rateLimit';
import {
  checkAnchorAgainstLedger,
  issueAnchor,
  loadOrCreateSealKeys,
  verifyAnchorSignature,
} from './sealing';
import { exportDossier, finalizeSeal, prepareSeal } from './dossierService';
import { verifyDossierFull } from './dossierVerify';

/**
 * Aplicación Aqua Sentinel (API). Toda ruta que lee-modifica-escribe el estado se ejecuta dentro de una exclusión
 * mutua (REQ-RES-04); las llamadas a servicios externos (IA) se hacen FUERA de ella y su resultado solo se aplica si el
 * estado no cambió de época mientras tanto (REQ-AI-06).
 */

interface AppState {
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  anomalies: AnomalyEvent[];
  visionAnalyses: VisionAnalysisResult[];
  diagnoses: AquaBrainDiagnosis[];
  workOrders: SmartWorkOrder[];
  ledger: TrustLedgerEntry[];
  syncedOfflineKeys: Set<string>;
  sealedDossiers: Record<string, SealedContent>;
  anchors: SignedAnchor[];
  seenReadingKeys: Record<string, string>;
}

export interface IntegrityStatus {
  status: 'ok' | 'degraded' | 'compromised';
  issues: string[];
  checkedAt: string;
}

export interface AppOptions {
  statePath?: string;
  evidenceDir?: string;
  /** Ubicación de auth.json y audit.jsonl (por defecto junto al estado; NUNCA dentro del estado que reset/import reemplazan). */
  authPath?: string;
  auditPath?: string;
  /** Entorno de configuración (por defecto process.env). */
  env?: Record<string, string | undefined>;
  security?: SecurityConfig;
  rateLimits?: Partial<Record<BucketName, Partial<LimitSpec>>>;
  /** Reloj inyectable (pruebas de caducidad de sesiones). */
  now?: () => number;
  authStoreOptions?: AuthStoreOptions;
  auditAppendLine?: (file: string, line: string) => void;
  /** Habilita el asistente de primer administrador por HTTP. Por defecto: solo fuera de producción o con AQUA_SETUP_ENABLED=1 (y nunca en modo público). */
  setupEnabled?: boolean;
  /** MODO PÚBLICO: visitantes anónimos de solo lectura en rutas GET acotadas. Por defecto lo decide AQUA_PUBLIC_MODE. */
  publicMode?: boolean;
}

export interface AppHandle {
  app: Express;
  shutdown(): void;
  /** Solo para pruebas y diagnóstico. */
  inspect(): { epoch: number; integrity: IntegrityStatus };
  publicMode: boolean;
  authStore: AuthStore;
  audit: AuditLog;
  /** Código de un solo uso para crear el primer administrador (null si ya existe uno o el asistente está deshabilitado). */
  setupCode: { code: string; expiresAt: string } | null;
}

type LedgerPayload = Parameters<typeof appendLedgerEntry>[1];

const REQUIRED_CONSECUTIVE = 2;
const MAX_SEEN_KEYS = 5000;
const MAX_ANCHORS = 50;
const REPORT_CATEGORIES: AnomalyCategory[] = ['leak', 'obstruction', 'sensor_fault', 'contamination', 'quality_drift'];

function healthFromCategory(category: AnomalyEvent['category']): NetworkNode['status'] {
  if (category === 'contamination' || category === 'leak') return 'critical';
  if (category === 'obstruction' || category === 'quality_drift') return 'warning';
  if (category === 'sensor_fault') return 'fault';
  return 'nominal';
}
const STATUS_RANK: Record<NetworkNode['status'], number> = { nominal: 0, warning: 1, critical: 2, fault: 3 };

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : undefined;
}

export async function createApp(options: AppOptions = {}): Promise<AppHandle> {
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const evidenceDir = options.evidenceDir ?? defaultEvidenceDir(statePath);
  const env = options.env ?? process.env;
  const app = express();
  app.disable('x-powered-by');
  installAsyncSafety(app);

  const mutex = new Mutex();
  const persistence = new PersistenceTracker(statePath);
  const keys = loadOrCreateSealKeys({ dir: path.dirname(statePath), envPem: env.AQUA_SEAL_PRIVATE_KEY_PEM });
  const publicMode = options.publicMode ?? isPublicModeEnabled(env);
  // En modo público JAMÁS se aceptan lecturas como datos de campo: todo lo que entre es sintético.
  const trustSyntheticFlag = !publicMode && env.AQUA_FIELD_DATA === '1';

  // ───────────── Seguridad (Fase 2): usuarios, sesiones, auditoría, cupos ─────────────
  // auth.json y audit.jsonl viven FUERA del estado de la red: reset, demo e import no pueden borrarlos.
  const securityCfg = options.security ?? loadSecurityConfig(env);
  const authDir = path.dirname(statePath);
  const sessionIdleMs = Number(env.AQUA_SESSION_IDLE_MS) > 0 ? Number(env.AQUA_SESSION_IDLE_MS) : DEFAULT_IDLE_MS;
  // Cada cuánto el flujo de eventos comprueba la sesión y envía un latido (F3: tope de lo que sobrevive tras caducar).
  const ssePingMs = Math.min(15_000, Math.max(200, Number(env.AQUA_SSE_PING_MS) || 15_000));
  const sessionAbsoluteMs = Number(env.AQUA_SESSION_ABSOLUTE_MS) > 0 ? Number(env.AQUA_SESSION_ABSOLUTE_MS) : DEFAULT_ABSOLUTE_MS;
  const authStore = AuthStore.open(options.authPath ?? path.join(authDir, 'auth.json'), { idleMs: sessionIdleMs, absoluteMs: sessionAbsoluteMs, now: options.now, ...options.authStoreOptions });
  const audit = AuditLog.open(options.auditPath ?? path.join(authDir, 'audit.jsonl'), { keys, now: options.now, appendLine: options.auditAppendLine });
  // Una instancia pública detrás de un proxy comparte IP entre muchos visitantes: cupo anónimo más amplio (ajustable con AQUA_RATE_LIMITS).
  const publicDefaults: Partial<Record<BucketName, Partial<LimitSpec>>> = publicMode ? { 'api-anon': { max: 600, windowMs: 60_000 } } : {};
  const limiter = new RateLimiter({ ...publicDefaults, ...parseRateLimitEnv(env.AQUA_RATE_LIMITS), ...options.rateLimits }, options.now);
  const opTokens = new OperationTokens(options.now);
  // El modo público nunca ofrece el asistente de primer administrador: quien explora no debe ver pedir un código de administrador.
  const setupEnabled = options.setupEnabled ?? (!publicMode && (!securityCfg.production || env.AQUA_SETUP_ENABLED === '1'));
  const security: SecurityDeps = { cfg: securityCfg, store: authStore, audit, limiter, opTokens, setupEnabled, sessionMaxAgeSec: Math.floor(sessionAbsoluteMs / 1000), publicMode };
  installSecurityPipeline(app, security);
  const setupCode = setupEnabled && !authStore.hasUsers() ? await authStore.issueSetupCode() : null;

  const ctx = {
    epoch: 1,
    hydraulic: null as HydraulicDiagnosis | null,
    excessStreak: {} as Record<string, number>,
    integrity: { status: 'ok', issues: [], checkedAt: new Date().toISOString() } as IntegrityStatus,
  };

  // ───────────── Estado inicial ─────────────

  interface RequestedBy {
    actor: string;
    id: string;
    username: string;
    role: string;
    authorizationSeq?: number;
    auditHeadHash?: string;
  }
  const requestedByOf = (req: Request, res: Response): RequestedBy => ({
    actor: actorLabel(req.auth!.user),
    id: req.auth!.user.id,
    username: req.auth!.user.username,
    role: req.auth!.user.role,
    authorizationSeq: res.locals.authorizationSeq as number | undefined,
    auditHeadHash: res.locals.auditHeadHash as string | undefined,
  });

  async function createInitialState(
    previous?: { height: number; headHash: string | null; archivedTo: string | null; anchor: SignedAnchor | null },
    requestedBy?: RequestedBy
  ): Promise<AppState> {
    const nodes = createBaselineNodes();
    const seriesByNode: Record<string, TelemetryReading[]> = {};
    for (const node of nodes) seriesByNode[node.id] = generateBaselineSeries(node, 14);
    const ledger = await appendLedgerEntry([], {
      action: 'NETWORK_INITIALIZED',
      actor: requestedBy?.actor ?? 'Sistema Aqua Sentinel',
      assetId: 'RED-SAN-CRISTOBAL',
      evidenceSummary: previous
        ? `Red comunitaria sintética reiniciada (7 nodos). La cadena anterior (${previous.height} bloques) se archivó y su cabeza queda referenciada.`
        : 'Inicialización de red comunitaria sintética (7 nodos hidráulicos) con línea base nominal.',
      previousState: previous ? 'reinicio' : 'uninitialized',
      newState: 'nominal',
      evidenceData: {
        nodeCount: nodes.length,
        synthetic: true,
        ...(previous ? { previousChain: previous } : {}),
        ...(requestedBy
          ? { requestedBy: { id: requestedBy.id, username: requestedBy.username, role: requestedBy.role, authenticated: true }, auditAuthorizationSeq: requestedBy.authorizationSeq ?? null, auditHeadAtAuthorization: requestedBy.auditHeadHash ?? null }
          : {}),
      },
    });
    return {
      nodes,
      seriesByNode,
      anomalies: [],
      visionAnalyses: [],
      diagnoses: [],
      workOrders: [],
      ledger,
      syncedOfflineKeys: new Set<string>(),
      sealedDossiers: {},
      anchors: [],
      seenReadingKeys: {},
    };
  }

  const startupNotes: string[] = [];
  const persisted = loadPersistedState(statePath);
  let state: AppState;
  if (persisted) {
    const repaired = repairTelemetryState(persisted.nodes, persisted.seriesByNode, createBaselineNodes());
    startupNotes.push(...repaired.repairs);
    state = {
      nodes: repaired.nodes,
      seriesByNode: repaired.seriesByNode,
      anomalies: persisted.anomalies,
      visionAnalyses: persisted.visionAnalyses,
      diagnoses: persisted.diagnoses,
      workOrders: persisted.workOrders.map(ensureChecklist),
      ledger: persisted.ledger,
      syncedOfflineKeys: new Set(persisted.syncedOfflineKeys),
      sealedDossiers: (persisted.sealedDossiers ?? {}) as Record<string, SealedContent>,
      anchors: persisted.anchors ?? [],
      seenReadingKeys: persisted.seenReadingKeys ?? {},
    };
  } else {
    state = await createInitialState();
  }

  if (publicMode) assertPublicStateIsSynthetic(state.nodes);

  const persistedShape = () => ({
    nodes: state.nodes,
    seriesByNode: state.seriesByNode,
    anomalies: state.anomalies,
    visionAnalyses: state.visionAnalyses,
    diagnoses: state.diagnoses,
    workOrders: state.workOrders,
    ledger: state.ledger,
    syncedOfflineKeys: Array.from(state.syncedOfflineKeys),
    sealedDossiers: state.sealedDossiers,
    anchors: state.anchors,
    seenReadingKeys: state.seenReadingKeys,
  });

  async function computeIntegrity(): Promise<IntegrityStatus> {
    const issues: string[] = [...startupNotes];
    let status: IntegrityStatus['status'] = startupNotes.length > 0 ? 'degraded' : 'ok';
    const chain = await verifyLedgerChain(state.ledger);
    if (!chain.valid) {
      status = 'compromised';
      issues.push(`Cadena del ledger rota: ${chain.reason ?? `bloque #${chain.brokenIndex}`}`);
    }
    for (const a of state.anchors) {
      if (a.payload.keyId !== keys.keyId) {
        issues.push(`Ancla de otra clave de sellado (altura ${a.payload.height}): no verificable con la clave actual.`);
        if (status === 'ok') status = 'degraded';
        continue;
      }
      if (!verifyAnchorSignature(keys.publicKeyPem, a)) {
        status = 'compromised';
        issues.push(`Ancla con firma inválida (altura ${a.payload.height}).`);
        continue;
      }
      const c = checkAnchorAgainstLedger(a, state.ledger);
      if (!c.ok) {
        status = 'compromised';
        issues.push(`Ancla firmada incoherente con el ledger: ${c.reason}`);
      }
    }
    const consistency = auditStateConsistency(state);
    for (const i of consistency) {
      issues.push(`${i.code}: ${i.message}`);
      if (i.severity === 'error' && status === 'ok') status = 'degraded';
    }
    return { status, issues: issues.slice(0, 50), checkedAt: new Date().toISOString() };
  }

  ctx.integrity = await computeIntegrity();
  if (ctx.integrity.status !== 'ok') console.warn(`[integridad] Estado ${ctx.integrity.status}:`, ctx.integrity.issues.slice(0, 5));

  const sseClients = new Set<express.Response>();
  const sseMeta = new Map<express.Response, { userId: string; idHash: string; visitor: boolean }>();

  const statePayload = () => ({
    nodes: state.nodes,
    seriesByNode: state.seriesByNode,
    anomalies: state.anomalies,
    visionAnalyses: state.visionAnalyses,
    diagnoses: state.diagnoses,
    workOrders: state.workOrders,
    ledger: state.ledger,
    hydraulic: ctx.hydraulic,
    provider: getProviderStatus(),
    persistence: persistence.snapshot(),
    integrity: ctx.integrity,
  });

  const persistAndBroadcast = (broadcast = false) => {
    persistence.write(persistedShape());
    if (!broadcast || sseClients.size === 0) return;
    const full = statePayload();
    const fullJson = JSON.stringify(full);
    let visitorJson: string | null = null;
    for (const client of [...sseClients]) {
      try {
        const meta = sseMeta.get(client);
        // F3: antes de enviar estado a un flujo con sesión se comprueba que siga vigente (también por inactividad).
        if (meta && !meta.visitor && !authStore.isSessionValid(meta.idHash)) {
          closeStream(client);
          continue;
        }
        // Los visitantes anónimos reciben la versión redactada; los usuarios con sesión, la completa.
        let payload = fullJson;
        if (meta?.visitor) payload = visitorJson ??= JSON.stringify(redactForVisitor(full));
        client.write(`event: state_update\ndata: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const append = async (payload: LedgerPayload): Promise<TrustLedgerEntry> => {
    state.ledger = await appendLedgerEntry(state.ledger, payload);
    return state.ledger[state.ledger.length - 1];
  };

  /**
   * REQ-AUD-03: el actor de una acción de usuario sale SIEMPRE de la sesión autenticada. El ledger guarda además el
   * id, el usuario y el rol en evidenceData; cualquier nombre que envíe el cliente se guarda aparte, etiquetado como declarado.
   */
  const asUser = (req: Request, payload: Omit<LedgerPayload, 'actor'>): LedgerPayload => {
    const u = req.auth!.user;
    return {
      ...payload,
      actor: actorLabel(u),
      evidenceData: { ...(payload.evidenceData as Record<string, unknown> | undefined), actorId: u.id, actorUsername: u.username, actorRole: u.role, actorAuthenticated: true },
    } as LedgerPayload;
  };

  const pushAnchor = () => {
    state.anchors = [...state.anchors, issueAnchor(keys, state.ledger)].slice(-MAX_ANCHORS);
  };

  /** Envuelve una ruta para ejecutarla dentro de la exclusión mutua. */
  const locked =
    (handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    (req, res, next) =>
      mutex.runExclusive(() => handler(req, res)).catch(next);

  // ───────────── Hidráulica de red ─────────────

  function confirmingPhotoNodes(): string[] {
    const out: string[] = [];
    for (const a of state.anomalies) {
      if (a.status !== 'active' || a.category !== 'leak') continue;
      const v = selectVisionForAnomaly(state.visionAnalyses, a);
      if (v && visionRoleForAnomaly(v, a) === 'confirmatory') out.push(a.nodeId);
    }
    return out;
  }

  function nodeStatusFor(nodeId: string, raw: AnomalyEvent | null): NetworkNode['status'] {
    let status: NetworkNode['status'] = raw ? healthFromCategory(raw.category) : 'nominal';
    const net = state.anomalies.find((a) => a.nodeId === nodeId && a.status === 'active' && a.origin === 'network-balance');
    if (net) {
      const netStatus: NetworkNode['status'] = net.hydraulicLevel === 'localized_leak' ? 'critical' : 'warning';
      if (STATUS_RANK[netStatus] > STATUS_RANK[status]) status = netStatus;
    }
    return status;
  }

  /** Evalúa el balance hidráulico de toda la red y crea o escala incidentes de fuga. Debe llamarse dentro de la exclusión mutua. */
  async function runNetworkEvaluation(): Promise<AnomalyEvent[]> {
    const diag = diagnoseHydraulics(state.nodes, NETWORK_PIPES, {
      streak: ctx.excessStreak,
      requiredConsecutive: REQUIRED_CONSECUTIVE,
      confirmingPhotoNodeIds: confirmingPhotoNodes(),
    });
    ctx.hydraulic = diag;
    for (const b of diag.balances) {
      if (b.state === 'excess') ctx.excessStreak[b.nodeId] = (ctx.excessStreak[b.nodeId] ?? 0) + 1;
      else if (b.state !== 'not_evaluable') ctx.excessStreak[b.nodeId] = 0;
    }

    const changed: AnomalyEvent[] = [];
    for (const f of diag.findings) {
      if (f.level === 'flow_anomaly') continue; // se informa en el panel hidráulico, no abre incidente ni orden
      const nodeIdx = state.nodes.findIndex((n) => n.id === f.nodeId);
      const node = state.nodes[nodeIdx];
      // F2: con una orden recién cerrada, las lecturas del punto son anteriores al cierre. No se reabre un incidente con ellas:
      // hay que esperar una medición nueva.
      if (node.pendingVerification && Date.parse(node.current.timestamp) <= Date.parse(node.pendingVerification.closedAt)) continue;
      const existing = state.anomalies.find((a) => a.nodeId === f.nodeId && a.status === 'active' && a.origin === 'network-balance');
      const reach = f.candidates.map((c) => c.pipeId).join(', ');
      const title =
        f.level === 'localized_leak'
          ? `Fuga localizada en el tramo ${reach}: exceso de caudal de ${f.excessLs} ± ${f.sigmaLs} L/s`
          : `Posible fuga desde ${f.nodeName}: exceso de caudal de ${f.excessLs} ± ${f.sigmaLs} L/s (tramos candidatos: ${reach})`;
      const hit = {
        ruleId: 'HYDRAULIC_MASS_IMBALANCE' as const,
        title: 'Exceso de caudal frente al balance de masa, corroborado por la respuesta de presión',
        category: 'leak' as const,
        severityScore: Math.max(45, Math.min(90, Math.round(40 + 120 * (f.excessLs / Math.max(1, node.baseline.flowLs))))),
        metric: 'massBalanceLs',
        observedValue: f.excessLs,
        baselineValue: 0,
        deltaPct: Number(((f.excessLs / Math.max(1, node.baseline.flowLs)) * 100).toFixed(1)),
        explanation: f.rationale.join(' '),
      };
      if (existing) {
        if (existing.hydraulicLevel === f.level) continue;
        const updated: AnomalyEvent = { ...existing, title, hydraulicLevel: f.level, rulesTriggered: [hit], priority: computeRiskPriorityScore({ category: 'leak', maxRuleSeverity: hit.severityScore, populationServed: node.populationServed, ruleCount: 2 }) };
        state.anomalies = state.anomalies.map((a) => (a.id === existing.id ? updated : a));
        state.nodes[nodeIdx] = { ...node, status: nodeStatusFor(node.id, null) };
        await append({
          action: 'ANOMALY_ESCALATED',
          actor: 'Motor Hidráulico',
          assetId: node.id,
          evidenceSummary: `${existing.id}: ${existing.hydraulicLevel} → ${f.level}`,
          previousState: existing.hydraulicLevel ?? 'n/d',
          newState: f.level,
          evidenceData: { anomalyId: existing.id, level: f.level, excessLs: f.excessLs, sigmaLs: f.sigmaLs, pressure: f.pressure.verdict },
        });
        changed.push(updated);
        continue;
      }
      const base: AnomalyEvent = {
        id: `ANOM-${node.id}-NET-${Date.now().toString(36).toUpperCase()}`,
        timestamp: node.current.timestamp,
        nodeId: node.id,
        nodeName: node.name,
        sector: node.sector,
        category: 'leak',
        title,
        status: 'active',
        rulesTriggered: [hit],
        priority: computeRiskPriorityScore({ category: 'leak', maxRuleSeverity: hit.severityScore, populationServed: node.populationServed, ruleCount: 2 }),
        telemetrySnapshot: node.current,
        baselineSnapshot: node.baseline,
        synthetic: state.nodes.every((n) => n.current.synthetic),
        origin: 'network-balance',
        hydraulicLevel: f.level,
      };
      const anomaly = enrichAnomalyWithNetworkContext(base, state.nodes, NETWORK_PIPES);
      state.anomalies = [anomaly, ...state.anomalies];
      state.nodes[nodeIdx] = { ...node, status: nodeStatusFor(node.id, null) };
      await append({
        action: 'ANOMALY_DETECTED',
        actor: 'Motor Hidráulico',
        assetId: node.id,
        evidenceSummary: `${title} (${anomaly.priority.priority})`,
        previousState: node.status,
        newState: state.nodes[nodeIdx].status,
        evidenceData: {
          anomalyId: anomaly.id,
          rules: ['HYDRAULIC_MASS_IMBALANCE'],
          level: f.level,
          excessLs: f.excessLs,
          sigmaLs: f.sigmaLs,
          z: f.z,
          pressure: f.pressure.verdict,
          candidates: f.candidates.map((c) => c.pipeId),
          synthetic: anomaly.synthetic,
        },
      });
      changed.push(anomaly);
    }
    return changed;
  }

  // ───────────── Ingesta ─────────────

  interface IngestResult {
    accepted: number;
    duplicates: number;
    conflicts: string[];
    anomalies: AnomalyEvent[];
  }

  /** Ingesta de lecturas ya validadas. Debe llamarse dentro de la exclusión mutua. */
  async function ingestReadings(readings: TelemetryReading[]): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicates: 0, conflicts: [], anomalies: [] };
    const ordered = [...readings].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const r of ordered) {
      const key = readingDedupKey(r);
      const fingerprint = readingFingerprint(r);
      const previous = state.seenReadingKeys[key];
      if (previous !== undefined) {
        if (previous === fingerprint) result.duplicates++;
        else result.conflicts.push(`${key}: ya existe una lectura con esa marca temporal y valores distintos; se conserva la primera.`);
        continue;
      }
      state.seenReadingKeys[key] = fingerprint;
      const keyList = Object.keys(state.seenReadingKeys);
      if (keyList.length > MAX_SEEN_KEYS) for (const k of keyList.slice(0, keyList.length - MAX_SEEN_KEYS)) delete state.seenReadingKeys[k];

      const idx = state.nodes.findIndex((n) => n.id === r.nodeId);
      if (idx === -1) continue;
      const node = state.nodes[idx];
      const history = state.seriesByNode[node.id] ?? [];
      state.seriesByNode[node.id] = [...history.slice(-19), r];
      result.accepted++;

      const raw = evaluateTelemetryReading(r, node, history);
      const prevStatus = node.status;
      let anomaly: AnomalyEvent | null = null;
      if (raw) {
        anomaly = enrichAnomalyWithNetworkContext({ ...raw, origin: 'node-rule' }, state.nodes, NETWORK_PIPES);
        result.anomalies.push(anomaly);
        state.anomalies = [
          anomaly,
          ...state.anomalies.filter((a) => !(a.nodeId === node.id && a.status === 'active' && (a.origin ?? 'node-rule') === 'node-rule')),
        ];
      }
      const pending = node.pendingVerification;
      const verifies = Boolean(pending && Date.parse(r.timestamp) > Date.parse(pending.closedAt));
      const { pendingVerification: _pv, ...nodeRest } = node;
      state.nodes[idx] = { ...(verifies ? nodeRest : node), current: r, status: nodeStatusFor(node.id, anomaly) };
      if (pending && verifies) {
        // F2: la primera medición posterior al cierre es la que dice si el punto se recuperó. Queda en el ledger.
        const recovered = !anomaly;
        await append({
          action: 'POST_CLOSURE_MEASUREMENT',
          actor: 'Motor Determinista (Ingesta)',
          assetId: node.id,
          evidenceSummary: recovered
            ? `${pending.workOrderId}: primera medición posterior al cierre dentro de lo normal; recuperación medida, no supuesta.`
            : `${pending.workOrderId}: la primera medición posterior al cierre sigue fuera de lo normal (${anomaly!.title}).`,
          previousState: 'pendiente de verificación',
          newState: recovered ? 'recuperación medida' : 'anomalía persiste',
          evidenceData: { workOrderId: pending.workOrderId, closedAt: pending.closedAt, readingId: r.id, readingTimestamp: r.timestamp, recovered, synthetic: r.synthetic },
        });
      }
      if (anomaly) {
        await append({
          action: 'TELEMETRY_ANOMALY_INGESTED',
          actor: 'Motor Determinista (Ingesta)',
          assetId: node.id,
          evidenceSummary: anomaly.title,
          previousState: prevStatus,
          newState: state.nodes[idx].status,
          evidenceData: { readingId: r.id, anomalyId: anomaly.id, score: anomaly.priority.totalScore, synthetic: r.synthetic },
        });
      }
    }
    const net = await runNetworkEvaluation();
    result.anomalies.push(...net);
    return result;
  }

  // ───────────── Concordancia y diagnóstico determinista ─────────────

  function contextFor(anomaly: AnomalyEvent) {
    const vision = selectVisionForAnomaly(state.visionAnalyses, anomaly);
    const hydraulic = ctx.hydraulic ? toHydraulicEvidence(ctx.hydraulic, anomaly.nodeId) : null;
    const concordance: ConcordanceReport = evaluateConcordance({ anomaly, vision, hydraulic });
    return { vision, hydraulic, concordance };
  }

  // ───────────── SSE, salud, estado ─────────────

  // ───────────── Flujo de eventos (SSE): exige sesión, está acotado y se cierra al revocarse la sesión ─────────────

  const SSE_MAX_TOTAL = 200;
  const SSE_MAX_PER_USER = 5;
  const SSE_MAX_PER_VISITOR_KEY = 20; // los visitantes se agrupan por IP, que tras un proxy puede ser compartida
  const closeStream = (res: express.Response) => {
    sseClients.delete(res);
    sseMeta.delete(res);
    try {
      res.end();
    } catch {
      /* ya cerrado */
    }
  };
  authStore.onRevoked((ev) => {
    for (const [res, m] of [...sseMeta]) if ((ev.userId && m.userId === ev.userId) || (ev.idHash && m.idHash === ev.idHash)) closeStream(res);
  });

  app.get('/api/events', needs('state:read'), (req, res) => {
    const visitor = !req.auth;
    const userId = req.auth ? req.auth.user.id : `public:${req.clientIp}`;
    const mine = [...sseMeta.values()].filter((m) => m.userId === userId).length;
    if (sseClients.size >= SSE_MAX_TOTAL || mine >= (visitor ? SSE_MAX_PER_VISITOR_KEY : SSE_MAX_PER_USER)) {
      req.auditDenied = { reason: 'límite de conexiones de eventos' };
      res.status(429).json({ error: 'Demasiadas conexiones de eventos abiertas.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('event: connected\ndata: ' + JSON.stringify({ ok: true }) + '\n\n');
    sseClients.add(res);
    sseMeta.set(res, { userId, idHash: req.auth?.session.idHash ?? '', visitor });
    const keepAlive = setInterval(() => {
      try {
        // Si la sesión caducó o se revocó (p. ej. por otro proceso), el flujo se cierra.
        if (req.auth && !authStore.isSessionValid(req.auth.session.idHash)) return closeStream(res);
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, ssePingMs);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      sseMeta.delete(res);
    });
  });

  // Público: solo "vivo". El detalle (persistencia, integridad, política de seguridad) exige sesión con permiso.
  app.get('/api/health', (req, res) => {
    if (!req.auth || !can(req.auth.user.role, 'health:detail')) {
      // Contrato sin cambios fuera del modo público: solo "vivo" y que se exige sesión.
      res.json(publicMode ? { ok: true, authRequired: false, publicMode: true } : { ok: true, authRequired: true });
      return;
    }
    res.json({
      ok: true,
      authRequired: true,
      ...getProviderStatus(),
      persistence: { ...describePersistence(statePath), ...persistence.snapshot() },
      integrity: ctx.integrity,
      seal: { keyId: keys.keyId, keyPersistence: keys.persistence },
      security: {
        production: securityCfg.production,
        destructiveOps: 'solo ADMIN, con reautenticación, token de un solo uso, confirmación explícita y auditoría previa',
        audit: audit.status(),
        authStorage: authStore.lastWriteError ? 'error de escritura' : 'ok',
        activeSessions: authStore.activeSessionCount(),
        rateLimiter: 'memoria de un solo proceso',
      },
      ledgerCount: state.ledger.length,
      ledgerHeadHash: state.ledger[state.ledger.length - 1]?.hash ?? null,
      queuedOperations: mutex.queued,
    });
  });

  app.get('/api/state', needs('state:read'), locked((req, res) => void res.json(req.publicVisitor ? redactForVisitor(statePayload()) : statePayload())));

  app.get('/api/state/consistency', needs('state:read'), locked(async (_req, res) => {
    res.json({ integrity: await computeIntegrity(), issues: auditStateConsistency(state) });
  }));

  app.get('/api/seal/public-key', (_req, res) => {
    res.json({ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem, persistence: keys.persistence, algorithm: 'Ed25519' });
  });

  app.get('/api/ledger/anchor', needs('ledger:anchor'), locked((_req, res) => {
    const anchor = issueAnchor(keys, state.ledger);
    state.anchors = [...state.anchors, anchor].slice(-MAX_ANCHORS);
    persistAndBroadcast(false);
    res.json({ anchor, publicKeyPem: keys.publicKeyPem });
  }));

  // ───────────── Operaciones destructivas ─────────────

  async function archiveCurrentState(): Promise<{ height: number; headHash: string | null; archivedTo: string | null; anchor: SignedAnchor | null }> {
    let archivedTo: string | null = null;
    try {
      const dir = path.join(path.dirname(statePath), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(persistedShape()), 'utf8');
      archivedTo = path.relative(path.dirname(statePath), file).replace(/\\/g, '/');
    } catch (err) {
      // REQ-SEC-05: sin copia del estado anterior no se destruye nada.
      console.error('[destructivo] No se pudo archivar el estado anterior:', err instanceof Error ? err.message : '');
      throw new HttpError(507, 'Operación NO ejecutada: no se pudo conservar una copia del estado anterior (disco no disponible).');
    }
    return {
      height: state.ledger.length,
      headHash: state.ledger[state.ledger.length - 1]?.hash ?? null,
      archivedTo,
      anchor: issueAnchor(keys, state.ledger),
    };
  }

  async function replaceState(next: AppState): Promise<void> {
    state = next;
    ctx.epoch++;
    ctx.hydraulic = null;
    ctx.excessStreak = {};
    startupNotes.length = 0;
  }

  app.post('/api/reset', ...destructiveGuard(security, 'reset'), locked(async (req, res) => {
    const previous = await archiveCurrentState();
    await replaceState(await createInitialState(previous, requestedByOf(req, res)));
    ctx.integrity = await computeIntegrity();
    persistAndBroadcast(true);
    res.json({ ok: true, archivedTo: previous.archivedTo, ...statePayload() });
  }));

  // ───────────── Escenarios ─────────────

  const wantsLiveAi = (forceDeterministic: boolean) => getProviderStatus().aiMode === 'gemini-live' && !forceDeterministic;

  async function executeScenario(scenarioId: ScenarioId, opts: { forceDeterministicAi?: boolean } = {}) {
    const scenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === scenarioId);
    if (!scenario) throw new HttpError(404, 'Escenario no encontrado.');
    const nowMs = Date.now();
    const frames = buildScenarioFrames(scenarioId, nowMs);
    const live = wantsLiveAi(Boolean(opts.forceDeterministicAi));
    const fallbackReason = opts.forceDeterministicAi && getProviderStatus().aiMode === 'gemini-live' ? ('ai_disabled' as const) : ('missing_key' as const);

    for (const frame of frames) {
      const v = validateReadingBatch(frame.readings, { knownNodeIds: new Set(state.nodes.map((n) => n.id)), nowMs: nowMs + 60_000 }, { source: 'scenario-generator' });
      if ('fatal' in v) throw new HttpError(500, `El generador produjo lecturas inválidas: ${v.fatal}`);
      if (v.rejected.length > 0) throw new HttpError(500, `El generador produjo lecturas inválidas: ${v.rejected[0].errors.join(' ')}`);
      await ingestReadings(v.accepted);
    }

    const anomaly = state.anomalies.find((a) => a.nodeId === scenario.nodeId && a.status === 'active') ?? null;
    const timestamp = new Date().toISOString();
    let visionAnalysis: VisionAnalysisResult | null = null;
    let diagnosis: AquaBrainDiagnosis | null = null;
    const provisionalVisionId = `VIS-${nowMs.toString(36).toUpperCase()}`;
    const provisionalDiagId = `DIAG-${nowMs.toString(36).toUpperCase()}`;

    if (anomaly) {
      anomaly.scenarioId = scenario.id;
      state.anomalies = state.anomalies.map((a) => (a.id === anomaly.id ? anomaly : a));
      const node = state.nodes.find((n) => n.id === anomaly.nodeId)!;
      if (scenario.imageUrl && scenario.imageTitle) {
        visionAnalysis = buildFallbackVisionAnalysis(
          { node, imageUrl: scenario.imageUrl, imageTitle: scenario.imageTitle, anomaly },
          timestamp,
          { id: provisionalVisionId, provisional: live, reason: fallbackReason }
        );
        state.visionAnalyses = [visionAnalysis, ...state.visionAnalyses].slice(0, 20);
      }
      const c = contextFor(anomaly);
      diagnosis = buildFallbackDiagnosis(
        { anomaly, node, visionAnalysis: c.vision, hydraulic: c.hydraulic, concordance: c.concordance },
        timestamp,
        { id: provisionalDiagId, provisional: live, reason: fallbackReason }
      );
      state.diagnoses = [diagnosis, ...state.diagnoses];
      await append({
        action: 'DIAGNOSIS_GENERATED',
        actor: `Aqua Brain (${diagnosis.providerUsed})`,
        assetId: node.id,
        evidenceSummary: `Hipótesis: ${diagnosis.primaryHypothesis.slice(0, 120)} (Respaldo de evidencia: ${diagnosis.evidenceLevel})`,
        previousState: 'anomaly_detected',
        newState: 'diagnosis_pending_approval',
        evidenceData: { diagnosisId: diagnosis.id, evidenceLevel: diagnosis.evidenceLevel, evidenceBasis: diagnosis.evidenceBasis },
      });
      if (live) scheduleEnrichment({ epoch: ctx.epoch, anomaly, node, visionId: visionAnalysis?.id ?? null, diagId: diagnosis.id, imageUrl: scenario.imageUrl, imageTitle: scenario.imageTitle });
    }

    persistAndBroadcast(false);
    return {
      scenario,
      node: state.nodes.find((n) => n.id === scenario.nodeId),
      anomaly,
      visionAnalysis,
      diagnosis,
      aiEnrichmentStatus: live && diagnosis ? 'pending' : 'complete',
      ...statePayload(),
    };
  }

  // ───────────── Enriquecimiento con IA (fuera de la exclusión mutua, con control de época) ─────────────

  interface EnrichmentJob {
    epoch: number;
    anomaly: AnomalyEvent;
    node: NetworkNode;
    visionId: string | null;
    diagId: string;
    imageUrl?: string;
    imageTitle?: string;
  }

  /** Cierra una enriquecimiento que no terminó: nunca debe quedar "pendiente" para siempre. Idempotente. */
  async function settlePending(job: EnrichmentJob, reason: 'timeout' | 'api_error'): Promise<void> {
    await mutex.runExclusive(async () => {
      if (job.epoch !== ctx.epoch) return;
      const d = state.diagnoses.find((x) => x.id === job.diagId);
      if (!d || d.enrichmentStatus !== 'pending') return;
      const c = contextFor(job.anomaly);
      const fb = buildFallbackDiagnosis({ anomaly: job.anomaly, node: job.node, visionAnalysis: c.vision, hydraulic: c.hydraulic, concordance: c.concordance }, d.timestamp, { reason, id: d.id });
      state.diagnoses = state.diagnoses.map((x) => (x.id === d.id ? { ...fb, operatorDecision: x.operatorDecision, operatorNote: x.operatorNote } : x));
      if (job.visionId) {
        state.visionAnalyses = state.visionAnalyses.map((v) =>
          v.id === job.visionId && v.analysisStatus === 'pending'
            ? buildFallbackVisionAnalysis({ node: job.node, imageUrl: v.imageUrl, imageTitle: v.imageTitle, anomaly: job.anomaly }, v.timestamp, { reason, id: v.id })
            : v
        );
      }
      await append({
        action: 'AI_ENRICHMENT_COMPLETED',
        actor: 'Aqua Brain (adaptador de respaldo)',
        assetId: job.node.id,
        evidenceSummary: `Enriquecimiento no completado (${reason}); se conserva el diagnóstico determinista.`,
        previousState: 'diagnosis_preliminary',
        newState: 'diagnosis_deterministic_final',
        evidenceData: { diagnosisId: job.diagId, providerMode: 'fallback-adapter', enrichmentStatus: 'fallback', fallbackReason: reason },
      });
      persistAndBroadcast(true);
    });
  }

  function scheduleEnrichment(job: EnrichmentJob): void {
    const limits = getGeminiLimits();
    const watchdog = setTimeout(() => void settlePending(job, 'timeout').catch(() => undefined), limits.totalBudgetMs + 5000);
    watchdog.unref?.();
    void (async () => {
      try {
        const budget = createBudget(limits.totalBudgetMs);
        let vision: VisionAnalysisResult | null = null;
        if (job.imageUrl && job.visionId) {
          vision = await analyzeVisionEvidence(
            { node: job.node, imageUrl: job.imageUrl, imageTitle: job.imageTitle ?? 'Fotografía', anomaly: job.anomaly },
            { budget, id: job.visionId }
          );
        }
        const diagInput = await mutex.runExclusive(() => {
          if (job.epoch !== ctx.epoch) return null;
          const c = contextFor(job.anomaly);
          const effectiveVision = vision && vision.anomalyId === job.anomaly.id ? vision : c.vision;
          const concordance = evaluateConcordance({ anomaly: job.anomaly, vision: effectiveVision, hydraulic: c.hydraulic });
          return { anomaly: job.anomaly, node: job.node, visionAnalysis: effectiveVision, hydraulic: c.hydraulic, concordance };
        });
        if (!diagInput) return; // el estado cambió de época: se descarta, sin tocar el ledger nuevo
        const live = await synthesizeDiagnosis(diagInput, { budget, id: job.diagId });

        await mutex.runExclusive(async () => {
          if (job.epoch !== ctx.epoch) return;
          const current = state.diagnoses.find((d) => d.id === job.diagId);
          if (!current || current.enrichmentStatus !== 'pending') return; // ya resuelto por el vigilante
          if (vision && job.visionId) state.visionAnalyses = state.visionAnalyses.map((v) => (v.id === job.visionId ? vision! : v));
          if (vision && vision.analysisStatus === 'analyzed') await runNetworkEvaluation();
          const c = contextFor(job.anomaly);
          const merged: AquaBrainDiagnosis = {
            ...live,
            id: job.diagId,
            visionAnalysisId: c.vision?.id,
            evidenceLevel: c.concordance.level,
            evidenceBasis: c.concordance.basis,
            operatorDecision: current.operatorDecision,
            operatorNote: current.operatorNote,
          };
          state.diagnoses = state.diagnoses.map((d) => (d.id === job.diagId ? merged : d));
          await append({
            action: 'AI_ENRICHMENT_COMPLETED',
            actor: `Aqua Brain (${merged.providerUsed})`,
            assetId: job.node.id,
            evidenceSummary: `Enriquecimiento completado (${merged.enrichmentStatus ?? 'fallback'}): ${merged.primaryHypothesis.slice(0, 110)}`,
            previousState: 'diagnosis_preliminary',
            newState: 'diagnosis_enriched',
            evidenceData: {
              diagnosisId: job.diagId,
              providerMode: merged.providerMode,
              enrichmentStatus: merged.enrichmentStatus,
              fallbackReason: merged.fallbackReason,
              visionStatus: vision?.analysisStatus ?? null,
            },
          });
          persistAndBroadcast(true);
        });
      } catch (err) {
        console.warn('[ia] Error en el enriquecimiento asíncrono; se cierra con el diagnóstico determinista:', err);
        await settlePending(job, 'api_error').catch(() => undefined);
      } finally {
        clearTimeout(watchdog);
      }
    })();
  }

  app.post('/api/scenarios/:id/trigger', needs('scenario:trigger'), locked(async (req, res) => {
    const id = req.params.id as ScenarioId;
    if (!DIFFERENTIAL_SCENARIOS.some((s) => s.id === id)) throw new HttpError(404, 'Escenario no encontrado.');
    res.json(await executeScenario(id));
  }));

  // Modo demo reproducible (REQ-DEMO-01): reinicia, genera datos sintéticos con el solver y ejecuta la fuga sin servicios externos.
  app.post('/api/demo/frankenstein', ...destructiveGuard(security, 'demo'), locked(async (req, res) => {
    const previous = await archiveCurrentState();
    await replaceState(await createInitialState(previous, requestedByOf(req, res)));
    const liveAi = Boolean(req.body?.liveAi);
    await append({
      action: 'DEMO_MODE_STARTED',
      actor: actorLabel(req.auth!.user),
      assetId: 'RED-SAN-CRISTOBAL',
      evidenceSummary:
        'Modo demo reproducible: todas las lecturas son SINTÉTICAS (solver hidráulico validado contra EPANET). La IA externa está desactivada salvo que se pida lo contrario.',
      previousState: 'nominal',
      newState: 'demo_synthetic',
      evidenceData: { scenario: 'leak', synthetic: true, liveAi, requestedBy: { id: req.auth!.user.id, username: req.auth!.user.username, role: req.auth!.user.role, authenticated: true } },
    });
    const payload = await executeScenario('leak', { forceDeterministicAi: !liveAi });
    ctx.integrity = await computeIntegrity();
    res.json({ ...payload, integrity: ctx.integrity, demo: { synthetic: true, scenarioId: 'leak', liveAi } });
  }));

  // ───────────── Telemetría ─────────────

  app.post('/api/telemetry/ingest', needs('telemetry:ingest'), bigBody('/api/telemetry/ingest'), locked(async (req, res) => {
    const { csvText, readings: direct } = (req.body ?? {}) as { csvText?: unknown; readings?: unknown };
    let raws: unknown[];
    const errors: string[] = [];
    if (typeof csvText === 'string') {
      const parsed = parseCsvTelemetry(csvText);
      raws = parsed.readings;
      errors.push(...parsed.errors);
    } else if (Array.isArray(direct)) {
      raws = direct;
    } else {
      throw new HttpError(400, 'Se requiere csvText o readings.');
    }
    const v = validateReadingBatch(raws, { knownNodeIds: new Set(state.nodes.map((n) => n.id)) }, { source: typeof csvText === 'string' ? 'csv' : 'api', trustSyntheticFlag });
    if ('fatal' in v) {
      if (errors.length > 0 && raws.length === 0) {
        res.status(400).json({ error: errors.join(' '), errors, ...statePayload() });
        return;
      }
      throw new HttpError(400, v.fatal);
    }
    for (const r of v.rejected) errors.push(`Lectura ${r.index + 1}: ${r.errors.join(' ')}`);
    const result = await ingestReadings(v.accepted);
    errors.push(...result.conflicts);
    persistAndBroadcast(false);
    res.json({
      ingestedCount: result.accepted,
      duplicates: result.duplicates,
      rejected: v.rejected,
      errors,
      detectedAnomalies: result.anomalies,
      ...statePayload(),
    });
  }));

  // ───────────── Visión y diagnóstico (llamadas externas fuera de la exclusión mutua) ─────────────

  app.post('/api/ai/vision-analyze', needs('ai:use'), limitUser(security, 'ai'), limitUser(security, 'upload'), bigBody('/api/ai/vision-analyze'), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nodeId = str(body.nodeId, 60);
    if (!nodeId) throw new HttpError(400, 'Se requiere nodeId.');
    const imageTitle = str(body.imageTitle, 200) ?? 'Reporte fotográfico de campo';

    const ctxIn = await mutex.runExclusive(() => {
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node) throw new HttpError(404, 'Nodo no encontrado.');
      let anomaly: AnomalyEvent | null = null;
      const wanted = str(body.anomalyId, 120);
      if (wanted) {
        anomaly = state.anomalies.find((a) => a.id === wanted) ?? null;
        if (!anomaly) throw new HttpError(404, 'Incidente no encontrado.');
        if (anomaly.nodeId !== nodeId) throw new HttpError(409, 'El incidente pertenece a otro nodo.');
      } else {
        anomaly = state.anomalies.find((a) => a.nodeId === nodeId && a.status === 'active') ?? null;
      }
      return { node, anomaly, epoch: ctx.epoch };
    });

    let b64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined;
    let mime = typeof body.imageMimeType === 'string' ? body.imageMimeType : undefined;
    const urlIn = typeof body.imageUrl === 'string' ? body.imageUrl : '';
    if (!b64 && urlIn.startsWith('data:')) {
      const m = urlIn.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        mime = m[1];
        b64 = m[2];
      }
    }
    let imageUrl = urlIn.startsWith('data:') ? '' : urlIn.slice(0, 300);
    let validated: ReturnType<typeof validateImagePayload> = null;
    if (b64 !== undefined) {
      validated = validateImagePayload(b64, mime ?? 'image/jpeg');
      if (!validated) throw new HttpError(400, 'Imagen inválida: usa JPEG, PNG o WebP reales de hasta 6 MB.');
      let stored;
      try {
        stored = saveEvidence(validated.base64, validated.mimeType, evidenceDir);
      } catch {
        throw new HttpError(507, 'No se pudo almacenar la fotografía en el servidor.');
      }
      imageUrl = `/api/evidence/${stored.sha256}`;
    }

    const analysis = await analyzeVisionEvidence({
      node: ctxIn.node,
      imageUrl,
      imageTitle,
      imageBase64: validated?.base64,
      imageMimeType: validated?.mimeType,
      anomaly: ctxIn.anomaly,
    });

    await mutex.runExclusive(async () => {
      if (ctxIn.epoch !== ctx.epoch) throw new HttpError(409, 'El estado cambió mientras se analizaba la imagen; repite la operación.');
      state.visionAnalyses = [analysis, ...state.visionAnalyses].slice(0, 20);
      await append({
        action: 'VISION_EVIDENCE_ANALYZED',
        actor: analysis.providerUsed,
        assetId: ctxIn.node.id,
        evidenceSummary: `${analysis.imageTitle} — ${analysis.analysisStatus === 'analyzed' ? `categoría visual ${analysis.visualCategory} (${analysis.evidenceRole})` : 'no analizada'}`,
        previousState: 'evidence_uploaded',
        newState: analysis.analysisStatus === 'analyzed' ? 'vision_correlated' : 'vision_not_analyzed',
        evidenceData: { visionId: analysis.id, anomalyId: analysis.anomalyId ?? null, analysisStatus: analysis.analysisStatus, evidenceRole: analysis.evidenceRole, imageUrl },
      });
      if (analysis.analysisStatus === 'analyzed') await runNetworkEvaluation();
      persistAndBroadcast(false);
      res.json({ analysis, linked: Boolean(analysis.anomalyId), ...statePayload() });
    });
  });

  app.post('/api/ai/diagnose', needs('ai:use'), limitUser(security, 'ai'), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anomalyId = str(body.anomalyId, 120);
    if (!anomalyId) throw new HttpError(400, 'Se requiere anomalyId.');
    const requestedVision = str(body.visionAnalysisId, 120);

    const input = await mutex.runExclusive(() => {
      const anomaly = state.anomalies.find((a) => a.id === anomalyId);
      if (!anomaly) throw new HttpError(404, 'Anomalía no encontrada.');
      const node = state.nodes.find((n) => n.id === anomaly.nodeId)!;
      const c = contextFor(anomaly);
      if (requestedVision && c.vision?.id !== requestedVision) {
        throw new HttpError(409, 'La fotografía indicada no está vinculada a este incidente (pertenece a otro o es anterior): no se usa como evidencia.');
      }
      return { anomaly, node, visionAnalysis: c.vision, hydraulic: c.hydraulic, concordance: c.concordance, epoch: ctx.epoch };
    });

    const diagnosis = await synthesizeDiagnosis(input);

    await mutex.runExclusive(async () => {
      if (input.epoch !== ctx.epoch) throw new HttpError(409, 'El estado cambió mientras se generaba el diagnóstico; repite la operación.');
      state.diagnoses = [diagnosis, ...state.diagnoses];
      await append({
        action: 'AQUA_BRAIN_DIAGNOSIS',
        actor: `Aqua Brain (${diagnosis.providerUsed})`,
        assetId: input.node.id,
        evidenceSummary: diagnosis.primaryHypothesis,
        previousState: 'anomaly_active',
        newState: 'diagnosis_pending_approval',
        evidenceData: { diagnosisId: diagnosis.id, score: diagnosis.priorityScore, evidenceLevel: diagnosis.evidenceLevel, providerMode: diagnosis.providerMode },
      });
      persistAndBroadcast(false);
      res.json({ diagnosis, ...statePayload() });
    });
  });

  app.get('/api/anomalies/:id/forensics', needs('state:read'), locked((req, res) => {
    const anomaly = state.anomalies.find((a) => a.id === req.params.id);
    if (!anomaly) throw new HttpError(404, 'Anomalía no encontrada.');
    const diag = diagnoseHydraulics(state.nodes, NETWORK_PIPES, { streak: ctx.excessStreak, requiredConsecutive: REQUIRED_CONSECUTIVE, confirmingPhotoNodeIds: confirmingPhotoNodes() });
    const c = contextFor(anomaly);
    res.json({ hydraulic: diag, forensics: diag, concordance: c.concordance, vision: c.vision });
  }));

  // ───────────── Decisiones y órdenes de trabajo ─────────────

  app.post('/api/diagnoses/:id/decision', needs('diagnosis:decide'), locked(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;
    if (decision !== 'accepted' && decision !== 'modified' && decision !== 'rejected') throw new HttpError(400, 'decision debe ser accepted, modified o rejected.');
    const priorities = ['Crítica', 'Alta', 'Media', 'Baja'];
    if (body.modifiedPriority !== undefined && !priorities.includes(body.modifiedPriority as string)) throw new HttpError(400, 'modifiedPriority inválida.');
    const operatorNote = str(body.operatorNote, 1000);
    const modifiedAction = str(body.modifiedAction, 1000);
    const assignee = body.assignee === undefined ? 'Brigada Hídrica Sectorial A' : normalizeAssignee(body.assignee);

    const idx = state.diagnoses.findIndex((d) => d.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Diagnóstico no encontrado.');
    const current = state.diagnoses[idx];
    if (current.operatorDecision !== 'pending') throw new HttpError(409, `El diagnóstico ya tiene una decisión registrada (${current.operatorDecision}).`);

    const updatedDiagnosis: AquaBrainDiagnosis = {
      ...current,
      operatorDecision: decision,
      operatorNote,
      recommendedAction: modifiedAction || current.recommendedAction,
      priority: (body.modifiedPriority as AquaBrainDiagnosis['priority']) || current.priority,
    };
    state.diagnoses[idx] = updatedDiagnosis;

    let createdOrder: SmartWorkOrder | null = null;
    if (decision === 'accepted' || decision === 'modified') {
      const node = state.nodes.find((n) => n.id === current.nodeId);
      const orderNumber = String(state.workOrders.length + 1).padStart(3, '0');
      const now = new Date().toISOString();
      createdOrder = {
        id: `OT-2026-${orderNumber}`,
        diagnosisId: updatedDiagnosis.id,
        anomalyId: updatedDiagnosis.anomalyId,
        createdAt: now,
        updatedAt: now,
        location: `${updatedDiagnosis.nodeName} · ${node?.sector ?? 'Red Comunitaria'}`,
        nodeId: updatedDiagnosis.nodeId,
        assetName: node ? `${node.assetCode} (${node.material} ${node.diameterMm} mm)` : updatedDiagnosis.nodeId,
        evidenceSummary: updatedDiagnosis.availableEvidences,
        probableCause: updatedDiagnosis.primaryHypothesis,
        priority: updatedDiagnosis.priority,
        requiredResources: updatedDiagnosis.requiredResources,
        interventionSteps: updatedDiagnosis.interventionSteps,
        assignee,
        status: 'Abierta',
        checklist: buildChecklist(updatedDiagnosis.interventionSteps),
      };
      const entry = await append(asUser(req, {
        action: 'WORK_ORDER_ISSUED',
        assetId: createdOrder.nodeId,
        evidenceSummary: `${createdOrder.id} emitida [${createdOrder.priority}]: ${updatedDiagnosis.recommendedAction}`,
        previousState: 'diagnosis_pending_approval',
        newState: 'Abierta',
        evidenceData: { workOrderId: createdOrder.id, diagnosisId: updatedDiagnosis.id, decision, operatorNote, assignee },
      }));
      createdOrder.ledgerHash = entry.hash;
      state.workOrders = [createdOrder, ...state.workOrders];
    } else {
      await append(asUser(req, {
        action: 'DIAGNOSIS_REJECTED',
        assetId: updatedDiagnosis.nodeId,
        evidenceSummary: `Recomendación rechazada. Motivo: ${operatorNote || 'Descartada por operador'}`,
        previousState: 'diagnosis_pending_approval',
        newState: 'rejected',
        evidenceData: { diagnosisId: updatedDiagnosis.id, operatorNote },
      }));
    }
    persistAndBroadcast(false);
    res.json({ diagnosis: updatedDiagnosis, createdOrder, ...statePayload() });
  }));

  const orderIdx = (id: string) => {
    const i = state.workOrders.findIndex((w) => w.id === id);
    if (i === -1) throw new WorkOrderError('Orden de trabajo no encontrada.', 404);
    return i;
  };

  app.patch('/api/work-orders/:id', needs('order:write'), locked(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status as WorkOrderStatus;
    if (status !== 'En Progreso' && status !== 'Cerrada') throw new WorkOrderError('Estado inválido: solo "En Progreso" o "Cerrada".', 400);
    const closureNotes = str(body.closureNotes, 2000);
    const idx = orderIdx(req.params.id);
    const existing = ensureChecklist(state.workOrders[idx]);
    if (existing.status === 'Cerrada') throw new WorkOrderError('La orden ya está cerrada y sellada en el ledger.', 409);
    if (existing.status === status) throw new WorkOrderError(`La orden ya está en "${status}".`, 409);
    if (status === 'Cerrada') {
      const blockers = closureBlockers(existing);
      if (blockers.length > 0) {
        res.status(409).json({ error: `No se puede cerrar la orden: ${blockers.join(' ')}`, blockers });
        return;
      }
    }

    const now = new Date().toISOString();
    const updated: SmartWorkOrder = {
      ...existing,
      status,
      updatedAt: now,
      closureNotes: closureNotes ?? existing.closureNotes,
      closureEvidenceLabel: str(body.closureEvidenceLabel, 300) ?? existing.closureEvidenceLabel,
    };

    if (status !== 'Cerrada') {
      await append(asUser(req, {
        action: 'WORK_ORDER_UPDATED',
        assetId: existing.nodeId,
        evidenceSummary: `${existing.id} cambió a ${status}`,
        previousState: existing.status,
        newState: status,
        evidenceData: { workOrderId: existing.id, status },
      }));
      state.workOrders[idx] = updated;
      persistAndBroadcast(false);
      res.json({ workOrder: updated, ...statePayload() });
      return;
    }

    // Cierre: se congela el expediente COMPLETO antes de restaurar el nodo (REQ-LED-03).
    const anomaly = state.anomalies.find((a) => a.id === existing.anomalyId) ?? null;
    const diagnosis = state.diagnoses.find((d) => d.id === existing.diagnosisId) ?? null;
    const c = anomaly ? contextFor(anomaly) : { vision: null, hydraulic: null, concordance: null };
    const { seal: _s, ledgerHash: _h, ...orderCore } = updated;
    const sealed: SealedContent = {
      version: 1,
      order: orderCore,
      anomaly,
      telemetry: anomaly ? { nodeId: anomaly.nodeId, window: [...(state.seriesByNode[anomaly.nodeId] ?? [])], baseline: state.nodes.find((n) => n.id === anomaly.nodeId)!.baseline } : null,
      networkSnapshot: {
        nodes: state.nodes.map((n) => ({ id: n.id, kind: n.kind, status: n.status, current: n.current, baseline: n.baseline })),
        pipes: NETWORK_PIPES,
      },
      diagnosis,
      vision: c.vision,
      hydraulic: ctx.hydraulic,
      concordance: c.concordance,
      evidence: existing.closureEvidence
        ? { sha256: existing.closureEvidence.sha256, mimeType: existing.closureEvidence.mimeType, sizeBytes: existing.closureEvidence.sizeBytes }
        : null,
    };
    const digests = await prepareSeal(sealed);
    const closedEntry = await append(asUser(req, {
      action: 'WORK_ORDER_CLOSED',
      assetId: existing.nodeId,
      evidenceSummary: `${existing.id} cerrada con checklist completo y foto sha256:${existing.closureEvidence?.sha256.slice(0, 12)}…; expediente sellado sha256:${digests.dossierDigest.slice(0, 12)}…: ${closureNotes || 'Verificación en campo completada'}`,
      previousState: existing.status,
      newState: 'Cerrada',
      evidenceData: {
        workOrderId: existing.id,
        closureNotes,
        closureEvidenceLabel: updated.closureEvidenceLabel,
        dossierDigest: digests.dossierDigest,
        componentDigests: digests.componentDigests,
        sealVersion: 1,
      },
    }));
    updated.seal = finalizeSeal(keys, existing.id, digests, closedEntry);
    updated.ledgerHash = closedEntry.hash;
    state.sealedDossiers[existing.id] = sealed;
    state.workOrders[idx] = updated;
    pushAnchor();

    state.anomalies = state.anomalies.map((a) => (a.id === existing.anomalyId ? { ...a, status: 'resolved' } : a));
    const nodeIdx = state.nodes.findIndex((n) => n.id === existing.nodeId);
    if (nodeIdx !== -1) {
      // F2 corregido: cerrar NO escribe ninguna lectura ni declara el punto estable. Queda pendiente de verificación
      // hasta que llegue una medición posterior al cierre (ver ingestReadings).
      const node = state.nodes[nodeIdx];
      state.nodes[nodeIdx] = { ...node, pendingVerification: { workOrderId: existing.id, closedAt: now } };
      ctx.excessStreak[node.id] = 0;
    }
    persistAndBroadcast(false);
    res.json({ workOrder: updated, ...statePayload() });
  }));

  app.patch('/api/work-orders/:id/assignee', needs('order:write'), locked(async (req, res) => {
    const idx = orderIdx(req.params.id);
    const existing = ensureChecklist(state.workOrders[idx]);
    if (existing.status === 'Cerrada') throw new WorkOrderError('La orden está cerrada.', 409);
    const assignee = normalizeAssignee(req.body?.assignee);
    if (assignee === existing.assignee) {
      res.json({ workOrder: existing, ...statePayload() });
      return;
    }
    const updated: SmartWorkOrder = { ...existing, assignee, updatedAt: new Date().toISOString() };
    await append(asUser(req, {
      action: 'WORK_ORDER_ASSIGNED',
      assetId: existing.nodeId,
      evidenceSummary: `${existing.id}: responsable ${existing.assignee} → ${assignee}`,
      previousState: existing.assignee,
      newState: assignee,
      evidenceData: { workOrderId: existing.id, from: existing.assignee, to: assignee },
    }));
    state.workOrders[idx] = updated;
    persistAndBroadcast(false);
    res.json({ workOrder: updated, ...statePayload() });
  }));

  app.patch('/api/work-orders/:id/checklist/:itemId', needs('order:write'), locked(async (req, res) => {
    const idx = orderIdx(req.params.id);
    if (typeof req.body?.done !== 'boolean') throw new WorkOrderError('Se requiere "done" booleano.', 400);
    const existing = ensureChecklist(state.workOrders[idx]);
    const { order: updated, item } = setChecklistItem(existing, req.params.itemId, req.body.done, actorLabel(req.auth!.user), new Date().toISOString());
    await append(asUser(req, {
      action: item.done ? 'CHECKLIST_ITEM_COMPLETED' : 'CHECKLIST_ITEM_REOPENED',
      assetId: existing.nodeId,
      evidenceSummary: `${existing.id} · ${item.id}: ${item.label}`,
      previousState: item.done ? 'pendiente' : 'completado',
      newState: item.done ? 'completado' : 'pendiente',
      evidenceData: { workOrderId: existing.id, itemId: item.id, label: item.label, done: item.done },
    }));
    state.workOrders[idx] = updated;
    persistAndBroadcast(false);
    res.json({ workOrder: updated, ...statePayload() });
  }));

  app.post('/api/work-orders/:id/evidence', needs('order:evidence'), limitUser(security, 'upload'), bigBody('/api/work-orders/x/evidence'), locked(async (req, res) => {
    const idx = orderIdx(req.params.id);
    const existing = ensureChecklist(state.workOrders[idx]);
    if (existing.status === 'Cerrada') throw new WorkOrderError('La orden está cerrada; no se puede reemplazar la evidencia.', 409);
    const parsed = parseEvidenceDataUrl(req.body?.dataUrl);
    const image = validateImagePayload(parsed.base64, parsed.mimeType);
    if (!image) throw new WorkOrderError('La imagen no es un JPEG, PNG o WebP válido (la firma del archivo no coincide).', 400);
    const fileName = sanitizeFileName(req.body?.fileName);
    let stored;
    try {
      stored = saveEvidence(image.base64, image.mimeType, evidenceDir);
    } catch {
      throw new HttpError(507, 'No se pudo almacenar la fotografía en el servidor (disco no disponible). La acción no se aplicó.');
    }
    const now = new Date().toISOString();
    const updated = attachEvidence(
      existing,
      { fileName, mimeType: image.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, attachedAt: now, attachedBy: actorLabel(req.auth!.user) },
      now
    );
    await append(asUser(req, {
      action: 'CLOSURE_EVIDENCE_ATTACHED',
      assetId: existing.nodeId,
      evidenceSummary: `${existing.id}: foto de cierre ${fileName} (${stored.sizeBytes} B) sha256:${stored.sha256.slice(0, 16)}… (solo se sella el hash: el contenido de la foto no se analiza)`,
      previousState: existing.closureEvidence ? 'evidencia_previa' : 'sin_evidencia',
      newState: 'evidencia_adjunta',
      evidenceData: { workOrderId: existing.id, sha256: stored.sha256, mimeType: image.mimeType, sizeBytes: stored.sizeBytes },
    }));
    state.workOrders[idx] = updated;
    persistAndBroadcast(false);
    res.json({ workOrder: updated, ...statePayload() });
  }));

  app.get('/api/evidence/:sha256', needs('evidence:read'), (req, res) => {
    const found = readEvidence(req.params.sha256, evidenceDir);
    if (!found) throw new HttpError(404, 'Evidencia no encontrada.');
    if (!found.verified) throw new HttpError(422, 'El archivo almacenado no coincide con su SHA-256 (posible alteración).');
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(found.buffer);
  });

  // ───────────── Expediente sellado ─────────────

  async function buildVerifiedDossier(orderId: string) {
    const order = state.workOrders.find((w) => w.id === orderId);
    if (!order) throw new HttpError(404, 'Orden de trabajo no encontrada.');
    if (order.status !== 'Cerrada') throw new HttpError(409, 'El expediente se sella al cerrar la orden: esta orden aún no está cerrada.');
    const sealedContent = state.sealedDossiers[orderId];
    if (!order.seal || !sealedContent) {
      throw new HttpError(409, 'Esta orden se cerró antes de existir el sello de expediente completo (REQ-LED-03); no hay expediente verificable que exportar.');
    }
    let evidencePhoto: { sha256: string; mimeType: string; base64: string } | null = null;
    if (sealedContent.evidence) {
      const file = readEvidence(sealedContent.evidence.sha256, evidenceDir);
      if (file?.verified) evidencePhoto = { sha256: sealedContent.evidence.sha256, mimeType: file.mimeType, base64: file.buffer.toString('base64') };
    }
    const dossier = exportDossier({ keys, sealed: sealedContent, seal: order.seal, ledger: state.ledger, evidencePhoto });
    const verification = await verifyDossierFull(dossier, { trustedPublicKeyPem: keys.publicKeyPem });
    return { dossier, verification };
  }

  app.get('/api/work-orders/:id/dossier', needs('dossier:export'), locked(async (req, res) => {
    const { dossier, verification } = await buildVerifiedDossier(req.params.id);
    if (verification.overall !== 'verified') {
      ctx.integrity = { status: 'compromised', issues: [`El expediente de ${req.params.id} no supera la verificación en el servidor.`], checkedAt: new Date().toISOString() };
      res.status(500).json({ error: 'El expediente guardado en el servidor no supera su propia verificación: posible alteración del estado.', verification });
      return;
    }
    pushAnchor();
    persistAndBroadcast(false);
    res.setHeader('Content-Disposition', `attachment; filename="dossier-${req.params.id}.json"`);
    res.json(dossier);
  }));

  app.get('/api/work-orders/:id/dossier/verify', needs('dossier:verify'), locked(async (req, res) => {
    const { verification } = await buildVerifiedDossier(req.params.id);
    res.json({ verification, keyId: keys.keyId });
  }));

  app.post('/api/dossier/verify', needs('dossier:verify'), bigBody('/api/dossier/verify'), async (req, res) => {
    const body = (req.body ?? {}) as { dossier?: never; trustedPublicKeyPem?: string; trustedKeyId?: string; useServerKey?: boolean };
    if (!body.dossier || typeof body.dossier !== 'object') throw new HttpError(400, 'Se requiere el expediente en "dossier".');
    const verification = await verifyDossierFull(body.dossier, {
      trustedPublicKeyPem: body.useServerKey ? keys.publicKeyPem : typeof body.trustedPublicKeyPem === 'string' ? body.trustedPublicKeyPem : undefined,
      trustedKeyId: typeof body.trustedKeyId === 'string' ? body.trustedKeyId : undefined,
    });
    res.json({ verification });
  });

  app.post('/api/ledger/verify', needs('dossier:verify'), bigBody('/api/ledger/verify'), async (req, res) => {
    const chain = Array.isArray(req.body?.ledger) ? (req.body.ledger as TrustLedgerEntry[]) : state.ledger;
    res.json(await verifyLedgerChain(chain));
  });

  // ───────────── Sincronización offline ─────────────

  app.post('/api/sync/offline', needs('offline:sync'), limitUser(security, 'upload'), bigBody('/api/sync/offline'), async (req, res) => {
    const reports = req.body?.reports;
    if (!Array.isArray(reports)) throw new HttpError(400, 'Se requiere la lista "reports".');
    if (reports.length > 100) throw new HttpError(400, 'Máximo 100 reportes por sincronización.');

    interface Clean {
      raw: OfflineReportRecord;
      id: string;
      key: string;
      nodeId: string;
      category: AnomalyCategory;
      description: string;
      reporter: string;
      photo?: NonNullable<ReturnType<typeof validateImagePayload>>;
    }
    const cleaned: Array<Clean | { id: string; error: string }> = reports.map((r: Record<string, unknown>) => {
      const id = str(r?.id, 120) ?? 'sin-id';
      const key = str(r?.idempotencyKey, 200);
      const nodeId = str(r?.nodeId, 60);
      const description = str(r?.description, 2000);
      const reporter = str(r?.reporterName, 120) ?? 'Anónimo';
      const category = r?.category as AnomalyCategory;
      if (!key || !nodeId || !description) return { id, error: 'Reporte incompleto (idempotencyKey, nodeId y description son obligatorios).' };
      if (!REPORT_CATEGORIES.includes(category)) return { id, error: `Categoría inválida: debe ser una de ${REPORT_CATEGORIES.join(', ')}.` };
      let photo: Clean['photo'];
      if (typeof r.photoDataUrl === 'string' && r.photoDataUrl.length > 0) {
        const m = r.photoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        photo = (m && validateImagePayload(m[2], m[1])) || undefined;
        if (!photo) return { id, error: 'La fotografía adjunta no es una imagen JPEG, PNG o WebP válida.' };
      }
      return { raw: r as unknown as OfflineReportRecord, id, key, nodeId, category, description, reporter, photo };
    });

    // Fase sin exclusión: análisis de fotografías (pueden tardar). La anomalía se identifica de forma determinista.
    const budget = createBudget(getGeminiLimits().totalBudgetMs);
    const visions = new Map<string, VisionAnalysisResult>();
    const knownNodes = await mutex.runExclusive(() => ({ nodes: [...state.nodes], epoch: ctx.epoch }));
    for (const c of cleaned) {
      if ('error' in c || !c.photo) continue;
      const node = knownNodes.nodes.find((n) => n.id === c.nodeId);
      if (!node) continue;
      let imageUrl = '';
      try {
        imageUrl = `/api/evidence/${saveEvidence(c.photo.base64, c.photo.mimeType, evidenceDir).sha256}`;
      } catch {
        imageUrl = '';
      }
      const anomalyId = `ANOM-OFF-${c.id}`;
      visions.set(
        c.id,
        await analyzeVisionEvidence(
          { node, imageUrl, imageTitle: `Reporte Offline — ${c.reporter}`, imageBase64: c.photo.base64, imageMimeType: c.photo.mimeType, anomaly: { id: anomalyId, category: c.category, nodeId: node.id, timestamp: new Date().toISOString() } },
          { budget }
        )
      );
    }

    await mutex.runExclusive(async () => {
      if (knownNodes.epoch !== ctx.epoch) throw new HttpError(409, 'El estado cambió durante la sincronización; repite la operación.');
      const results: Array<{ id: string; status: 'synced' | 'duplicate' | 'conflict'; note: string; anomalyId?: string; diagnosisId?: string }> = [];
      const now = Date.now();
      for (const c of cleaned) {
        if ('error' in c) {
          results.push({ id: c.id, status: 'conflict', note: c.error });
          continue;
        }
        if (state.syncedOfflineKeys.has(c.key)) {
          results.push({ id: c.id, status: 'duplicate', note: 'Registro deduplicado por clave idempotente; ya existía en servidor.' });
          continue;
        }
        const nodeIdx = state.nodes.findIndex((n) => n.id === c.nodeId);
        if (nodeIdx === -1) {
          results.push({ id: c.id, status: 'conflict', note: `Nodo desconocido: ${c.nodeId}.` });
          continue;
        }
        state.syncedOfflineKeys.add(c.key);
        const node = state.nodes[nodeIdx];
        const cls = classifyOfflineReport({ nodeId: c.nodeId, createdAt: c.raw.createdAt }, state.workOrders, now);
        const vision = visions.get(c.id) ?? null;
        if (vision) state.visionAnalyses = [{ ...vision, anomalyId: `ANOM-OFF-${c.id}` }, ...state.visionAnalyses].slice(0, 20);

        const severityBase = c.category === 'contamination' ? 78 : c.category === 'leak' ? 74 : c.category === 'obstruction' ? 62 : 55;
        const priority = computeRiskPriorityScore({ category: c.category, maxRuleSeverity: severityBase, populationServed: node.populationServed, ruleCount: vision?.analysisStatus === 'analyzed' ? 2 : 1 });
        const anomaly: AnomalyEvent = {
          id: `ANOM-OFF-${c.id}`,
          timestamp: cls.effectiveCreatedAt,
          nodeId: node.id,
          nodeName: node.name,
          sector: node.sector,
          category: c.category,
          title: `Reporte offline sincronizado (${c.reporter}): ${c.description.slice(0, 80)}`,
          status: cls.status === 'active' ? 'active' : 'resolved',
          rulesTriggered: [
            {
              ruleId: 'FIELD_REPORT_DECLARED', // F1: un reporte de campo no es una regla sobre sensores
              title: `Observación de campo sincronizada (${c.reporter})`,
              category: c.category,
              severityScore: severityBase,
              metric: 'fieldReport',
              observedValue: 1,
              baselineValue: 0,
              deltaPct: 100,
              explanation: `Reporte en sitio capturado sin conexión (declarado por el reportante, no verificado): "${c.description}"`,
            },
          ],
          priority,
          telemetrySnapshot: node.current,
          baselineSnapshot: node.baseline,
          synthetic: false,
          origin: 'offline-report',
        };
        state.anomalies = [anomaly, ...state.anomalies];
        if (cls.status === 'active') state.nodes[nodeIdx] = { ...node, status: nodeStatusFor(node.id, anomaly) };

        const base = buildFallbackDiagnosis({ anomaly, node: state.nodes[nodeIdx], visionAnalysis: vision && vision.anomalyId === anomaly.id ? vision : null, hydraulic: null, concordance: evaluateConcordance({ anomaly, vision: vision ? { ...vision, anomalyId: anomaly.id } : null, hydraulic: null }) });
        const diag: AquaBrainDiagnosis = {
          ...base,
          detectedProblem: `Incidencia de campo offline en ${node.name}: ${c.description.slice(0, 200)}`,
          availableEvidences: [`Reporte offline (${c.reporter}) · clave ${c.key} · declarado, sin verificar`, ...base.availableEvidences],
          providerUsed: 'Aqua Brain (Correlación de Reporte Offline)',
        };
        state.diagnoses = [diag, ...state.diagnoses];

        await append(asUser(req, {
          action: 'OFFLINE_REPORT_SYNCED',
          assetId: c.nodeId,
          evidenceSummary: `${c.description.slice(0, 200)} (${cls.note})`,
          previousState: 'offline_pending',
          newState: cls.status === 'active' ? 'synced_to_brain' : 'synced_with_conflict_review',
          evidenceData: { reportId: c.id, idempotencyKey: c.key, anomalyId: anomaly.id, diagnosisId: diag.id, classification: cls.status, conflictOrderId: cls.conflictOrderId ?? null, declaredReporter: c.reporter, reporterDeclaredUnverified: true },
        }));
        results.push({ id: c.id, status: cls.status === 'active' ? 'synced' : 'conflict', note: cls.note, anomalyId: anomaly.id, diagnosisId: diag.id });
      }
      persistAndBroadcast(true);
      res.json({ results, ...statePayload() });
    });
  });

  // ───────────── Snapshot ─────────────

  app.get('/api/state/export', needs('snapshot:export'), limitUser(security, 'admin'), locked((_req, res) => {
    const snapshot = buildSnapshot({ version: 2, savedAt: new Date().toISOString(), ...persistedShape() }, evidenceDir);
    res.setHeader('Content-Disposition', 'attachment; filename="aqua-sentinel-snapshot.json"');
    res.json(snapshot);
  }));

  app.post('/api/state/import', ...destructiveGuard(security, 'import'), bigBody('/api/state/import'), locked(async (req, res) => {
    const result = await validateSnapshot(req.body, {
      verifyAnchor: (a) => a.payload.keyId === keys.keyId && verifyAnchorSignature(keys.publicKeyPem, a),
      currentAnchors: state.anchors.filter((a) => a.payload.keyId === keys.keyId),
      acceptRollback: req.query.acceptRollback === '1',
    });
    if (!result.ok) {
      res.status(422).json({ error: 'Snapshot rechazado.', errors: result.errors });
      return;
    }
    const s = result.snapshot.state;
    try {
      restoreEvidence(result.snapshot, evidenceDir);
    } catch {
      throw new HttpError(507, 'No se pudieron restaurar las fotografías del snapshot (disco no disponible).');
    }
    const previous = await archiveCurrentState();
    const repaired = repairTelemetryState(s.nodes, s.seriesByNode, createBaselineNodes());
    await replaceState({
      nodes: repaired.nodes,
      seriesByNode: repaired.seriesByNode,
      anomalies: s.anomalies,
      visionAnalyses: s.visionAnalyses,
      diagnoses: s.diagnoses,
      workOrders: s.workOrders.map(ensureChecklist),
      ledger: s.ledger,
      syncedOfflineKeys: new Set(s.syncedOfflineKeys),
      sealedDossiers: (s.sealedDossiers ?? {}) as Record<string, SealedContent>,
      anchors: s.anchors ?? [],
      seenReadingKeys: s.seenReadingKeys ?? {},
    });
    await append(asUser(req, {
      action: 'STATE_RESTORED_FROM_SNAPSHOT',
      assetId: 'RED-SAN-CRISTOBAL',
      evidenceSummary: `Estado restaurado desde un snapshot exportado el ${result.snapshot.exportedAt}; cadena, coherencia y sellos verificados antes de aceptar (${s.ledger.length} bloques).`,
      previousState: 'estado_previo',
      newState: 'restaurado',
      evidenceData: { exportedAt: result.snapshot.exportedAt, ledgerBlocks: s.ledger.length, replacedChainHead: previous.headHash, replacedChainHeight: previous.height, repairs: repaired.repairs },
    }));
    pushAnchor();
    ctx.integrity = await computeIntegrity();
    persistAndBroadcast(true);
    res.json({ ok: true, warnings: result.warnings, archivedTo: previous.archivedTo, ...statePayload() });
  }));

  // ───────────── IA: sonda y repositorio Kiro ─────────────

  app.post('/api/ai/probe', needs('ai:probe'), limitUser(security, 'ai-probe'), async (_req, res) => {
    res.json(await probeGemini());
  });

  app.get('/api/kiro/files', needs('kiro:read'), (_req, res) => {
    const kiroRoot = path.resolve(process.cwd(), '.kiro');
    const files: Array<{ path: string; category: string; content: string }> = [];
    const walk = (dir: string, category: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full, entry);
        else files.push({ path: `.kiro/${path.relative(kiroRoot, full).replace(/\\/g, '/')}`, category, content: fs.readFileSync(full, 'utf8') });
      }
    };
    walk(kiroRoot, 'root');
    res.json({ files });
  });

  app.use('/api', (_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Ruta de API no encontrada.')));
  app.use(errorMiddleware);

  persistAndBroadcast(false);

  return {
    app,
    shutdown() {
      for (const c of sseClients) {
        try {
          c.end();
        } catch {
          /* cliente ya cerrado */
        }
      }
      sseClients.clear();
    },
    inspect: () => ({ epoch: ctx.epoch, integrity: ctx.integrity }),
    publicMode,
    authStore,
    audit,
    setupCode,
  };
}
