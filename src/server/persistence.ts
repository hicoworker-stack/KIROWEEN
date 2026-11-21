import { isPublicModeEnabled } from './publicMode';
import fs from 'fs';
import path from 'path';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  SignedAnchor,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
} from '../core/types';

export interface PersistedServerState {
  version: number;
  savedAt: string;
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  anomalies: AnomalyEvent[];
  visionAnalyses: VisionAnalysisResult[];
  diagnoses: AquaBrainDiagnosis[];
  workOrders: SmartWorkOrder[];
  ledger: TrustLedgerEntry[];
  syncedOfflineKeys: string[];
  /** v2: contenido sellado de los expedientes cerrados (por id de orden). */
  sealedDossiers?: Record<string, unknown>;
  /** v2: anclas firmadas de la cabeza del ledger, para detectar truncamientos del archivo de estado. */
  anchors?: SignedAnchor[];
  /** v2: claves de deduplicación de lecturas (nodo|marca temporal → huella del contenido). */
  seenReadingKeys?: Record<string, string>;
}

export const STATE_FORMAT_VERSION = 2;

/** Ruta del estado de la instancia PÚBLICA: separada del estado operativo (data/aqua-sentinel-state.json). */
export const PUBLIC_DEMO_STATE_RELATIVE = 'data/public-demo/aqua-sentinel-state.json';
export const DEFAULT_STATE_PATH = path.resolve(
  process.cwd(),
  process.env.AQUA_STATE_PATH || (isPublicModeEnabled() ? PUBLIC_DEMO_STATE_RELATIVE : 'data/aqua-sentinel-state.json')
);

/**
 * Carga el estado persistido. Un archivo ilegible NO se sobrescribe en silencio: se aparta como
 * `<archivo>.corrupt-<fecha>` para no perder la evidencia, y se arranca desde la línea base.
 */
export function loadPersistedState(
  filePath: string = DEFAULT_STATE_PATH
): PersistedServerState | null {
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return null;
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn('No se pudo leer el estado persistido:', err);
    return null;
  }
  let parsed: Partial<PersistedServerState> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedServerState>;
  } catch {
    parsed = null;
  }
  const valid =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.nodes) &&
    Array.isArray(parsed.ledger) &&
    parsed.seriesByNode &&
    typeof parsed.seriesByNode === 'object';
  if (!valid || !parsed) {
    try {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, backup);
      console.warn(`Estado persistido ilegible o inválido; se conservó una copia en ${backup} y se inicia la línea base.`);
    } catch (err) {
      console.warn('No se pudo apartar el estado ilegible:', err);
    }
    return null;
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    nodes: parsed.nodes!,
    seriesByNode: parsed.seriesByNode!,
    anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
    visionAnalyses: Array.isArray(parsed.visionAnalyses) ? parsed.visionAnalyses : [],
    diagnoses: Array.isArray(parsed.diagnoses) ? parsed.diagnoses : [],
    workOrders: Array.isArray(parsed.workOrders) ? parsed.workOrders : [],
    ledger: parsed.ledger!,
    syncedOfflineKeys: Array.isArray(parsed.syncedOfflineKeys) ? parsed.syncedOfflineKeys : [],
    sealedDossiers:
      parsed.sealedDossiers && typeof parsed.sealedDossiers === 'object' ? parsed.sealedDossiers : {},
    anchors: Array.isArray(parsed.anchors) ? parsed.anchors : [],
    seenReadingKeys:
      parsed.seenReadingKeys && typeof parsed.seenReadingKeys === 'object' ? parsed.seenReadingKeys : {},
  };
}

export type SaveInput = Omit<PersistedServerState, 'version' | 'savedAt' | 'syncedOfflineKeys'> & {
  syncedOfflineKeys: Set<string> | string[];
};

/** Guarda de forma atómica (archivo temporal + rename). Lanza si falla. */
export function savePersistedState(state: SaveInput, filePath: string = DEFAULT_STATE_PATH): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload: PersistedServerState = {
    version: STATE_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    nodes: state.nodes,
    seriesByNode: state.seriesByNode,
    anomalies: state.anomalies,
    visionAnalyses: state.visionAnalyses,
    diagnoses: state.diagnoses,
    workOrders: state.workOrders,
    ledger: state.ledger,
    syncedOfflineKeys: Array.isArray(state.syncedOfflineKeys)
      ? state.syncedOfflineKeys
      : Array.from(state.syncedOfflineKeys),
    sealedDossiers: state.sealedDossiers ?? {},
    anchors: state.anchors ?? [],
    seenReadingKeys: state.seenReadingKeys ?? {},
  };

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* el temporal no existe o no se puede borrar: no es crítico */
    }
    throw err;
  }
}

/** Variante que nunca lanza: devuelve el error para que el servidor degrade a "solo memoria". */
export function trySavePersistedState(
  state: SaveInput,
  filePath: string = DEFAULT_STATE_PATH
): { ok: true } | { ok: false; error: string } {
  try {
    savePersistedState(state, filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}
