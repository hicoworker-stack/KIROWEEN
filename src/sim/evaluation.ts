import { diagnoseHydraulics, DiagnoseOptions, HydraulicDiagnosis } from '../core/hydraulicDiagnosis';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import { applyFrameToNodes, DEMO_NOISE, generateFrames, NoiseSpec, ScenarioEvent } from './scenarioGenerator';

/**
 * REQ-HYD-06: arnés de evaluación con VERDAD CONOCIDA.
 * Genera miles de fotogramas independientes (ruido sembrado), ejecuta el diagnóstico sobre cada uno y mide, contra la
 * verdad del generador: falsos positivos, sensibilidad, localización correcta y comportamiento ante demanda y deriva de medidor.
 *
 * Es una evaluación sobre DATOS SINTÉTICOS: mide si el detector se comporta como diseñado frente a un modelo físico
 * validado con EPANET. No mide su desempeño en una red real, que requiere datos de campo.
 */

export interface EvalRow {
  label: string;
  n: number;
  /** Fracción de fotogramas con cualquier hallazgo (anomalía de caudal o superior). */
  anyFinding: number;
  /** Fracción con posible fuga o fuga localizada. */
  leakConclusion: number;
  localized: number;
  /** Entre las fugas localizadas, fracción cuyo tramo candidato es el real (null si no hubo ninguna). */
  correctReach: number | null;
  /** Entre las conclusiones de fuga, fracción en el nodo correcto (null si no hubo ninguna). */
  correctNode: number | null;
  insufficient: number;
}

export interface EvalOptions {
  n?: number;
  seed?: number;
  noise?: NoiseSpec;
  diagnose?: DiagnoseOptions;
  /** Dónde está la fuga real, si la hay. */
  truth?: { pipeId: string; nodeId: string } | null;
}

const T0 = Date.parse('2026-11-19T12:00:00Z');

function oneFrameDiagnosis(events: ScenarioEvent[], seed: number, noise: NoiseSpec, diagnose?: DiagnoseOptions): HydraulicDiagnosis {
  const frames = generateFrames({
    seed,
    startMs: T0,
    stepMs: 60_000,
    steps: 1,
    noise,
    events: events.map((e) => ({ ...e, startStep: 0, ...(e.type === 'leak' ? { rampSteps: 1 } : {}) })),
  });
  return diagnoseHydraulics(applyFrameToNodes(createBaselineNodes(), frames[0]), NETWORK_PIPES, diagnose);
}

export function evaluateScenario(label: string, events: ScenarioEvent[], options: EvalOptions = {}): EvalRow {
  const n = options.n ?? 1000;
  const seed = options.seed ?? 1;
  const noise = options.noise ?? DEMO_NOISE;
  let any = 0;
  let leak = 0;
  let loc = 0;
  let reachOk = 0;
  let nodeOk = 0;
  let insufficient = 0;
  for (let i = 0; i < n; i++) {
    const d = oneFrameDiagnosis(events, seed * 100003 + i, noise, options.diagnose);
    if (d.findings.length > 0) any++;
    if (d.level === 'insufficient_data') insufficient++;
    if (d.level === 'possible_leak' || d.level === 'localized_leak') {
      leak++;
      if (options.truth && d.findings[0].nodeId === options.truth.nodeId) nodeOk++;
    }
    if (d.level === 'localized_leak') {
      loc++;
      if (options.truth && d.findings[0].candidates[0]?.pipeId === options.truth.pipeId) reachOk++;
    }
  }
  return {
    label,
    n,
    anyFinding: any / n,
    leakConclusion: leak / n,
    localized: loc / n,
    correctReach: loc > 0 && options.truth ? reachOk / loc : null,
    correctNode: leak > 0 && options.truth ? nodeOk / leak : null,
    insufficient: insufficient / n,
  };
}

/**
 * Secuencia de fotogramas con persistencia: la racha de excesos por nodo se acumula como lo hace el servidor.
 * Devuelve el nivel máximo alcanzado en la secuencia.
 */
export function runSequence(
  events: ScenarioEvent[],
  seed: number,
  steps: number,
  requiredConsecutive: number,
  noise: NoiseSpec = DEMO_NOISE
): { maxLevel: HydraulicDiagnosis['level']; levels: HydraulicDiagnosis['level'][] } {
  const frames = generateFrames({ seed, startMs: T0, stepMs: 60_000, steps, noise, events });
  let nodes = createBaselineNodes();
  const streak: Record<string, number> = {};
  const rank: Record<HydraulicDiagnosis['level'], number> = { insufficient_data: 0, no_anomaly: 1, flow_anomaly: 2, possible_leak: 3, localized_leak: 4 };
  const levels: HydraulicDiagnosis['level'][] = [];
  let max: HydraulicDiagnosis['level'] = 'no_anomaly';
  for (const fr of frames) {
    nodes = applyFrameToNodes(nodes, fr);
    const d = diagnoseHydraulics(nodes, NETWORK_PIPES, { streak, requiredConsecutive });
    for (const b of d.balances) streak[b.nodeId] = b.state === 'excess' ? (streak[b.nodeId] ?? 0) + 1 : 0;
    levels.push(d.level);
    if (rank[d.level] > rank[max]) max = d.level;
  }
  return { maxLevel: max, levels };
}

export function formatEvalTable(rows: EvalRow[]): string {
  const pct = (v: number | null) => (v === null ? '   n/d' : `${(v * 100).toFixed(1).padStart(5)}%`);
  const head = `${'Escenario'.padEnd(58)} ${'n'.padStart(5)} ${'hallazgo'.padStart(8)} ${'fuga'.padStart(7)} ${'localiz.'.padStart(8)} ${'tramo OK'.padStart(8)} ${'nodo OK'.padStart(8)} ${'datos<'.padStart(7)}`;
  return [head, ...rows.map((r) => `${r.label.padEnd(58)} ${String(r.n).padStart(5)} ${pct(r.anyFinding).padStart(8)} ${pct(r.leakConclusion).padStart(7)} ${pct(r.localized).padStart(8)} ${pct(r.correctReach).padStart(8)} ${pct(r.correctNode).padStart(8)} ${pct(r.insufficient).padStart(7)}`)].join('\n');
}
