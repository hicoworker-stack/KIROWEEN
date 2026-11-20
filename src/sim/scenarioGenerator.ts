import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import { NetworkNode, PipeSegment, ScenarioId, TelemetryReading } from '../core/types';
import { Leak, solveSteadyState } from './hydraulicModel';

/**
 * REQ-HYD-04: generador de escenarios SINTÉTICOS con verdad conocida.
 *
 * Es la única fuente de datos de los escenarios de demostración y de la evaluación del motor. El motor de diagnóstico
 * (src/core) no importa este módulo: recibe lecturas por la misma ruta que recibiría datos reales y no sabe qué evento las produjo.
 * Cada fotograma lleva la VERDAD (caudal de fuga real, factor de demanda) solo para evaluar, nunca para diagnosticar.
 *
 * Todo lo que sale de aquí es sintético y se marca `synthetic: true`, `source: 'scenario-generator'`.
 */

export interface NoiseSpec {
  /** Desviación típica relativa REAL del medidor de caudal (el motor asume una incertidumbre propia, que es otra cosa). */
  flowRel: number;
  pressureSigmaBar: number;
}

export type ScenarioEvent =
  | { type: 'leak'; pipeId: string; flowLs: number; startStep: number; rampSteps?: number }
  | { type: 'demand'; factor: number; startStep: number; nodeIds?: string[] }
  | { type: 'meter_bias'; nodeId: string; relBias: number; startStep: number }
  | { type: 'pressure_bias'; nodeId: string; biasBar: number; startStep: number }
  | { type: 'tank_head'; shiftM: number; startStep: number }
  | { type: 'valve_throttle'; nodeId: string; flowFactor: number; upstreamPressureBar: number; startStep: number }
  | { type: 'node_override'; nodeId: string; values: Partial<Pick<TelemetryReading, 'pressureBar' | 'flowLs' | 'levelPct' | 'turbidityNtu' | 'chlorineMgL' | 'ph' | 'valveState'>>; startStep: number };

export interface GeneratorSpec {
  seed: number;
  startMs: number;
  stepMs: number;
  steps: number;
  noise: NoiseSpec;
  events: ScenarioEvent[];
  nodes?: NetworkNode[];
  pipes?: PipeSegment[];
}

export interface FrameTruth {
  leakFlowLs: Record<string, number>;
  demandFactor: number;
  activeEvents: string[];
}

export interface GeneratedFrame {
  step: number;
  timestamp: string;
  readings: TelemetryReading[];
  truth: FrameTruth;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, 1 - rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const round = (v: number, d = 3) => Number(v.toFixed(d));

export function generateFrames(spec: GeneratorSpec): GeneratedFrame[] {
  const nodes = spec.nodes ?? createBaselineNodes();
  const pipes = spec.pipes ?? NETWORK_PIPES;
  const rng = mulberry32(spec.seed);
  const frames: GeneratedFrame[] = [];

  for (let step = 0; step < spec.steps; step++) {
    const timestamp = new Date(spec.startMs + step * spec.stepMs).toISOString();
    const active = spec.events.filter((e) => e.startStep <= step);

    let demandFactor = 1;
    const byNode: Record<string, number> = {};
    for (const e of active) {
      if (e.type !== 'demand') continue;
      if (e.nodeIds) for (const id of e.nodeIds) byNode[id] = (byNode[id] ?? 1) * e.factor;
      else demandFactor *= e.factor;
    }
    const leaks: Leak[] = active
      .filter((e): e is Extract<ScenarioEvent, { type: 'leak' }> => e.type === 'leak')
      .map((e) => {
        const ramp = Math.max(1, e.rampSteps ?? 1);
        const progress = Math.min(1, (step - e.startStep + 1) / ramp);
        return { pipeId: e.pipeId, nominalFlowLs: e.flowLs * progress };
      });
    const tankShift = active.filter((e) => e.type === 'tank_head').reduce((a, e) => a + (e as { shiftM: number }).shiftM, 0);

    // Estrangulamiento de válvula: se escala la demanda aguas abajo del nodo (caudal conservado) y se fija la presión previa.
    const throttles = active.filter((e): e is Extract<ScenarioEvent, { type: 'valve_throttle' }> => e.type === 'valve_throttle');
    for (const t of throttles) {
      const pipe = pipes.find((p) => p.to === t.nodeId);
      const subtree = new Set<string>();
      const stack = [t.nodeId];
      while (stack.length) {
        const id = stack.pop()!;
        subtree.add(id);
        for (const p of pipes.filter((x) => x.from === id)) stack.push(p.to);
      }
      void pipe;
      for (const id of subtree) byNode[id] = (byNode[id] ?? 1) * t.flowFactor;
    }

    const solved = solveSteadyState({ nodes, pipes, demandFactor, demandFactorByNode: byNode, leaks, tankHeadShiftM: tankShift });

    const readings: TelemetryReading[] = nodes.map((n) => {
      let flow = solved.inflowLs[n.id];
      let pressure = solved.pressureBar[n.id];
      for (const e of active) {
        if (e.type === 'meter_bias' && e.nodeId === n.id) flow *= 1 + e.relBias;
        if (e.type === 'pressure_bias' && e.nodeId === n.id) pressure += e.biasBar;
      }
      for (const t of throttles) if (t.nodeId === n.id) pressure = t.upstreamPressureBar;
      flow = Math.max(0, flow * (1 + spec.noise.flowRel * gaussian(rng)));
      pressure = Math.max(0, pressure + spec.noise.pressureSigmaBar * gaussian(rng));
      const jitter = (v: number, rel: number) => v * (1 + rel * gaussian(rng));
      const reading: TelemetryReading = {
        id: `GEN-${n.id}-${timestamp}`,
        timestamp,
        nodeId: n.id,
        pressureBar: round(pressure),
        flowLs: round(flow),
        levelPct: n.baseline.levelPct > 0 ? round(jitter(n.baseline.levelPct, 0.002), 1) : 0,
        turbidityNtu: round(Math.max(0.05, jitter(n.baseline.turbidityNtu, 0.01)), 2),
        chlorineMgL: round(Math.max(0.3, jitter(n.baseline.chlorineMgL, 0.01)), 2),
        ph: round(jitter(n.baseline.ph, 0.002), 2),
        synthetic: true,
        source: 'scenario-generator',
      };
      for (const t of throttles) if (t.nodeId === n.id) reading.valveState = 'throttled';
      for (const e of active) {
        if (e.type === 'node_override' && e.nodeId === n.id) Object.assign(reading, e.values);
      }
      return reading;
    });

    frames.push({
      step,
      timestamp,
      readings,
      truth: {
        leakFlowLs: { ...solved.leakFlowLs },
        demandFactor,
        activeEvents: active.map((e) => e.type),
      },
    });
  }
  return frames;
}

export const DEMO_SEED = 20261118;
export const DEMO_STEPS = 10;
export const DEMO_STEP_MS = 60_000;
export const DEMO_NOISE: NoiseSpec = { flowRel: 0.01, pressureSigmaBar: 0.02 };
/** Rotura sintética de la demostración: 12 L/s a presión nominal, en el tramo P-05 (lado del medidor N-TRON-04). */
export const DEMO_LEAK: Extract<ScenarioEvent, { type: 'leak' }> = { type: 'leak', pipeId: 'P-05', flowLs: 12, startStep: 4, rampSteps: 3 };

/** Eventos de cada escenario. Los tres no hidráulicos usan valores puntuales fijados a mano (no derivados de física). */
export function scenarioEvents(id: ScenarioId): ScenarioEvent[] {
  const last = DEMO_STEPS - 1;
  switch (id) {
    case 'leak':
      return [DEMO_LEAK];
    case 'obstruction':
      return [{ type: 'valve_throttle', nodeId: 'N-VALV-05', flowFactor: 8.4 / 18.4, upstreamPressureBar: 5.29, startStep: last }];
    case 'sensor_fault':
      return [{ type: 'node_override', nodeId: 'N-TANQ-03', values: { pressureBar: 4.9, flowLs: 0, levelPct: 81, turbidityNtu: -1.4 }, startStep: last }];
    case 'contamination':
      return [{ type: 'node_override', nodeId: 'N-TOMA-01', values: { turbidityNtu: 14.8, chlorineMgL: 0.16, ph: 6.2, levelPct: 88 }, startStep: last }];
  }
}

/** Fotogramas de un escenario de demostración, terminando en `nowMs`. Determinista salvo por las marcas de tiempo. */
export function buildScenarioFrames(id: ScenarioId, nowMs: number): GeneratedFrame[] {
  return generateFrames({
    seed: DEMO_SEED,
    startMs: nowMs - (DEMO_STEPS - 1) * DEMO_STEP_MS,
    stepMs: DEMO_STEP_MS,
    steps: DEMO_STEPS,
    noise: DEMO_NOISE,
    events: scenarioEvents(id),
  });
}

/** Coloca las lecturas de un fotograma como lectura actual de cada nodo (para pruebas y evaluaci�n; el servidor usa la ingesta). */
export function applyFrameToNodes(nodes: NetworkNode[], frame: GeneratedFrame): NetworkNode[] {
  const byNode = new Map(frame.readings.map((r) => [r.nodeId, r]));
  return nodes.map((n) => (byNode.has(n.id) ? { ...n, current: byNode.get(n.id)! } : n));
}
