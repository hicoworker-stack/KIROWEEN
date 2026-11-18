import fs from 'node:fs';
import path from 'node:path';
import { verifyLedgerChain } from '../core/cryptoLedger';
import { PersistedServerState } from './persistence';
import { defaultEvidenceDir, readEvidence, saveEvidence, sha256OfBuffer } from './evidenceStore';

/**
 * REQ-PER-02: persistencia honesta para entornos efímeros.
 * El estado vive en un archivo local. Si el contenedor se recrea, se pierde. Mitigaciones reales:
 *  1) AQUA_STATE_PATH apunta a un volumen montado; 2) snapshot exportable/importable con verificación de cadena.
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

export interface StateSnapshot {
  format: 'aqua-sentinel-snapshot/1';
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
  return { format: 'aqua-sentinel-snapshot/1', exportedAt: new Date().toISOString(), state, evidence };
}

export async function validateSnapshot(raw: unknown): Promise<{ ok: true; snapshot: StateSnapshot } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const s = raw as Partial<StateSnapshot> | null;
  if (!s || typeof s !== 'object' || s.format !== 'aqua-sentinel-snapshot/1') {
    return { ok: false, errors: ['Formato de snapshot no reconocido.'] };
  }
  const st = s.state as Partial<PersistedServerState> | undefined;
  if (!st || !Array.isArray(st.nodes) || !Array.isArray(st.ledger) || typeof st.seriesByNode !== 'object' || !st.seriesByNode) {
    return { ok: false, errors: ['El snapshot no contiene un estado válido.'] };
  }
  for (const key of ['anomalies', 'visionAnalyses', 'diagnoses', 'workOrders', 'syncedOfflineKeys'] as const) {
    if (!Array.isArray(st[key])) errors.push(`Campo "${key}" ausente o no es una lista.`);
  }
  const chain = await verifyLedgerChain(st.ledger!);
  if (!chain.valid) errors.push(`Cadena del ledger inválida: ${chain.reason ?? `bloque #${chain.brokenIndex}`}`);
  const evidence = s.evidence ?? {};
  for (const [sha, item] of Object.entries(evidence)) {
    if (!/^[a-f0-9]{64}$/.test(sha) || typeof item?.base64 !== 'string') {
      errors.push(`Evidencia con identificador inválido: ${sha.slice(0, 20)}`);
      continue;
    }
    if (sha256OfBuffer(Buffer.from(item.base64, 'base64')) !== sha) errors.push(`La evidencia ${sha.slice(0, 12)}… no coincide con su SHA-256.`);
  }
  for (const w of (st.workOrders ?? []) as PersistedServerState['workOrders']) {
    if (w.closureEvidence && !evidence[w.closureEvidence.sha256]) {
      errors.push(`La orden ${w.id} referencia una foto (${w.closureEvidence.sha256.slice(0, 12)}…) que no viene en el snapshot.`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot: s as StateSnapshot };
}

export function restoreEvidence(snapshot: StateSnapshot, evidenceDir: string = defaultEvidenceDir()): number {
  let count = 0;
  for (const item of Object.values(snapshot.evidence)) {
    saveEvidence(item.base64, item.mimeType, evidenceDir);
    count++;
  }
  return count;
}

