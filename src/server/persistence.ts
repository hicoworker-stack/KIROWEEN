import fs from 'fs';
import path from 'path';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
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
}

export const DEFAULT_STATE_PATH = path.resolve(
  process.cwd(),
  process.env.AQUA_STATE_PATH || 'data/aqua-sentinel-state.json'
);

export function loadPersistedState(
  filePath: string = DEFAULT_STATE_PATH
): PersistedServerState | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedServerState>;
    if (
      !parsed ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.ledger) ||
      typeof parsed.seriesByNode !== 'object'
    ) {
      return null;
    }

    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      nodes: parsed.nodes,
      seriesByNode: parsed.seriesByNode,
      anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
      visionAnalyses: Array.isArray(parsed.visionAnalyses) ? parsed.visionAnalyses : [],
      diagnoses: Array.isArray(parsed.diagnoses) ? parsed.diagnoses : [],
      workOrders: Array.isArray(parsed.workOrders) ? parsed.workOrders : [],
      ledger: parsed.ledger,
      syncedOfflineKeys: Array.isArray(parsed.syncedOfflineKeys) ? parsed.syncedOfflineKeys : [],
    };
  } catch (err) {
    console.warn('No se pudo cargar el estado persistido, se iniciará línea base:', err);
    return null;
  }
}

export function savePersistedState(
  state: Omit<PersistedServerState, 'version' | 'savedAt' | 'syncedOfflineKeys'> & {
    syncedOfflineKeys: Set<string> | string[];
  },
  filePath: string = DEFAULT_STATE_PATH
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload: PersistedServerState = {
    version: 1,
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
  };

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

