import { isStructurallyValidReading } from './telemetryValidation';
import { NetworkNode, TelemetryReading } from './types';

/**
 * REQ-RES-02: un estado persistido con lecturas corruptas (por ejemplo, de una versión anterior que no validaba)
 * dejaba la interfaz en blanco de forma permanente. Al cargar, se repara y se informa de cada reparación.
 */
export interface RepairResult {
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  repairs: string[];
}

export function repairTelemetryState(
  nodes: unknown,
  seriesByNode: unknown,
  baselineNodes: NetworkNode[]
): RepairResult {
  const repairs: string[] = [];
  const baselineById = new Map(baselineNodes.map((n) => [n.id, n]));
  const inputNodes = Array.isArray(nodes) ? (nodes as NetworkNode[]) : [];
  const inputSeries =
    seriesByNode && typeof seriesByNode === 'object' ? (seriesByNode as Record<string, unknown>) : {};

  const repairedNodes: NetworkNode[] = [];
  for (const base of baselineNodes) {
    const stored = inputNodes.find((n) => n && n.id === base.id);
    if (!stored || typeof stored !== 'object') {
      repairs.push(`Nodo ${base.id} ausente en el estado persistido: restaurado desde la línea base.`);
      repairedNodes.push(base);
      continue;
    }
    if (isStructurallyValidReading(stored.current) && stored.current.nodeId === base.id) {
      repairedNodes.push({ ...base, ...stored, baseline: base.baseline });
    } else {
      repairs.push(`Nodo ${base.id}: lectura actual corrupta; restaurada desde la línea base.`);
      repairedNodes.push({ ...base, ...stored, status: 'nominal', current: base.current, baseline: base.baseline });
    }
  }

  const repairedSeries: Record<string, TelemetryReading[]> = {};
  for (const base of baselineNodes) {
    const raw = inputSeries[base.id];
    const list = Array.isArray(raw) ? raw : [];
    const valid = list.filter(isStructurallyValidReading);
    if (valid.length !== list.length) {
      repairs.push(`Serie ${base.id}: ${list.length - valid.length} lectura(s) corrupta(s) descartada(s).`);
    }
    repairedSeries[base.id] = valid.length > 0 ? valid : [baselineById.get(base.id)!.current];
  }
  return { nodes: repairedNodes, seriesByNode: repairedSeries, repairs };
}
