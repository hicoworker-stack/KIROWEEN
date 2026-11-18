import { evaluatePipeMassBalances, getUpstreamNodeIds } from './graphHydrology';
import { NetworkNode, PipeSegment } from './types';

/**
 * REQ-HYD-02: Forense hidráulica de fugas.
 * Combina balance de masa entre medidores, déficit de presión y evidencia fotográfica
 * para ubicar el tramo sospechoso y estimar el caudal perdido.
 *
 * Límite honesto: la resolución espacial es "el tramo entre dos medidores". Sin sensores
 * intermedios no se puede localizar la fuga dentro de un tramo, y el caudal perdido es una
 * estimación del desbalance respecto a la línea base, no una medición directa.
 */

export interface LeakSuspect {
  pipeId: string;
  fromNodeId: string;
  toNodeId: string;
  lengthM: number;
  probability: number; // 0..1, normalizada entre sospechosos
  rationale: string[];
}

export interface LeakForensicsReport {
  detected: boolean;
  estimatedLossLs: number;
  estimatedLossM3PerDay: number;
  confidence: 'alta' | 'media' | 'baja';
  suspects: LeakSuspect[];
  /** Nodos con medidor cuyas lecturas son incoherentes con la conservación de masa y NO indican fuga (p. ej. salida > entrada). */
  meterInconsistencies: string[];
  resolutionNote: string;
}

const SECONDS_PER_DAY = 86400;

function pressureDeficitPct(node: NetworkNode): number {
  if (node.baseline.pressureBar <= 0) return 0;
  return Math.max(0, ((node.baseline.pressureBar - node.current.pressureBar) / node.baseline.pressureBar) * 100);
}

export function localizeLeak(
  nodes: NetworkNode[],
  pipes: PipeSegment[],
  options: { photoNodeIds?: string[] } = {}
): LeakForensicsReport {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const photoNodes = new Set(options.photoNodeIds ?? []);
  const balances = evaluatePipeMassBalances(nodes, pipes);

  const meterInconsistencies = balances
    .filter((b) => b.flagged && b.deviationLs < 0)
    .map(
      (b) =>
        `${b.nodeName}: la salida medida supera la entrada en ${Math.abs(b.deviationLs)} L/s respecto a la línea base. Una fuga no explica eso; revisar calibración de medidores.`
    );

  const leakingNodes = balances.filter((b) => b.flagged && b.deviationLs > 0);
  if (leakingNodes.length === 0) {
    return {
      detected: false,
      estimatedLossLs: 0,
      estimatedLossM3PerDay: 0,
      confidence: 'baja',
      suspects: [],
      meterInconsistencies,
      resolutionNote: 'Sin desbalance de masa positivo entre medidores; no hay base para ubicar una fuga.',
    };
  }

  const raw: Array<{ pipe: PipeSegment; weight: number; lossLs: number; rationale: string[] }> = [];
  for (const b of leakingNodes) {
    const outgoing = pipes.filter((p) => p.from === b.nodeId);
    for (const pipe of outgoing) {
      const child = nodeMap.get(pipe.to);
      const parent = nodeMap.get(pipe.from);
      const rationale = [
        `Balance de masa en ${b.nodeName}: entra ${b.inflowLs} L/s, salen ${b.outflowSumLs} L/s (+${b.deviationLs} L/s vs línea base).`,
      ];
      let weight = 1;
      const childDeficit = child ? pressureDeficitPct(child) : 0;
      const parentDeficit = parent ? pressureDeficitPct(parent) : 0;
      if (parentDeficit >= 15) {
        weight += (parentDeficit / 100) * 4;
        rationale.push(`Déficit de presión de ${parentDeficit.toFixed(0)}% en el extremo aguas arriba (${parent!.name}).`);
      }
      if (childDeficit >= 15) {
        weight += (childDeficit / 100) * 4;
        rationale.push(`Déficit de presión de ${childDeficit.toFixed(0)}% en el extremo aguas abajo (${child!.name}).`);
      }
      if (photoNodes.has(pipe.from) || photoNodes.has(pipe.to)) {
        weight += 0.75;
        rationale.push('Hay evidencia fotográfica en un extremo del tramo.');
      }
      raw.push({ pipe, weight, lossLs: b.deviationLs, rationale });
    }
  }

  // Un nodo pudo aparecer en varios desbalances (aguas arriba de la fuga el desbalance se propaga). Se usa el más aguas abajo:
  // el desbalance cuyo nodo no tiene ancestro también desbalanceado indica el origen.
  const flaggedIds = new Set(leakingNodes.map((b) => b.nodeId));
  const originIds = new Set(
    leakingNodes
      .filter((b) => {
        const descendantsFlagged = pipes.some((p) => p.from === b.nodeId && flaggedIds.has(p.to));
        return !descendantsFlagged;
      })
      .map((b) => b.nodeId)
  );
  const candidates = raw.filter((r) => originIds.has(r.pipe.from));
  const totalWeight = candidates.reduce((a, r) => a + r.weight, 0) || 1;
  const suspects: LeakSuspect[] = candidates
    .map((r) => ({
      pipeId: r.pipe.id,
      fromNodeId: r.pipe.from,
      toNodeId: r.pipe.to,
      lengthM: r.pipe.lengthM,
      probability: Number((r.weight / totalWeight).toFixed(2)),
      rationale: r.rationale,
    }))
    .sort((a, b) => b.probability - a.probability);

  const estimatedLossLs = Number(
    Math.max(...leakingNodes.filter((b) => originIds.has(b.nodeId)).map((b) => b.deviationLs)).toFixed(2)
  );

  const corroborated = suspects.some(
    (s) => s.rationale.some((r) => r.includes('Déficit de presión')) || s.rationale.some((r) => r.includes('fotográfica'))
  );
  const confidence: LeakForensicsReport['confidence'] =
    corroborated && suspects[0]?.probability >= 0.6 ? 'alta' : corroborated ? 'media' : 'baja';

  return {
    detected: true,
    estimatedLossLs,
    estimatedLossM3PerDay: Number(((estimatedLossLs * SECONDS_PER_DAY) / 1000).toFixed(1)),
    confidence,
    suspects,
    meterInconsistencies,
    resolutionNote:
      'Resolución limitada al tramo entre dos medidores. El caudal perdido es una estimación del desbalance frente a la línea base, no una medición directa.',
  };
}

/**
 * Aplica consecuencias físicas coherentes de una fuga sintética: el caudal perdido debe provenir de aguas arriba,
 * por lo que cada ancestro ve +lossLs de caudal (conservación de masa). Solo para escenarios sintéticos.
 */
export function upstreamFlowConsequences(
  leakNodeId: string,
  lossLs: number,
  pipes: PipeSegment[]
): Array<{ nodeId: string; flowDeltaLs: number }> {
  const result: Array<{ nodeId: string; flowDeltaLs: number }> = [];
  const seen = new Set<string>([leakNodeId]);
  let frontier = [leakNodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const up of getUpstreamNodeIds(id, pipes)) {
        if (seen.has(up)) continue;
        seen.add(up);
        result.push({ nodeId: up, flowDeltaLs: Number(lossLs.toFixed(2)) });
        next.push(up);
      }
    }
    frontier = next;
  }
  return result;
}

