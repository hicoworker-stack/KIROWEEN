import { HydraulicEvidence } from './evidenceConcordance';
import { NetworkNode, PipeSegment } from './types';

/**
 * REQ-HYD-03: diagnóstico hidráulico con incertidumbre explícita. Sustituye a leakForensics.
 *
 * Qué hace de distinto respecto a la versión anterior (que se auditó):
 *  1. Umbrales justificados: el desbalance de masa de cada nodo se compara con su incertidumbre PROPAGADA
 *     (medidores de entrada y salida + incertidumbre de la demanda no medida), no con un 15% fijo.
 *  2. La demanda no es constante: se estima un factor de demanda con las hojas MEDIDAS de la red (consumos finales)
 *     y se escala con él el consumo local no medido de cada nodo. Un aumento uniforme de la demanda ya no se confunde con una fuga.
 *  3. Niveles distintos de conclusión (no hay una sola "fuga"):
 *       insufficient_data  los datos no permiten evaluar
 *       no_anomaly         el balance es coherente
 *       flow_anomaly       exceso de caudal significativo, SIN corroboración: puede ser deriva de medidor, demanda no uniforme o fuga
 *       possible_leak      exceso corroborado por la respuesta de presión que predice la hidráulica (o por una foto analizada)
 *       localized_leak     posible fuga con un único tramo candidato entre dos medidores
 *  4. Se niega a concluir donde no puede: nodos con almacenamiento (tanques), lecturas no sincronizadas, medidores en falla,
 *     tramos aguas arriba del tanque (bombeo, sin modelo de presión) y fugas dentro del tramo entre medidores.
 *
 * Este módulo NO importa nada de src/sim. Solo ve lecturas y la topología, como en un despliegue real.
 * Todos los parámetros de incertidumbre son SUPUESTOS declarados (HydraulicAssumptions), no mediciones de campo.
 */

export type HydraulicLevel = 'insufficient_data' | 'no_anomaly' | 'flow_anomaly' | 'possible_leak' | 'localized_leak';

export interface HydraulicAssumptions {
  /** Incertidumbre relativa (1σ) de cada medidor de caudal. Supuesto: ±2%. */
  meterRelUncertainty: number;
  /** Incertidumbre (1σ) de cada transmisor de presión, en bar. Supuesto: 0.05. */
  pressureSigmaBar: number;
  /** Incertidumbre relativa (1σ) del consumo local no medido tras escalarlo con el factor de demanda. Supuesto: 15%. */
  demandModelRelUncertainty: number;
  /** Número de σ para declarar una anomalía de caudal. */
  kSigma: number;
  /** Exceso mínimo absoluto (L/s) aunque la incertidumbre sea menor. */
  minExcessLs: number;
  /** Tolerancia de sincronía entre lecturas que se comparan. */
  syncToleranceMs: number;
  /** Coeficiente de Hazen-Williams por defecto (si la tubería no declara uno). */
  hazenWilliamsC: number;
  /** Rango de razón (caída observada / caída predicha) que se considera coherente. */
  pressureRatioMin: number;
  pressureRatioMax: number;
}

export const DEFAULT_HYDRAULIC_ASSUMPTIONS: HydraulicAssumptions = {
  meterRelUncertainty: 0.02,
  pressureSigmaBar: 0.05,
  demandModelRelUncertainty: 0.15,
  kSigma: 3,
  minExcessLs: 0.5,
  syncToleranceMs: 15 * 60 * 1000,
  hazenWilliamsC: 140,
  pressureRatioMin: 0.5,
  pressureRatioMax: 2,
};

export type BalanceState = 'consistent' | 'excess' | 'deficit' | 'not_evaluable';

export interface BalanceAssessment {
  nodeId: string;
  nodeName: string;
  state: BalanceState;
  notEvaluableReasons: string[];
  inflowLs: number;
  outflowSumLs: number;
  baselineResidualLs: number;
  expectedResidualLs: number;
  deviationLs: number;
  sigmaLs: number;
  z: number;
  /** Exceso mínimo detectable en este nodo con las lecturas actuales: max(minExcess, kσ). */
  detectionLimitLs: number;
  demandFactor: number;
  childPipeIds: string[];
}

export type PressureVerdict = 'consistent' | 'absent' | 'too_large' | 'not_discriminating' | 'not_applicable';

export interface PressureCorroboration {
  verdict: PressureVerdict;
  observedDropBar?: number;
  predictedDropBar?: number;
  ratio?: number;
  sigmaBar?: number;
  detail: string;
}

export interface ReachCandidate {
  pipeId: string;
  fromNodeId: string;
  toNodeId: string;
  lengthM: number;
}

export interface HydraulicFinding {
  nodeId: string;
  nodeName: string;
  level: 'flow_anomaly' | 'possible_leak' | 'localized_leak';
  excessLs: number;
  sigmaLs: number;
  z: number;
  estimatedLossM3PerDay: number;
  detectionLimitLs: number;
  candidates: ReachCandidate[];
  pressure: PressureCorroboration;
  photoConfirms: boolean;
  /** Evaluaciones consecutivas con exceso, incluida esta. */
  streak: number;
  alternatives: string[];
  rationale: string[];
}

export interface HydraulicDiagnosis {
  level: HydraulicLevel;
  findings: HydraulicFinding[];
  balances: BalanceAssessment[];
  demandFactor: { value: number; spread: number; leafIds: string[] } | null;
  meterInconsistencies: string[];
  limits: string[];
  assumptions: HydraulicAssumptions;
}

export interface DiagnoseOptions {
  assumptions?: Partial<HydraulicAssumptions>;
  /** Nodos cuya fotografía vinculada y ANALIZADA confirma una fuga. Una foto no analizada no se incluye aquí. */
  confirmingPhotoNodeIds?: string[];
  /** Racha previa de excesos por nodo (evaluaciones consecutivas anteriores). */
  streak?: Record<string, number>;
  /** Evaluaciones consecutivas exigidas para pasar de anomalía de caudal a posible fuga. */
  requiredConsecutive?: number;
}

const M_PER_BAR = 10.1972;
const BAR_PER_M = 1 / M_PER_BAR;
const LS_TO_M3_DAY = 86.4;

function headLossM(flowLs: number, pipe: PipeSegment, c: number): number {
  const q = Math.max(0, flowLs) / 1000;
  const d = pipe.diameterMm / 1000;
  return (10.67 * pipe.lengthM * Math.pow(q, 1.852)) / (Math.pow(pipe.hazenC ?? c, 1.852) * Math.pow(d, 4.8704));
}

const round = (v: number, d = 2) => Number(v.toFixed(d));
const sigmaFlow = (flow: number, rel: number) => Math.max(0.05, rel * Math.abs(flow));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface Topo {
  childrenOf: Map<string, PipeSegment[]>;
  parentPipeOf: Map<string, PipeSegment>;
}
function topo(nodes: NetworkNode[], pipes: PipeSegment[]): Topo {
  const childrenOf = new Map<string, PipeSegment[]>();
  const parentPipeOf = new Map<string, PipeSegment>();
  for (const n of nodes) childrenOf.set(n.id, []);
  for (const p of pipes) {
    childrenOf.get(p.from)?.push(p);
    parentPipeOf.set(p.to, p);
  }
  return { childrenOf, parentPipeOf };
}

/** Tuberías desde el tanque más cercano aguas arriba hasta el nodo, o null si no hay tanque aguas arriba (tramo bombeado). */
function pathFromTank(nodeId: string, t: Topo, byId: Map<string, NetworkNode>): { tank: NetworkNode; path: PipeSegment[] } | null {
  const path: PipeSegment[] = [];
  let current = nodeId;
  for (let guard = 0; guard < 64; guard++) {
    const parentPipe = t.parentPipeOf.get(current);
    if (!parentPipe) return null;
    path.unshift(parentPipe);
    const parent = byId.get(parentPipe.from);
    if (!parent) return null;
    if (parent.kind === 'tank') return { tank: parent, path };
    current = parent.id;
  }
  return null;
}

export function assessMassBalances(
  nodes: NetworkNode[],
  pipes: PipeSegment[],
  assumptionsIn: Partial<HydraulicAssumptions> = {}
): { balances: BalanceAssessment[]; demandFactor: HydraulicDiagnosis['demandFactor'] } {
  const A = { ...DEFAULT_HYDRAULIC_ASSUMPTIONS, ...assumptionsIn };
  const t = topo(nodes, pipes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const leaves = nodes.filter((n) => (t.childrenOf.get(n.id) ?? []).length === 0);
  const tsMs = (n: NetworkNode) => Date.parse(n.current.timestamp);

  const balances: BalanceAssessment[] = [];
  let reportedFactor: HydraulicDiagnosis['demandFactor'] = null;

  for (const a of nodes) {
    const childPipes = t.childrenOf.get(a.id) ?? [];
    if (childPipes.length === 0) continue;
    const children = childPipes.map((p) => byId.get(p.to)).filter((n): n is NetworkNode => Boolean(n));
    const reasons: string[] = [];

    if (a.kind === 'tank') reasons.push('Nodo con almacenamiento: el balance exige medir la salida y la variación de volumen, que no están disponibles.');
    for (const n of [a, ...children]) {
      if (n.status === 'fault') reasons.push(`El medidor de ${n.name} está marcado con falla de sensor.`);
      if (!finite(n.current.flowLs) || !finite(tsMs(n))) reasons.push(`${n.name}: lectura de caudal o fecha no válida.`);
    }
    if (children.length !== childPipes.length) reasons.push('Falta algún nodo hijo en la topología.');
    const ts = [a, ...children].map(tsMs);
    if (ts.every(finite) && Math.max(...ts) - Math.min(...ts) > A.syncToleranceMs) {
      reasons.push('Las lecturas del nodo y sus hijos no están sincronizadas (más de 15 min de diferencia).');
    }

    // Factor de demanda con las hojas medidas y sincronizadas con este nodo.
    const syncLeaves = leaves.filter(
      (l) => l.status !== 'fault' && finite(l.current.flowLs) && l.baseline.flowLs > 0 && finite(tsMs(l)) && finite(tsMs(a)) && Math.abs(tsMs(l) - tsMs(a)) <= A.syncToleranceMs
    );
    if (syncLeaves.length === 0) reasons.push('No hay consumos finales medidos y sincronizados para estimar el factor de demanda.');

    const baseOut = children.reduce((s, c) => s + c.baseline.flowLs, 0);
    const baselineResidual = Math.max(0, a.baseline.flowLs - baseOut);

    if (reasons.length > 0) {
      balances.push({
        nodeId: a.id,
        nodeName: a.name,
        state: 'not_evaluable',
        notEvaluableReasons: reasons,
        inflowLs: a.current.flowLs,
        outflowSumLs: children.reduce((s, c) => s + c.current.flowLs, 0),
        baselineResidualLs: round(baselineResidual),
        expectedResidualLs: round(baselineResidual),
        deviationLs: 0,
        sigmaLs: 0,
        z: 0,
        detectionLimitLs: 0,
        demandFactor: 1,
        childPipeIds: childPipes.map((p) => p.id),
      });
      continue;
    }

    const sumBase = syncLeaves.reduce((s, l) => s + l.baseline.flowLs, 0);
    const f = syncLeaves.reduce((s, l) => s + l.current.flowLs, 0) / sumBase;
    const spread = Math.max(...syncLeaves.map((l) => Math.abs(l.current.flowLs / l.baseline.flowLs - f)));
    reportedFactor = { value: round(f, 3), spread: round(spread, 3), leafIds: syncLeaves.map((l) => l.id) };

    const inflow = a.current.flowLs;
    const outflow = children.reduce((s, c) => s + c.current.flowLs, 0);
    const expected = f * baselineResidual;
    const deviation = inflow - outflow - expected;
    const sigmaDemand = baselineResidual * Math.sqrt(Math.pow(f * A.demandModelRelUncertainty, 2) + spread * spread);
    const sigma = Math.sqrt(
      Math.pow(sigmaFlow(inflow, A.meterRelUncertainty), 2) +
        children.reduce((s, c) => s + Math.pow(sigmaFlow(c.current.flowLs, A.meterRelUncertainty), 2), 0) +
        sigmaDemand * sigmaDemand
    );
    const z = sigma > 0 ? deviation / sigma : 0;
    const limit = Math.max(A.minExcessLs, A.kSigma * sigma);
    const state: BalanceState =
      z >= A.kSigma && deviation >= A.minExcessLs ? 'excess' : z <= -A.kSigma && deviation <= -A.minExcessLs ? 'deficit' : 'consistent';

    balances.push({
      nodeId: a.id,
      nodeName: a.name,
      state,
      notEvaluableReasons: [],
      inflowLs: round(inflow),
      outflowSumLs: round(outflow),
      baselineResidualLs: round(baselineResidual),
      expectedResidualLs: round(expected),
      deviationLs: round(deviation),
      sigmaLs: round(sigma),
      z: round(z),
      detectionLimitLs: round(limit),
      demandFactor: round(f, 3),
      childPipeIds: childPipes.map((p) => p.id),
    });
  }
  return { balances, demandFactor: reportedFactor };
}

function corroboratePressure(
  a: NetworkNode,
  excessLs: number,
  f: number,
  nodes: NetworkNode[],
  pipes: PipeSegment[],
  A: HydraulicAssumptions
): PressureCorroboration {
  const t = topo(nodes, pipes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const route = pathFromTank(a.id, t, byId);
  if (!route) {
    return {
      verdict: 'not_applicable',
      detail: 'Tramo aguas arriba del tanque (bombeo): no hay modelo de presión, así que la presión no puede corroborar ni descartar.',
    };
  }
  const { tank, path } = route;
  if (![a.current.pressureBar, a.baseline.pressureBar, tank.current.pressureBar, tank.baseline.pressureBar].every(finite)) {
    return { verdict: 'not_applicable', detail: 'Faltan lecturas de presión válidas en el nodo o en el tanque.' };
  }
  let demandLossM = 0;
  let leakLossM = 0;
  for (const p of path) {
    const baseQ = byId.get(p.to)!.baseline.flowLs;
    demandLossM += headLossM(f * baseQ, p, A.hazenWilliamsC) - headLossM(baseQ, p, A.hazenWilliamsC);
    leakLossM += headLossM(f * baseQ + excessLs, p, A.hazenWilliamsC) - headLossM(f * baseQ, p, A.hazenWilliamsC);
  }
  const tankShiftBar = tank.current.pressureBar - tank.baseline.pressureBar;
  const expectedNoLeak = a.baseline.pressureBar + tankShiftBar - demandLossM * BAR_PER_M;
  const observedDrop = expectedNoLeak - a.current.pressureBar;
  const predictedDrop = leakLossM * BAR_PER_M;
  const sigma = Math.sqrt(2) * A.pressureSigmaBar;

  const base = { observedDropBar: round(observedDrop, 3), predictedDropBar: round(predictedDrop, 3), sigmaBar: round(sigma, 3) };
  if (predictedDrop < A.kSigma * sigma) {
    return {
      verdict: 'not_discriminating',
      ...base,
      detail: `Un exceso de ${round(excessLs)} L/s solo bajaría la presión unos ${round(predictedDrop, 3)} bar, por debajo de ${round(A.kSigma * sigma, 3)} bar (${A.kSigma}σ de los transmisores): la presión no puede discriminar.`,
    };
  }
  const ratio = observedDrop / predictedDrop;
  if (observedDrop >= A.pressureRatioMin * predictedDrop && observedDrop >= 2 * sigma) {
    if (ratio <= A.pressureRatioMax) {
      return { verdict: 'consistent', ...base, ratio: round(ratio, 2), detail: `La presión bajó ${round(observedDrop, 3)} bar frente a ${round(predictedDrop, 3)} bar predichos para ese exceso de caudal (razón ${round(ratio, 2)}): coherente.` };
    }
    return {
      verdict: 'too_large',
      ...base,
      ratio: round(ratio, 2),
      detail: `La presión bajó ${round(observedDrop, 3)} bar, mucho más de lo que explica ese exceso de caudal (${round(predictedDrop, 3)} bar): puede haber una rotura mayor, una válvula parcialmente cerrada o una falla del transmisor.`,
    };
  }
  return {
    verdict: 'absent',
    ...base,
    ratio: round(ratio, 2),
    detail: `Se esperaba una caída de unos ${round(predictedDrop, 3)} bar y se observó ${round(observedDrop, 3)} bar: el exceso de caudal NO viene acompañado de la respuesta de presión de un caudal real adicional (sugiere deriva de medidor).`,
  };
}

export function diagnoseHydraulics(nodes: NetworkNode[], pipes: PipeSegment[], options: DiagnoseOptions = {}): HydraulicDiagnosis {
  const A: HydraulicAssumptions = { ...DEFAULT_HYDRAULIC_ASSUMPTIONS, ...(options.assumptions ?? {}) };
  const required = Math.max(1, options.requiredConsecutive ?? 1);
  const photoNodes = new Set(options.confirmingPhotoNodeIds ?? []);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { balances, demandFactor } = assessMassBalances(nodes, pipes, A);

  const findings: HydraulicFinding[] = [];
  const meterInconsistencies: string[] = [];

  for (const b of balances) {
    if (b.state === 'deficit') {
      meterInconsistencies.push(
        `${b.nodeName}: las salidas medidas superan a la entrada en ${Math.abs(b.deviationLs)} L/s respecto a lo esperado (±${b.sigmaLs}). Una fuga no explica eso: revisar calibración de medidores o una demanda que cayó.`
      );
    }
    if (b.state !== 'excess') continue;
    const a = byId.get(b.nodeId)!;
    const streak = (options.streak?.[b.nodeId] ?? 0) + 1;
    const pressure = corroboratePressure(a, b.deviationLs, b.demandFactor, nodes, pipes, A);
    const candidates: ReachCandidate[] = b.childPipeIds.map((id) => {
      const p = pipes.find((x) => x.id === id)!;
      return { pipeId: p.id, fromNodeId: p.from, toNodeId: p.to, lengthM: p.lengthM };
    });
    const photoConfirms = photoNodes.has(b.nodeId);

    const rationale: string[] = [
      `Entran ${b.inflowLs} L/s y salen ${b.outflowSumLs} L/s hacia ${candidates.map((c) => c.toNodeId).join(', ')}; con el factor de demanda ${b.demandFactor} se esperaba un residuo de ${b.expectedResidualLs} L/s (línea base ${b.baselineResidualLs} L/s).`,
      `Exceso de ${b.deviationLs} L/s con incertidumbre ±${b.sigmaLs} L/s (z = ${b.z}); límite de detección en este nodo: ${b.detectionLimitLs} L/s.`,
      pressure.detail,
    ];
    const alternatives = [
      'Deriva o error de calibración de un medidor de caudal.',
      'Demanda no uniforme: un consumo local mayor que el estimado con las hojas medidas.',
      'Consumo no medido o toma no autorizada.',
    ];

    let level: HydraulicFinding['level'] = 'flow_anomaly';
    if (streak < required) {
      rationale.push(`Pendiente de persistencia: ${streak} de ${required} evaluaciones consecutivas con exceso.`);
    } else if (pressure.verdict === 'consistent') {
      level = 'possible_leak';
    } else if ((pressure.verdict === 'not_applicable' || pressure.verdict === 'not_discriminating') && photoConfirms) {
      level = 'possible_leak';
      rationale.push('Una fotografía vinculada a este incidente y analizada por un proveedor de visión es compatible con una fuga.');
    } else if (pressure.verdict === 'absent') {
      rationale.push('Sin respuesta de presión coherente, el exceso se trata como anomalía de caudal y no como fuga.');
    } else if (pressure.verdict === 'too_large') {
      rationale.push('La caída de presión es incoherente con el caudal estimado; no se concluye fuga hasta resolver la discrepancia.');
    } else {
      rationale.push('La presión no puede corroborar este exceso; se necesita otra evidencia independiente (fotografía analizada, inspección, otro medidor).');
    }
    if (level === 'possible_leak' && candidates.length === 1) {
      level = 'localized_leak';
      rationale.push(`Un único tramo candidato entre dos medidores (${candidates[0].pipeId}). No se puede ubicar la fuga dentro del tramo ni distinguirla de una fuga en el propio nodo ${b.nodeName}.`);
    } else if (level === 'possible_leak') {
      rationale.push(`Hay ${candidates.length} tramos candidatos desde ${b.nodeName}: los medidores disponibles no los distinguen.`);
    }

    findings.push({
      nodeId: b.nodeId,
      nodeName: b.nodeName,
      level,
      excessLs: b.deviationLs,
      sigmaLs: b.sigmaLs,
      z: b.z,
      estimatedLossM3PerDay: round(b.deviationLs * LS_TO_M3_DAY, 1),
      detectionLimitLs: b.detectionLimitLs,
      candidates,
      pressure,
      photoConfirms,
      streak,
      alternatives,
      rationale,
    });
  }

  const rank: Record<HydraulicFinding['level'], number> = { flow_anomaly: 1, possible_leak: 2, localized_leak: 3 };
  findings.sort((x, y) => rank[y.level] - rank[x.level] || y.z - x.z);

  let level: HydraulicLevel;
  if (findings.length > 0) level = findings[0].level;
  else if (balances.length === 0 || balances.every((b) => b.state === 'not_evaluable')) level = 'insufficient_data';
  else level = 'no_anomaly';

  const limits = [
    'La resolución espacial es el tramo entre dos medidores: no se puede ubicar una fuga dentro del tramo ni distinguirla de una fuga en el propio nodo.',
    `La incertidumbre de los medidores (±${A.meterRelUncertainty * 100}%) y de los transmisores de presión (±${A.pressureSigmaBar} bar) son supuestos sin calibración de campo.`,
    'Los nodos con almacenamiento (tanques) no se evalúan: sin medir la salida ni el volumen no hay balance válido.',
    'Aguas arriba del tanque hay bombeo y no hay modelo de presión: allí una fuga no puede pasar de anomalía de caudal sin otra evidencia.',
    'El caudal perdido es una estimación del desbalance frente a un residuo de demanda estimado; la extrapolación a m³/día supone caudal constante.',
    ...balances.filter((b) => b.state === 'not_evaluable').map((b) => `${b.nodeName}: no evaluable. ${b.notEvaluableReasons.join(' ')}`),
  ];

  return { level, findings, balances, demandFactor, meterInconsistencies, limits, assumptions: A };
}

/** Resumen compatible con la concordancia y las plantillas de diagnóstico, para el nodo del incidente (o el hallazgo principal). */
export function toHydraulicEvidence(
  diagnosis: HydraulicDiagnosis,
  nodeId?: string
): (HydraulicEvidence & { estimatedLossM3PerDay?: number; reachLabels?: string[] }) | null {
  const finding = (nodeId ? diagnosis.findings.find((f) => f.nodeId === nodeId) : undefined) ?? (nodeId ? undefined : diagnosis.findings[0]);
  if (!finding) {
    return { level: nodeId ? (diagnosis.level === 'insufficient_data' ? 'insufficient_data' : 'no_anomaly') : diagnosis.level, limits: diagnosis.limits };
  }
  return {
    level: finding.level,
    excessLs: finding.excessLs,
    sigmaLs: finding.sigmaLs,
    candidatePipeIds: finding.candidates.map((c) => c.pipeId),
    estimatedLossM3PerDay: finding.estimatedLossM3PerDay,
    reachLabels: finding.candidates.map((c) => `${c.pipeId} (${c.fromNodeId} → ${c.toNodeId})`),
    limits: diagnosis.limits,
  };
}
