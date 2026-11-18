import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  createBaselineNodes,
  DIFFERENTIAL_SCENARIOS,
  generateBaselineSeries,
  NETWORK_PIPES,
} from './src/core/networkData';
import {
  computeRiskPriorityScore,
  evaluateTelemetryReading,
  parseCsvTelemetry,
} from './src/core/deterministicEngine';
import { enrichAnomalyWithNetworkContext } from './src/core/graphHydrology';
import { appendLedgerEntry, verifyLedgerChain } from './src/core/cryptoLedger';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  OfflineReportRecord,
  ScenarioId,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
  WorkOrderStatus,
} from './src/core/types';
import {
  analyzeVisionEvidence,
  buildFallbackDiagnosis,
  buildFallbackVisionAnalysis,
  getProviderStatus,
  probeGemini,
  synthesizeDiagnosis,
} from './src/server/aiProvider';
import { DEFAULT_STATE_PATH, loadPersistedState, savePersistedState } from './src/server/persistence';
import { readEvidence, saveEvidence } from './src/server/evidenceStore';
import { buildSnapshot, describePersistence, restoreEvidence, validateSnapshot } from './src/server/snapshot';
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
} from './src/core/workOrders';
import { buildDossier, orderDigest } from './src/core/dossier';
import { evaluateConcordance } from './src/core/evidenceConcordance';
import { localizeLeak, upstreamFlowConsequences } from './src/core/leakForensics';

interface AppStateStore {
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  anomalies: AnomalyEvent[];
  visionAnalyses: VisionAnalysisResult[];
  diagnoses: AquaBrainDiagnosis[];
  workOrders: SmartWorkOrder[];
  ledger: TrustLedgerEntry[];
  syncedOfflineKeys: Set<string>;
}

async function createInitialState(): Promise<AppStateStore> {
  const nodes = createBaselineNodes();
  const seriesByNode: Record<string, TelemetryReading[]> = {};
  for (const node of nodes) {
    seriesByNode[node.id] = generateBaselineSeries(node, 14);
  }

  let ledger: TrustLedgerEntry[] = [];
  ledger = await appendLedgerEntry(ledger, {
    action: 'NETWORK_INITIALIZED',
    actor: 'Sistema Aqua Sentinel',
    assetId: 'RED-SAN-CRISTOBAL',
    evidenceSummary:
      'Inicialización de red comunitaria sintética (7 nodos hidráulicos) con línea base nominal.',
    previousState: 'uninitialized',
    newState: 'nominal',
    evidenceData: { nodeCount: nodes.length, synthetic: true },
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
  };
}

function healthFromCategory(category: AnomalyEvent['category']): NetworkNode['status'] {
  if (category === 'contamination' || category === 'leak') return 'critical';
  if (category === 'obstruction' || category === 'quality_drift') return 'warning';
  if (category === 'sensor_fault') return 'fault';
  return 'nominal';
}

async function bootstrapServer() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  const persisted = loadPersistedState();
  let state: AppStateStore = persisted
    ? {
        nodes: persisted.nodes,
        seriesByNode: persisted.seriesByNode,
        anomalies: persisted.anomalies,
        visionAnalyses: persisted.visionAnalyses,
        diagnoses: persisted.diagnoses,
        workOrders: persisted.workOrders.map(ensureChecklist),
        ledger: persisted.ledger,
        syncedOfflineKeys: new Set<string>(persisted.syncedOfflineKeys),
      }
    : await createInitialState();

  if (!persisted) {
    savePersistedState(state);
  }

  // Los anexos al ledger se serializan: sin esto, dos peticiones concurrentes (p. ej. enriquecimiento IA + acción del operador)
  // leerían la misma cabeza de cadena y una entrada sobrescribiría a la otra.
  let ledgerQueue: Promise<unknown> = Promise.resolve();
  type LedgerPayload = Parameters<typeof appendLedgerEntry>[1];
  const appendToLedger = (payload: LedgerPayload): Promise<void> => {
    const run = ledgerQueue.then(async () => {
      state.ledger = await appendLedgerEntry(state.ledger, payload);
    });
    ledgerQueue = run.catch(() => undefined);
    return run;
  };
  const sseClients = new Set<express.Response>();

  const persistAndBroadcast = (broadcast = false) => {
    savePersistedState(state);
    if (!broadcast || sseClients.size === 0) return;
    const payload = JSON.stringify({
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
      provider: getProviderStatus(),
    });
    for (const client of sseClients) {
      client.write(`event: state_update\ndata: ${payload}\n\n`);
    }
  };

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  app.get('/api/health', (_req, res) => {
    const provider = getProviderStatus();
    res.json({
      ok: true,
      ...provider,
      persistence: describePersistence(DEFAULT_STATE_PATH),
      ledgerCount: state.ledger.length,
      ledgerHeadHash: state.ledger[state.ledger.length - 1]?.hash ?? null,
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
      provider: getProviderStatus(),
    });
  });

  app.post('/api/reset', async (_req, res) => {
    state = await createInitialState();
    persistAndBroadcast(true);
    res.json({
      ok: true,
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
    });
  });

  interface ExecuteScenarioOptions {
    /** Genera una rampa sintética coherente (6 lecturas, 1 min) antes de la lectura final. */
    ramp?: boolean;
    /** Desactiva Gemini para que el resultado sea idéntico y no dependa de servicios externos. */
    forceDeterministicAi?: boolean;
  }

  const lerp = (a: number, b: number, t: number) => Number((a + (b - a) * t).toFixed(2));

  const executeScenario = async (scenario: (typeof DIFFERENTIAL_SCENARIOS)[number], opts: ExecuteScenarioOptions = {}) => {
    const nodeIdx = state.nodes.findIndex((n) => n.id === scenario.nodeId);
    const node = state.nodes[nodeIdx];
    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();
    const reading: TelemetryReading = {
      ...scenario.injectedReading,
      id: `SCEN-${scenario.id}-${nowMs.toString(36)}`,
      timestamp,
    };

    // Rampa sintética: el evento no aparece de golpe; se ve el deterioro minuto a minuto.
    if (opts.ramp) {
      const RAMP_STEPS = 5;
      const base = node.baseline;
      const ramp: TelemetryReading[] = [];
      for (let i = 1; i <= RAMP_STEPS; i++) {
        const t = (i / (RAMP_STEPS + 1)) ** 2;
        ramp.push({
          id: `RAMP-${scenario.id}-${i}`,
          timestamp: new Date(nowMs - (RAMP_STEPS + 1 - i) * 60_000).toISOString(),
          nodeId: node.id,
          pressureBar: lerp(base.pressureBar, reading.pressureBar, t),
          flowLs: lerp(base.flowLs, reading.flowLs, t),
          levelPct: lerp(base.levelPct, reading.levelPct, t),
          turbidityNtu: lerp(base.turbidityNtu, reading.turbidityNtu, t),
          chlorineMgL: lerp(base.chlorineMgL, reading.chlorineMgL, t),
          ph: lerp(base.ph, reading.ph, t),
          synthetic: true,
        });
      }
      state.seriesByNode[node.id] = [...(state.seriesByNode[node.id] ?? []).slice(-14), ...ramp];
    }

    const prevStatus = node.status;
    const history = state.seriesByNode[node.id] ?? [];
    state.seriesByNode[node.id] = [...history.slice(-19), reading];

    const rawAnomaly = evaluateTelemetryReading(reading, node, history);
    const updatedNode: NetworkNode = {
      ...node,
      current: reading,
      status: rawAnomaly ? healthFromCategory(rawAnomaly.category) : 'nominal',
    };
    state.nodes[nodeIdx] = updatedNode;

    // Conservación de masa: el caudal que se pierde en una fuga sintética debe entrar por aguas arriba.
    if (scenario.id === 'leak') {
      const lossLs = Number((reading.flowLs - node.baseline.flowLs).toFixed(2));
      for (const c of upstreamFlowConsequences(node.id, lossLs, NETWORK_PIPES)) {
        const upIdx = state.nodes.findIndex((n) => n.id === c.nodeId);
        if (upIdx === -1) continue;
        const up = state.nodes[upIdx];
        const upReading: TelemetryReading = {
          ...up.current,
          id: `CONSEQ-${up.id}-${nowMs.toString(36)}`,
          timestamp,
          flowLs: Number((up.baseline.flowLs + c.flowDeltaLs).toFixed(2)),
          synthetic: true,
        };
        state.nodes[upIdx] = { ...up, current: upReading };
        state.seriesByNode[up.id] = [...(state.seriesByNode[up.id] ?? []).slice(-19), upReading];
      }
    }

    const anomaly = rawAnomaly
      ? enrichAnomalyWithNetworkContext(rawAnomaly, state.nodes, NETWORK_PIPES)
      : null;

    const providerStatus = getProviderStatus();
    const isGeminiLive = providerStatus.aiMode === 'gemini-live' && !opts.forceDeterministicAi;
    const fallbackReason = providerStatus.aiMode === 'gemini-live' ? 'missing_key' : 'missing_key';
    const provisionalVisionId = `VIS-${nowMs.toString(36).toUpperCase()}`;
    const provisionalDiagId = `DIAG-${nowMs.toString(36).toUpperCase()}`;

    let visionAnalysis: VisionAnalysisResult | null = null;
    if (scenario.imageUrl && scenario.imageTitle) {
      visionAnalysis = buildFallbackVisionAnalysis(
        { node: updatedNode, imageUrl: scenario.imageUrl, imageTitle: scenario.imageTitle, activeAnomaly: anomaly },
        timestamp,
        { id: provisionalVisionId, provisional: isGeminiLive, reason: fallbackReason }
      );
      state.visionAnalyses = [visionAnalysis, ...state.visionAnalyses].slice(0, 20);
    }

    let diagnosis: AquaBrainDiagnosis | null = null;
    if (anomaly) {
      anomaly.scenarioId = scenario.id;
      state.anomalies = [
        anomaly,
        ...state.anomalies.filter((a) => a.nodeId !== node.id || a.status === 'resolved'),
      ];

      await appendToLedger({
        action: 'ANOMALY_DETECTED',
        actor: 'Motor Determinista',
        assetId: node.id,
        evidenceSummary: `${anomaly.title} (Score ${anomaly.priority.totalScore}/100 · ${anomaly.priority.priority})`,
        previousState: prevStatus,
        newState: updatedNode.status,
        evidenceData: { anomalyId: anomaly.id, rules: anomaly.rulesTriggered.map((r) => r.ruleId), synthetic: anomaly.synthetic },
      });

      diagnosis = buildFallbackDiagnosis(
        { anomaly, node: updatedNode, visionAnalysis },
        timestamp,
        { id: provisionalDiagId, provisional: isGeminiLive, reason: fallbackReason }
      );
      state.diagnoses = [diagnosis, ...state.diagnoses];

      await appendToLedger({
        action: 'DIAGNOSIS_GENERATED',
        actor: `Aqua Brain (${diagnosis.providerUsed})`,
        assetId: node.id,
        evidenceSummary: `Hipótesis: ${diagnosis.primaryHypothesis.slice(0, 120)} (Confianza ${diagnosis.confidencePct}%)`,
        previousState: 'anomaly_detected',
        newState: 'diagnosis_pending_approval',
        evidenceData: { diagnosisId: diagnosis.id, confidencePct: diagnosis.confidencePct },
      });
    }

    persistAndBroadcast(false);

    const payload = {
      scenario,
      node: updatedNode,
      anomaly,
      visionAnalysis,
      diagnosis,
      aiEnrichmentStatus: isGeminiLive ? 'pending' : 'complete',
      ledger: state.ledger,
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
    };

    if (isGeminiLive && (visionAnalysis || diagnosis)) {
      void (async () => {
        try {
          let enrichedVision: VisionAnalysisResult | null = visionAnalysis;
          if (scenario.imageUrl && scenario.imageTitle && visionAnalysis) {
            const liveVision = await analyzeVisionEvidence({
              node: updatedNode,
              imageUrl: scenario.imageUrl,
              imageTitle: scenario.imageTitle,
              activeAnomaly: anomaly,
            });
            enrichedVision = { ...liveVision, id: provisionalVisionId };
            state.visionAnalyses = state.visionAnalyses.map((v) =>
              v.id === provisionalVisionId ? enrichedVision! : v
            );
          }

          if (anomaly && diagnosis) {
            const liveDiag = await synthesizeDiagnosis({ anomaly, node: updatedNode, visionAnalysis: enrichedVision });
            state.diagnoses = state.diagnoses.map((d) =>
              d.id === provisionalDiagId
                ? { ...liveDiag, id: provisionalDiagId, operatorDecision: d.operatorDecision, operatorNote: d.operatorNote }
                : d
            );

            await appendToLedger({
              action: 'AI_ENRICHMENT_COMPLETED',
              actor: `Aqua Brain (${liveDiag.providerUsed})`,
              assetId: node.id,
              evidenceSummary: `Enriquecimiento completado (${liveDiag.enrichmentStatus ?? 'fallback'}): ${liveDiag.primaryHypothesis.slice(0, 110)}`,
              previousState: 'diagnosis_preliminary',
              newState: 'diagnosis_enriched',
              evidenceData: {
                diagnosisId: provisionalDiagId,
                providerMode: liveDiag.providerMode,
                enrichmentStatus: liveDiag.enrichmentStatus,
                fallbackReason: liveDiag.fallbackReason,
              },
            });
          }

          persistAndBroadcast(true);
        } catch (err) {
          console.warn('Error en enriquecimiento asíncrono de escenario:', err);
        }
      })();
    }

    return payload;
  };

  app.post('/api/scenarios/:id/trigger', async (req, res) => {
    const scenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === (req.params.id as ScenarioId));
    if (!scenario) {
      res.status(404).json({ error: 'Escenario no encontrado.' });
      return;
    }
    if (!state.nodes.some((n) => n.id === scenario.nodeId)) {
      res.status(404).json({ error: 'Nodo del escenario no encontrado.' });
      return;
    }
    res.json(await executeScenario(scenario));
  });

  // Modo demo reproducible (REQ-DEMO-01): reinicia, genera una rampa sintética y ejecuta la fuga sin depender de servicios externos.
  app.post('/api/demo/frankenstein', async (req, res) => {
    state = await createInitialState();
    const scenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'leak')!;
    await appendToLedger({
      action: 'DEMO_MODE_STARTED',
      actor: 'Sistema Aqua Sentinel',
      assetId: 'RED-SAN-CRISTOBAL',
      evidenceSummary:
        'Modo demo reproducible: todas las lecturas son SINTÉTICAS. La IA en vivo está desactivada para que el resultado sea idéntico y no dependa de servicios externos.',
      previousState: 'nominal',
      newState: 'demo_synthetic',
      evidenceData: { scenario: scenario.id, synthetic: true, liveAi: Boolean(req.body?.liveAi) },
    });
    const payload = await executeScenario(scenario, { ramp: true, forceDeterministicAi: !req.body?.liveAi });
    res.json({ ...payload, demo: { synthetic: true, scenarioId: scenario.id, liveAi: Boolean(req.body?.liveAi) } });
  });
  app.post('/api/telemetry/ingest', async (req, res) => {
    const { csvText, readings: directReadings } = req.body as {
      csvText?: string;
      readings?: TelemetryReading[];
    };

    let parsedReadings: TelemetryReading[] = [];
    let errors: string[] = [];

    if (typeof csvText === 'string') {
      const parsed = parseCsvTelemetry(csvText);
      parsedReadings = parsed.readings;
      errors = parsed.errors;
    } else if (Array.isArray(directReadings)) {
      parsedReadings = directReadings;
    } else {
      res.status(400).json({ error: 'Se requiere csvText o readings.' });
      return;
    }

    const detectedAnomalies: AnomalyEvent[] = [];

    for (const r of parsedReadings) {
      const idx = state.nodes.findIndex((n) => n.id === r.nodeId);
      if (idx === -1) {
        errors.push(`Nodo desconocido: ${r.nodeId}`);
        continue;
      }
      const node = state.nodes[idx];
      const history = state.seriesByNode[node.id] ?? [];
      state.seriesByNode[node.id] = [...history.slice(-19), r];

      const rawAnomaly = evaluateTelemetryReading(r, node, history);
      state.nodes[idx] = {
        ...node,
        current: r,
        status: rawAnomaly ? healthFromCategory(rawAnomaly.category) : 'nominal',
      };

      const anomaly = rawAnomaly
        ? enrichAnomalyWithNetworkContext(rawAnomaly, state.nodes, NETWORK_PIPES)
        : null;

      if (anomaly) {
        detectedAnomalies.push(anomaly);
        state.anomalies = [anomaly, ...state.anomalies.filter((a) => a.nodeId !== node.id || a.status === 'resolved')];
        await appendToLedger({
          action: 'TELEMETRY_ANOMALY_INGESTED',
          actor: 'Motor Determinista (Ingesta)',
          assetId: node.id,
          evidenceSummary: anomaly.title,
          previousState: node.status,
          newState: state.nodes[idx].status,
          evidenceData: { readingId: r.id, score: anomaly.priority.totalScore },
        });
      }
    }

    persistAndBroadcast(false);

    res.json({
      ingestedCount: parsedReadings.length,
      errors,
      detectedAnomalies,
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      ledger: state.ledger,
    });
  });

  app.post('/api/ai/vision-analyze', async (req, res) => {
    const { nodeId, imageUrl, imageTitle, imageBase64, imageMimeType } = req.body as {
      nodeId: string;
      imageUrl: string;
      imageTitle: string;
      imageBase64?: string;
      imageMimeType?: string;
    };

    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      res.status(404).json({ error: 'Nodo no encontrado.' });
      return;
    }

    const activeAnomaly = state.anomalies.find((a) => a.nodeId === nodeId && a.status === 'active') ?? null;
    const analysis = await analyzeVisionEvidence({
      node,
      imageUrl: imageUrl || '',
      imageTitle: imageTitle || 'Reporte fotográfico de campo',
      imageBase64,
      imageMimeType,
      activeAnomaly,
    });

    state.visionAnalyses = [analysis, ...state.visionAnalyses].slice(0, 20);
    await appendToLedger({
      action: 'VISION_EVIDENCE_ANALYZED',
      actor: analysis.providerUsed,
      assetId: node.id,
      evidenceSummary: `${analysis.imageTitle} — ${analysis.confidenceLabel}`,
      previousState: 'evidence_uploaded',
      newState: 'vision_correlated',
      evidenceData: { visionId: analysis.id, mode: analysis.providerMode },
    });

    persistAndBroadcast(false);

    res.json({
      analysis,
      visionAnalyses: state.visionAnalyses,
      ledger: state.ledger,
    });
  });

  app.post('/api/ai/diagnose', async (req, res) => {
    const { anomalyId, visionAnalysisId } = req.body as {
      anomalyId: string;
      visionAnalysisId?: string;
    };

    const anomaly = state.anomalies.find((a) => a.id === anomalyId);
    if (!anomaly) {
      res.status(404).json({ error: 'Anomalía no encontrada.' });
      return;
    }
    const node = state.nodes.find((n) => n.id === anomaly.nodeId)!;
    const visionAnalysis = visionAnalysisId
      ? state.visionAnalyses.find((v) => v.id === visionAnalysisId) ?? null
      : state.visionAnalyses.find((v) => v.nodeId === node.id) ?? null;

    const diagnosis = await synthesizeDiagnosis({ anomaly, node, visionAnalysis });
    state.diagnoses = [diagnosis, ...state.diagnoses];

    await appendToLedger({
      action: 'AQUA_BRAIN_DIAGNOSIS',
      actor: `Aqua Brain (${diagnosis.providerUsed})`,
      assetId: node.id,
      evidenceSummary: diagnosis.primaryHypothesis,
      previousState: 'anomaly_active',
      newState: 'diagnosis_pending_approval',
      evidenceData: { diagnosisId: diagnosis.id, score: diagnosis.priorityScore },
    });

    persistAndBroadcast(false);

    res.json({
      diagnosis,
      diagnoses: state.diagnoses,
      ledger: state.ledger,
    });
  });

  app.post('/api/diagnoses/:id/decision', async (req, res) => {
    const diagnosisId = req.params.id;
    const { decision, operatorNote, modifiedAction, modifiedPriority, assignee } = req.body as {
      decision: 'accepted' | 'modified' | 'rejected';
      operatorNote?: string;
      modifiedAction?: string;
      modifiedPriority?: AquaBrainDiagnosis['priority'];
      assignee?: string;
    };

    const idx = state.diagnoses.findIndex((d) => d.id === diagnosisId);
    if (idx === -1) {
      res.status(404).json({ error: 'Diagnóstico no encontrado.' });
      return;
    }

    const current = state.diagnoses[idx];
    const updatedDiagnosis: AquaBrainDiagnosis = {
      ...current,
      operatorDecision: decision,
      operatorNote,
      recommendedAction: modifiedAction || current.recommendedAction,
      priority: modifiedPriority || current.priority,
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
        assignee: assignee || 'Brigada Hídrica Sectorial A',
        status: 'Abierta',
        checklist: buildChecklist(updatedDiagnosis.interventionSteps),
      };

      await appendToLedger({
        action: 'WORK_ORDER_ISSUED',
        actor: 'Operador Central (Aprobación Aqua Brain)',
        assetId: createdOrder.nodeId,
        evidenceSummary: `${createdOrder.id} emitida [${createdOrder.priority}]: ${updatedDiagnosis.recommendedAction}`,
        previousState: 'diagnosis_pending_approval',
        newState: 'Abierta',
        evidenceData: { workOrderId: createdOrder.id, decision, operatorNote },
      });

      createdOrder.ledgerHash = state.ledger[state.ledger.length - 1].hash;
      state.workOrders = [createdOrder, ...state.workOrders];
    } else {
      await appendToLedger({
        action: 'DIAGNOSIS_REJECTED',
        actor: 'Operador Central',
        assetId: updatedDiagnosis.nodeId,
        evidenceSummary: `Recomendación rechazada. Motivo: ${operatorNote || 'Descartada por operador'}`,
        previousState: 'diagnosis_pending_approval',
        newState: 'rejected',
        evidenceData: { diagnosisId: updatedDiagnosis.id, operatorNote },
      });
    }

    persistAndBroadcast(false);

    res.json({
      diagnosis: updatedDiagnosis,
      createdOrder,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
    });
  });

  const workOrderPayload = () => ({
    workOrders: state.workOrders,
    anomalies: state.anomalies,
    nodes: state.nodes,
    seriesByNode: state.seriesByNode,
    ledger: state.ledger,
  });

  const sendWorkOrderError = (res: express.Response, err: unknown) => {
    if (err instanceof WorkOrderError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('Error inesperado en órdenes de trabajo:', err);
    res.status(500).json({ error: 'Error interno al procesar la orden.' });
  };

  const findOrderIdx = (id: string) => state.workOrders.findIndex((w) => w.id === id);

  app.patch('/api/work-orders/:id', async (req, res) => {
    try {
      const orderId = req.params.id;
      const { status, closureNotes, closureEvidenceLabel } = req.body as {
        status: WorkOrderStatus;
        closureNotes?: string;
        closureEvidenceLabel?: string;
      };
      if (!['Abierta', 'En Progreso', 'Cerrada'].includes(status)) {
        throw new WorkOrderError('Estado inválido.', 400);
      }

      const idx = findOrderIdx(orderId);
      if (idx === -1) throw new WorkOrderError('Orden de trabajo no encontrada.', 404);

      const existing = ensureChecklist(state.workOrders[idx]);
      if (existing.status === 'Cerrada') {
        throw new WorkOrderError('La orden ya está cerrada y sellada en el ledger.', 409);
      }
      if (status === 'Cerrada') {
        const blockers = closureBlockers(existing);
        if (blockers.length > 0) {
          res.status(409).json({ error: `No se puede cerrar la orden: ${blockers.join(' ')}`, blockers });
          return;
        }
      }

      const prevStatus = existing.status;
      const now = new Date().toISOString();
      const updatedOrder: SmartWorkOrder = {
        ...existing,
        status,
        updatedAt: now,
        closureNotes: closureNotes ?? existing.closureNotes,
        closureEvidenceLabel: closureEvidenceLabel ?? existing.closureEvidenceLabel,
      };

      await appendToLedger({
        action: status === 'Cerrada' ? 'WORK_ORDER_CLOSED' : 'WORK_ORDER_UPDATED',
        actor: existing.assignee,
        assetId: existing.nodeId,
        evidenceSummary:
          status === 'Cerrada'
            ? `${existing.id} cerrada con checklist completo y evidencia sha256:${existing.closureEvidence?.sha256.slice(0, 12)}…: ${closureNotes || 'Verificación en campo completada'}`
            : `${existing.id} cambió a ${status}`,
        previousState: prevStatus,
        newState: status,
        evidenceData: {
          workOrderId: existing.id,
          closureNotes,
          closureEvidenceLabel,
          ...(status === 'Cerrada' ? { orderDigest: await orderDigest(updatedOrder) } : {}),
        },
      });

      updatedOrder.ledgerHash = state.ledger[state.ledger.length - 1].hash;
      state.workOrders[idx] = updatedOrder;

      // If closed, resolve associated anomaly and restore node baseline
      if (status === 'Cerrada') {
        state.anomalies = state.anomalies.map((a) =>
          a.id === existing.anomalyId ? { ...a, status: 'resolved' } : a
        );
        const nodeIdx = state.nodes.findIndex((n) => n.id === existing.nodeId);
        if (nodeIdx !== -1) {
          const node = state.nodes[nodeIdx];
          const restoredReading: TelemetryReading = {
            id: `RESTORED-${node.id}-${Date.now().toString(36)}`,
            timestamp: now,
            nodeId: node.id,
            ...node.baseline,
            synthetic: true,
          };
          state.nodes[nodeIdx] = { ...node, status: 'nominal', current: restoredReading };
          state.seriesByNode[node.id] = [
            ...(state.seriesByNode[node.id] ?? []).slice(-19),
            restoredReading,
          ];
        }
      }

      persistAndBroadcast(false);
      res.json({ workOrder: updatedOrder, ...workOrderPayload() });
    } catch (err) {
      sendWorkOrderError(res, err);
    }
  });

  // M-10: asignación de responsable
  app.patch('/api/work-orders/:id/assignee', async (req, res) => {
    try {
      const idx = findOrderIdx(req.params.id);
      if (idx === -1) throw new WorkOrderError('Orden de trabajo no encontrada.', 404);
      const existing = ensureChecklist(state.workOrders[idx]);
      if (existing.status === 'Cerrada') throw new WorkOrderError('La orden está cerrada.', 409);
      const assignee = normalizeAssignee(req.body?.assignee);
      if (assignee === existing.assignee) {
        res.json({ workOrder: existing, ...workOrderPayload() });
        return;
      }
      const updated: SmartWorkOrder = { ...existing, assignee, updatedAt: new Date().toISOString() };
      await appendToLedger({
        action: 'WORK_ORDER_ASSIGNED',
        actor: 'Operador Central',
        assetId: existing.nodeId,
        evidenceSummary: `${existing.id}: responsable ${existing.assignee} → ${assignee}`,
        previousState: existing.assignee,
        newState: assignee,
        evidenceData: { workOrderId: existing.id, from: existing.assignee, to: assignee },
      });
      state.workOrders[idx] = updated;
      persistAndBroadcast(false);
      res.json({ workOrder: updated, ...workOrderPayload() });
    } catch (err) {
      sendWorkOrderError(res, err);
    }
  });

  // M-10: checklist interactivo
  app.patch('/api/work-orders/:id/checklist/:itemId', async (req, res) => {
    try {
      const idx = findOrderIdx(req.params.id);
      if (idx === -1) throw new WorkOrderError('Orden de trabajo no encontrada.', 404);
      if (typeof req.body?.done !== 'boolean') throw new WorkOrderError('Se requiere "done" booleano.', 400);
      const existing = ensureChecklist(state.workOrders[idx]);
      const actor = existing.assignee;
      const { order: updated, item } = setChecklistItem(
        existing,
        req.params.itemId,
        req.body.done,
        actor,
        new Date().toISOString()
      );
      await appendToLedger({
        action: item.done ? 'CHECKLIST_ITEM_COMPLETED' : 'CHECKLIST_ITEM_REOPENED',
        actor,
        assetId: existing.nodeId,
        evidenceSummary: `${existing.id} · ${item.id}: ${item.label}`,
        previousState: item.done ? 'pendiente' : 'completado',
        newState: item.done ? 'completado' : 'pendiente',
        evidenceData: { workOrderId: existing.id, itemId: item.id, label: item.label, done: item.done },
      });
      state.workOrders[idx] = updated;
      persistAndBroadcast(false);
      res.json({ workOrder: updated, ...workOrderPayload() });
    } catch (err) {
      sendWorkOrderError(res, err);
    }
  });

  // M-10: evidencia fotográfica de cierre
  app.post('/api/work-orders/:id/evidence', async (req, res) => {
    try {
      const idx = findOrderIdx(req.params.id);
      if (idx === -1) throw new WorkOrderError('Orden de trabajo no encontrada.', 404);
      const existing = ensureChecklist(state.workOrders[idx]);
      const parsed = parseEvidenceDataUrl(req.body?.dataUrl);
      const fileName = sanitizeFileName(req.body?.fileName);
      const stored = saveEvidence(parsed.base64, parsed.mimeType);
      const now = new Date().toISOString();
      const updated = attachEvidence(
        existing,
        {
          fileName,
          mimeType: parsed.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          attachedAt: now,
          attachedBy: existing.assignee,
        },
        now
      );
      await appendToLedger({
        action: 'CLOSURE_EVIDENCE_ATTACHED',
        actor: existing.assignee,
        assetId: existing.nodeId,
        evidenceSummary: `${existing.id}: foto de cierre ${fileName} (${stored.sizeBytes} B) sha256:${stored.sha256.slice(0, 16)}…`,
        previousState: existing.closureEvidence ? 'evidencia_previa' : 'sin_evidencia',
        newState: 'evidencia_adjunta',
        evidenceData: { workOrderId: existing.id, sha256: stored.sha256, mimeType: parsed.mimeType, sizeBytes: stored.sizeBytes },
      });
      state.workOrders[idx] = updated;
      persistAndBroadcast(false);
      res.json({ workOrder: updated, ...workOrderPayload() });
    } catch (err) {
      sendWorkOrderError(res, err);
    }
  });

  app.get('/api/evidence/:sha256', (req, res) => {
    const found = readEvidence(req.params.sha256);
    if (!found) {
      res.status(404).json({ error: 'Evidencia no encontrada.' });
      return;
    }
    if (!found.verified) {
      res.status(422).json({ error: 'El archivo almacenado no coincide con su SHA-256 (posible alteración).' });
      return;
    }
    res.setHeader('Content-Type', found.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(found.buffer);
  });

  // Expediente de decisión verificable y portable (REQ-LED-02)
  app.get('/api/work-orders/:id/dossier', (req, res) => {
    const order = state.workOrders.find((w) => w.id === req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Orden de trabajo no encontrada.' });
      return;
    }
    const anomaly = state.anomalies.find((a) => a.id === order.anomalyId) ?? null;
    const diagnosis = state.diagnoses.find((d) => d.id === order.diagnosisId) ?? null;
    const vision =
      state.visionAnalyses.find((v) => v.id === diagnosis?.visionAnalysisId) ??
      state.visionAnalyses.find((v) => v.nodeId === order.nodeId) ??
      null;
    const forensics = localizeLeak(state.nodes, NETWORK_PIPES, { photoNodeIds: vision ? [vision.nodeId] : [] });
    const concordance = anomaly ? evaluateConcordance({ anomaly, vision, forensics }) : null;
    let evidencePhoto = null;
    if (order.closureEvidence) {
      const file = readEvidence(order.closureEvidence.sha256);
      if (file) {
        evidencePhoto = {
          sha256: order.closureEvidence.sha256,
          mimeType: file.mimeType,
          base64: file.buffer.toString('base64'),
        };
      }
    }
    const dossier = buildDossier({
      order,
      anomaly,
      diagnosis,
      vision,
      forensics: anomaly?.category === 'leak' ? forensics : null,
      concordance,
      ledger: state.ledger,
      evidencePhoto,
    });
    res.setHeader('Content-Disposition', `attachment; filename="dossier-${order.id}.json"`);
    res.json(dossier);
  });
  app.post('/api/ledger/verify', async (req, res) => {
    const chainToVerify = Array.isArray(req.body?.ledger)
      ? (req.body.ledger as TrustLedgerEntry[])
      : state.ledger;
    const result = await verifyLedgerChain(chainToVerify);
    res.json(result);
  });

  app.post('/api/sync/offline', async (req, res) => {
    const reports = (req.body?.reports ?? []) as OfflineReportRecord[];
    const results: Array<{
      id: string;
      status: 'synced' | 'duplicate' | 'conflict';
      note: string;
      anomalyId?: string;
      diagnosisId?: string;
    }> = [];

    for (const report of reports) {
      if (state.syncedOfflineKeys.has(report.idempotencyKey)) {
        results.push({
          id: report.id,
          status: 'duplicate',
          note: 'Registro deduplicado por clave idempotente; ya existía en servidor.',
        });
        continue;
      }

      const activeConflict = state.workOrders.find(
        (w) => w.nodeId === report.nodeId && w.status === 'Cerrada'
      );
      state.syncedOfflineKeys.add(report.idempotencyKey);

      const nodeIdx = state.nodes.findIndex((n) => n.id === report.nodeId);
      const node = nodeIdx !== -1 ? state.nodes[nodeIdx] : undefined;
      let visionAnalysis: VisionAnalysisResult | null = null;
      if (report.photoDataUrl && node) {
        visionAnalysis = await analyzeVisionEvidence({
          node,
          imageUrl: report.photoDataUrl,
          imageTitle: `Reporte Offline — ${report.reporterName}`,
        });
        state.visionAnalyses = [visionAnalysis, ...state.visionAnalyses].slice(0, 20);
      }

      let createdAnomalyId: string | undefined;
      let createdDiagnosisId: string | undefined;

      if (node) {
        const category = report.category === 'nominal' ? 'leak' : report.category;
        const severityBase =
          category === 'contamination' ? 78 : category === 'leak' ? 74 : category === 'obstruction' ? 62 : 55;
        const priority = computeRiskPriorityScore({
          category,
          maxRuleSeverity: severityBase,
          populationServed: node.populationServed,
          ruleCount: visionAnalysis ? 2 : 1,
        });
        const anomaly: AnomalyEvent = {
          id: `ANOM-OFF-${report.id}`,
          timestamp: report.createdAt || new Date().toISOString(),
          nodeId: node.id,
          nodeName: node.name,
          sector: node.sector,
          category,
          title: `Reporte offline sincronizado (${report.reporterName}): ${report.description.slice(0, 80)}`,
          status: activeConflict ? 'resolved' : 'active',
          rulesTriggered: [
            {
              ruleId:
                category === 'leak'
                  ? 'PRESSURE_DROP_LEAK'
                  : category === 'obstruction'
                    ? 'FLOW_OBSTRUCTION'
                    : category === 'sensor_fault'
                      ? 'SENSOR_PHYSICAL_IMPLAUSIBILITY'
                      : 'QUALITY_PARAMETER_ANOMALY',
              title: `Observación de campo sincronizada (${report.reporterName})`,
              category,
              severityScore: severityBase,
              metric: 'fieldReport',
              observedValue: 1,
              baselineValue: 0,
              deltaPct: 100,
              explanation: `Reporte en sitio capturado sin conexión: "${report.description}"`,
            },
          ],
          priority,
          telemetrySnapshot: node.current,
          baselineSnapshot: node.baseline,
          synthetic: false,
        };
        createdAnomalyId = anomaly.id;
        state.anomalies = [anomaly, ...state.anomalies];

        if (!activeConflict) {
          state.nodes[nodeIdx] = {
            ...node,
            status: healthFromCategory(category),
          };
        }

        const diagnosis = buildFallbackDiagnosis(
          {
            anomaly,
            node: state.nodes[nodeIdx],
            visionAnalysis,
          },
          new Date().toISOString(),
          { reason: getProviderStatus().aiMode === 'gemini-live' ? 'missing_key' : 'missing_key' }
        );
        const enrichedDiag: AquaBrainDiagnosis = {
          ...diagnosis,
          detectedProblem: `Incidencia de campo offline en ${node.name}: ${report.description}`,
          availableEvidences: [
            `Reporte ciudadano/técnico offline (${report.reporterName}) · Clave ${report.idempotencyKey}`,
            ...diagnosis.availableEvidences,
          ],
          providerUsed: 'Aqua Brain (Correlación de Reporte Offline)',
        };
        createdDiagnosisId = enrichedDiag.id;
        state.diagnoses = [enrichedDiag, ...state.diagnoses];
      }

      const conflictNote = activeConflict
        ? `Sincronizado con advertencia de conflicto: existe orden cerrada reciente (${activeConflict.id}) en este nodo.`
        : 'Sincronizado e incorporado al Command Center, Aqua Brain y Trust Ledger.';

      await appendToLedger({
        action: 'OFFLINE_REPORT_SYNCED',
        actor: `${report.reporterName} (Modo Offline)`,
        assetId: report.nodeId,
        evidenceSummary: `${report.description} (${conflictNote})`,
        previousState: 'offline_pending',
        newState: activeConflict ? 'synced_with_conflict_review' : 'synced_to_brain',
        evidenceData: {
          reportId: report.id,
          idempotencyKey: report.idempotencyKey,
          anomalyId: createdAnomalyId,
          diagnosisId: createdDiagnosisId,
        },
      });

      results.push({
        id: report.id,
        status: activeConflict ? 'conflict' : 'synced',
        note: conflictNote,
        anomalyId: createdAnomalyId,
        diagnosisId: createdDiagnosisId,
      });
    }

    persistAndBroadcast(true);

    res.json({
      results,
      ledger: state.ledger,
      visionAnalyses: state.visionAnalyses,
      anomalies: state.anomalies,
      diagnoses: state.diagnoses,
      nodes: state.nodes,
    });
  });

  // Sonda real a Gemini (una llamada mínima). Devuelve el resultado honesto, incluidos errores de API/cuota/timeout.
  app.post('/api/ai/probe', async (_req, res) => {
    res.json(await probeGemini());
  });

  // Forense hidráulica + concordancia multimodal para una anomalía (REQ-HYD-02, REQ-AI-02)
  app.get('/api/anomalies/:id/forensics', (req, res) => {
    const anomaly = state.anomalies.find((a) => a.id === req.params.id);
    if (!anomaly) {
      res.status(404).json({ error: 'Anomalía no encontrada.' });
      return;
    }
    const vision = state.visionAnalyses.find((v) => v.nodeId === anomaly.nodeId) ?? null;
    const forensics = localizeLeak(state.nodes, NETWORK_PIPES, { photoNodeIds: vision ? [vision.nodeId] : [] });
    res.json({ forensics, concordance: evaluateConcordance({ anomaly, vision, forensics }) });
  });

  // Snapshot exportable/importable: respaldo ante entornos efímeros (REQ-PER-02)
  app.get('/api/state/export', (_req, res) => {
    const snapshot = buildSnapshot({
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
      syncedOfflineKeys: Array.from(state.syncedOfflineKeys),
    });
    res.setHeader('Content-Disposition', 'attachment; filename="aqua-sentinel-snapshot.json"');
    res.json(snapshot);
  });

  app.post('/api/state/import', async (req, res) => {
    const result = await validateSnapshot(req.body);
    if (!result.ok) {
      res.status(422).json({ error: 'Snapshot rechazado.', errors: result.errors });
      return;
    }
    const s = result.snapshot.state;
    restoreEvidence(result.snapshot);
    state = {
      nodes: s.nodes,
      seriesByNode: s.seriesByNode,
      anomalies: s.anomalies,
      visionAnalyses: s.visionAnalyses,
      diagnoses: s.diagnoses,
      workOrders: s.workOrders.map(ensureChecklist),
      ledger: s.ledger,
      syncedOfflineKeys: new Set<string>(s.syncedOfflineKeys),
    };
    await appendToLedger({
      action: 'STATE_RESTORED_FROM_SNAPSHOT',
      actor: 'Operador Central',
      assetId: 'RED-SAN-CRISTOBAL',
      evidenceSummary: `Estado restaurado desde snapshot exportado el ${result.snapshot.exportedAt}; cadena verificada (${s.ledger.length} bloques) antes de aceptar.`,
      previousState: 'estado_previo',
      newState: 'restaurado',
      evidenceData: { exportedAt: result.snapshot.exportedAt, ledgerBlocks: s.ledger.length },
    });
    persistAndBroadcast(true);
    res.json({
      ok: true,
      nodes: state.nodes,
      seriesByNode: state.seriesByNode,
      anomalies: state.anomalies,
      visionAnalyses: state.visionAnalyses,
      diagnoses: state.diagnoses,
      workOrders: state.workOrders,
      ledger: state.ledger,
    });
  });
  app.get('/api/kiro/files', (_req, res) => {
    const kiroRoot = path.resolve(process.cwd(), '.kiro');
    const files: Array<{ path: string; category: string; content: string }> = [];

    const walk = (dir: string, category: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full, entry);
        } else {
          files.push({
            path: `.kiro/${path.relative(kiroRoot, full)}`,
            category,
            content: fs.readFileSync(full, 'utf8'),
          });
        }
      }
    };

    walk(kiroRoot, 'root');
    res.json({ files });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use('/src/assets', express.static(path.resolve(process.cwd(), 'dist/src/assets')));
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Aqua Sentinel server listening on http://0.0.0.0:${port}`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start Aqua Sentinel server:', err);
  process.exit(1);
});





