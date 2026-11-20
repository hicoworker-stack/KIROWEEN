import fs from 'node:fs';
import path from 'node:path';
import { auditStateConsistency } from '../core/consistency';
import { verifyLedgerChain } from '../core/cryptoLedger';
import { computeSealDigests, SealedContent } from '../core/dossier';
import { SignedAnchor, TrustLedgerEntry } from '../core/types';
import { PersistedServerState } from './persistence';
import { defaultEvidenceDir, readEvidence, saveEvidence, sha256OfBuffer } from './evidenceStore';
import { checkAnchorAgainstLedger } from './sealing';

/**
 * REQ-PER-02 / REQ-LED-07: persistencia honesta para entornos efímeros.
 * El estado vive en un archivo local. Si el contenedor se recrea, se pierde. Mitigaciones reales:
 *  1) AQUA_STATE_PATH apunta a un volumen montado; 2) snapshot exportable/importable con verificación estricta.
 *
 * Un snapshot se acepta solo si: la cadena del ledger es válida, órdenes/diagnósticos/ledger son coherentes entre sí,
 * los expedientes sellados coinciden con su digest sellado en el ledger, las anclas firmadas son válidas y el snapshot
 * no retrocede respecto a las anclas del servidor actual. Los nodos y las series de telemetría NO están cubiertos por
 * ningún sello: el snapshot puede alterarlos sin que se detecte.
 */

export interface PersistenceInfo {
  kind: 'local-file';
  statePath: string;
  writable: boolean;
  ephemeralRisk: 'alto' | 'medio' | 'bajo';
  note: string;
}

export function describePersistence(statePath: string): PersistenceInfo {
  const dir = path.dirname(statePath);
  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const ephemeralEnv = ['K_SERVICE', 'RENDER', 'VERCEL', 'FLY_APP_NAME', 'AWS_LAMBDA_FUNCTION_NAME', 'DYNO', 'WEBSITE_SITE_NAME'].some(
    (k) => Boolean(process.env[k])
  );
  const inTmp = /^(\/tmp|[a-z]:\\.*\\temp)/i.test(statePath);
  const ephemeralRisk: PersistenceInfo['ephemeralRisk'] = !writable ? 'alto' : ephemeralEnv || inTmp ? 'alto' : process.env.AQUA_STATE_PATH ? 'bajo' : 'medio';
  return {
    kind: 'local-file',
    statePath,
    writable,
    ephemeralRisk,
    note:
      ephemeralRisk === 'alto'
        ? 'Entorno probablemente efímero: el estado se perderá al recrear el contenedor. Exporta un snapshot antes de la demo o monta un volumen y fija AQUA_STATE_PATH.'
        : ephemeralRisk === 'medio'
          ? 'Archivo local en el directorio de trabajo: sobrevive a reinicios del proceso, no a recrear el contenedor. Usa el snapshot exportable como respaldo.'
          : 'AQUA_STATE_PATH configurado explícitamente; asegúrate de que apunte a un volumen persistente.',
  };
}

export const SNAPSHOT_FORMAT = 'aqua-sentinel-snapshot/2';
const LEGACY_SNAPSHOT_FORMAT = 'aqua-sentinel-snapshot/1';

export interface StateSnapshot {
  format: typeof SNAPSHOT_FORMAT | typeof LEGACY_SNAPSHOT_FORMAT;
  exportedAt: string;
  state: PersistedServerState;
  evidence: Record<string, { mimeType: string; base64: string }>;
}

export function buildSnapshot(state: PersistedServerState, evidenceDir: string = defaultEvidenceDir()): StateSnapshot {
  const evidence: StateSnapshot['evidence'] = {};
  for (const order of state.workOrders) {
    const sha = order.closureEvidence?.sha256;
    if (!sha || evidence[sha]) continue;
    const found = readEvidence(sha, evidenceDir);
    if (found?.verified) evidence[sha] = { mimeType: found.mimeType, base64: found.buffer.toString('base64') };
  }
  return { format: SNAPSHOT_FORMAT, exportedAt: new Date().toISOString(), state, evidence };
}

export interface SnapshotValidationOptions {
  /** Verifica la firma de un ancla con la clave del servidor. */
  verifyAnchor?: (anchor: SignedAnchor) => boolean;
  /** Anclas del servidor actual: el snapshot debe contener su historia (no puede retroceder). */
  currentAnchors?: SignedAnchor[];
  acceptRollback?: boolean;
}

export async function validateSnapshot(
  raw: unknown,
  options: SnapshotValidationOptions = {}
): Promise<{ ok: true; snapshot: StateSnapshot; warnings: string[] } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = raw as Partial<StateSnapshot> | null;
  if (!s || typeof s !== 'object' || (s.format !== SNAPSHOT_FORMAT && s.format !== LEGACY_SNAPSHOT_FORMAT)) {
    return { ok: false, errors: ['Formato de snapshot no reconocido.'] };
  }
  const st = s.state as Partial<PersistedServerState> | undefined;
  if (!st || !Array.isArray(st.nodes) || !Array.isArray(st.ledger) || typeof st.seriesByNode !== 'object' || !st.seriesByNode) {
    return { ok: false, errors: ['El snapshot no contiene un estado válido.'] };
  }
  for (const key of ['anomalies', 'visionAnalyses', 'diagnoses', 'workOrders', 'syncedOfflineKeys'] as const) {
    if (!Array.isArray(st[key])) errors.push(`Campo "${key}" ausente o no es una lista.`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const ledger = st.ledger as TrustLedgerEntry[];
  const chain = await verifyLedgerChain(ledger);
  if (!chain.valid) errors.push(`Cadena del ledger inválida: ${chain.reason ?? `bloque #${chain.brokenIndex}`}`);

  const evidence = s.evidence ?? {};
  for (const [sha, item] of Object.entries(evidence)) {
    if (!/^[a-f0-9]{64}$/.test(sha) || typeof item?.base64 !== 'string') {
      errors.push(`Evidencia con identificador inválido: ${sha.slice(0, 20)}`);
      continue;
    }
    if (sha256OfBuffer(Buffer.from(item.base64, 'base64')) !== sha) errors.push(`La evidencia ${sha.slice(0, 12)}… no coincide con su SHA-256.`);
  }
  const orders = st.workOrders as PersistedServerState['workOrders'];
  for (const w of orders) {
    if (w.closureEvidence && !evidence[w.closureEvidence.sha256]) {
      errors.push(`La orden ${w.id} referencia una foto (${w.closureEvidence.sha256.slice(0, 12)}…) que no viene en el snapshot.`);
    }
  }

  // Coherencia entre órdenes, diagnósticos, anomalías y ledger.
  const issues = auditStateConsistency({
    workOrders: orders,
    diagnoses: st.diagnoses as PersistedServerState['diagnoses'],
    anomalies: st.anomalies as PersistedServerState['anomalies'],
    ledger,
  });
  for (const i of issues) (i.severity === 'error' ? errors : warnings).push(`${i.code}: ${i.message}`);

  // Expedientes sellados: el contenido congelado debe coincidir con el digest sellado en el ledger.
  const sealed = (st.sealedDossiers ?? {}) as Record<string, SealedContent>;
  for (const w of orders) {
    if (w.status !== 'Cerrada' || !w.seal) continue;
    const content = sealed[w.id];
    if (!content) {
      errors.push(`${w.id}: orden sellada sin su expediente congelado en el snapshot.`);
      continue;
    }
    const digests = await computeSealDigests(content);
    const closed = ledger.find((e) => e.action === 'WORK_ORDER_CLOSED' && (e.evidenceData as { workOrderId?: string } | undefined)?.workOrderId === w.id);
    const ledgerDigest = (closed?.evidenceData as { dossierDigest?: string } | undefined)?.dossierDigest;
    if (digests.dossierDigest !== w.seal.dossierDigest || digests.dossierDigest !== ledgerDigest) {
      errors.push(`${w.id}: el expediente congelado fue alterado respecto al digest sellado en el ledger.`);
    }
  }

  // Anclas firmadas del propio snapshot.
  const anchors = (st.anchors ?? []) as SignedAnchor[];
  for (const a of anchors) {
    if (options.verifyAnchor && !options.verifyAnchor(a)) errors.push(`Ancla con firma inválida (altura ${a.payload?.height}).`);
    else {
      const c = checkAnchorAgainstLedger(a, ledger);
      if (!c.ok) errors.push(`Ancla incoherente con el ledger: ${c.reason}`);
    }
  }

  // Retroceso: el snapshot debe contener la historia que el servidor actual ya certificó.
  if (!options.acceptRollback) {
    for (const a of options.currentAnchors ?? []) {
      const c = checkAnchorAgainstLedger(a, ledger);
      if (!c.ok) {
        errors.push(`El snapshot no contiene la historia ya certificada por este servidor (${c.reason}) Si es una restauración deliberada, repite con acceptRollback.`);
        break;
      }
    }
  }

  if (s.format === LEGACY_SNAPSHOT_FORMAT) warnings.push('Snapshot de formato 1: sin expedientes sellados ni anclas.');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot: s as StateSnapshot, warnings };
}

export function restoreEvidence(snapshot: StateSnapshot, evidenceDir: string = defaultEvidenceDir()): number {
  let count = 0;
  for (const item of Object.values(snapshot.evidence)) {
    saveEvidence(item.base64, item.mimeType, evidenceDir);
    count++;
  }
  return count;
}
