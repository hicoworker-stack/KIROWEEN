import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';

/**
 * Modelo de la maqueta 3D del Inicio: un ejemplo SIMULADO de «fuga en la troncal» sobre la red de demostración.
 * Es didáctico y determinista: no lo usa ningún detector ni se mezcla con lecturas reales.
 *
 *  - Las demandas se cumplen mientras haya presión (modelo guiado por demanda).
 *  - Pérdidas por tramo con el exponente de Hazen-Williams (h ∝ Q^1,852), calibradas para la operación normal.
 *  - La fuga está en el tramo P-05 a LEAK_AT de su longitud: aguas arriba pasa la demanda más la fuga; aguas abajo, solo la demanda.
 *  - El balance de masa compara lo que entra en N-TRON-04 con lo que llega a N-DIST-06 y solo afirma una fuga si la diferencia
 *    supera dos veces la incertidumbre de los medidores.
 */

export type SimPhase = 'normal' | 'leak' | 'detect' | 'repair' | 'verified';
export type SimTone = 'ok' | 'attention' | 'critical' | 'offline';

export const SIM_PHASES: ReadonlyArray<{ id: SimPhase; label: string; title: string }> = [
  { id: 'normal', label: 'Operación normal', title: 'La red funciona por gravedad' },
  { id: 'leak', label: 'Aparece una fuga', title: 'Una unión cede bajo tierra' },
  { id: 'detect', label: 'Detección', title: 'El balance de agua no cuadra' },
  { id: 'repair', label: 'Reparación', title: 'Orden de trabajo en campo' },
  { id: 'verified', label: 'Verificación', title: 'Recuperación medida' },
];

export const LEAK_PIPE = 'P-05';
/** Posición de la fuga a lo largo de P-05 (0 = N-TRON-04, 1 = N-DIST-06). */
export const LEAK_AT = 0.4;
/** Incertidumbre combinada de los dos medidores de caudal (L/s). */
export const METER_UNCERTAINTY_LPS = 0.4;
export const LEAK_RANGE = { min: 0.2, max: 4, step: 0.1, initial: 2.5 } as const;

const DEMAND_LPS = { school: 6, barrio: 4 } as const;
/** Altura de agua a la salida del tanque (m de columna de agua). */
const TANK_HEAD_M = 34;
/** Caída de presión de cada tramo en operación normal (m) y su caudal de referencia (L/s). */
const DROP: Record<'P-03' | 'P-04' | 'P-05' | 'P-06', { m: number; atLps: number }> = {
  'P-03': { m: 4, atLps: DEMAND_LPS.school },
  'P-04': { m: 5, atLps: DEMAND_LPS.barrio },
  'P-05': { m: 4, atLps: DEMAND_LPS.school },
  'P-06': { m: 4, atLps: DEMAND_LPS.barrio },
};
const headLoss = (pipe: keyof typeof DROP, q: number) => DROP[pipe].m * Math.pow(Math.max(0, q) / DROP[pipe].atLps, 1.852);

const NAMES: Record<string, string> = Object.fromEntries(createBaselineNodes().map((n) => [n.id, n.name]));

/** Disposición de la maqueta en el plano (x, z). Las tuberías van enterradas; sus vértices son codos. */
export interface SimNode {
  id: string;
  name: string;
  role: string;
  pos: [number, number];
  /** Dónde está el poste del sensor (puede no coincidir con el edificio). */
  sensor: [number, number];
}

const LAYOUT: Array<Omit<SimNode, 'name'>> = [
  { id: 'N-TOMA-01', role: 'Capta el agua de la quebrada.', pos: [-10, -4], sensor: [-9.2, -3.1] },
  { id: 'N-PLANTA-02', role: 'Filtra y desinfecta el agua antes de almacenarla.', pos: [-6.5, -4.5], sensor: [-5.3, -3.4] },
  { id: 'N-TANQ-03', role: 'Tanque elevado: abastece toda la red por gravedad.', pos: [-2, -1], sensor: [-0.9, 0.1] },
  { id: 'N-TRON-04', role: 'Medidor de caudal y presión a la entrada del tramo P-05.', pos: [3, -3], sensor: [3, -3] },
  { id: 'N-VALV-05', role: 'Cámara de válvulas del ramal sur.', pos: [2.5, 3.5], sensor: [2.5, 3.5] },
  { id: 'N-DIST-06', role: 'Escuela y centro de salud. Medidor de entrega al final del tramo P-05.', pos: [9.5, -3], sensor: [8.2, -1.9] },
  { id: 'N-DIST-07', role: 'Ramal residencial del barrio.', pos: [8.5, 4], sensor: [7.1, 2.9] },
];
export const SIM_NODES: ReadonlyArray<SimNode> = LAYOUT.map((n) => ({ ...n, name: NAMES[n.id] ?? n.id }));

export const SIM_PIPE_PATHS: Record<string, Array<[number, number]>> = {
  'P-01': [[-10, -4], [-8.2, -4], [-8.2, -4.5], [-6.5, -4.5]],
  'P-02': [[-6.5, -4.5], [-4, -4.5], [-4, -1], [-2, -1]],
  'P-03': [[-2, -1], [0.5, -1], [0.5, -3], [3, -3]],
  'P-04': [[-2, -1], [-2, 3.5], [2.5, 3.5]],
  'P-05': [[3, -3], [9.5, -3]],
  'P-06': [[2.5, 3.5], [5, 3.5], [5, 4], [8.5, 4]],
};

export const SIM_PIPES = NETWORK_PIPES.filter((p) => SIM_PIPE_PATHS[p.id]).map((p) => ({ id: p.id, from: p.from, to: p.to, diameterMm: p.diameterMm, lengthM: p.lengthM, material: p.material }));

export interface SimReading {
  nodeId: string;
  /** Presión en metros de columna de agua; null donde el punto no mide presión. */
  pressureM: number | null;
  flowLps: number;
  tone: SimTone;
  statusLabel: string;
  note?: string;
}

export interface SimResult {
  phase: SimPhase;
  leakLps: number;
  leakActive: boolean;
  /** Válvula de N-TRON-04 cerrada para reparar: el tramo P-05 queda aislado. */
  isolated: boolean;
  repaired: boolean;
  readings: Record<string, SimReading>;
  /** Caudal por tramo; en P-05 «up» va antes de la fuga y «down» después. */
  pipes: Record<string, { up: number; down: number }>;
  balance: { inflowLps: number; deliveredLps: number; missingLps: number; uncertaintyLps: number; detectable: boolean };
}

const NORMAL_PRESSURE: Record<string, number> = {
  'N-TANQ-03': TANK_HEAD_M,
  'N-TRON-04': TANK_HEAD_M - DROP['P-03'].m,
  'N-VALV-05': TANK_HEAD_M - DROP['P-04'].m,
  'N-DIST-06': TANK_HEAD_M - DROP['P-03'].m - DROP['P-05'].m,
  'N-DIST-07': TANK_HEAD_M - DROP['P-04'].m - DROP['P-06'].m,
};

const TONE_LABEL: Record<SimTone, string> = { ok: 'Normal', attention: 'Atención', critical: 'Crítico', offline: 'Sin servicio' };

function toneFor(nodeId: string, pressure: number): SimTone {
  const drop = (NORMAL_PRESSURE[nodeId] ?? pressure) - pressure;
  if (drop >= 5) return 'critical';
  if (drop >= 1.5) return 'attention';
  return 'ok';
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function clampLeak(v: number): number {
  if (!Number.isFinite(v)) return LEAK_RANGE.initial;
  return round1(Math.min(LEAK_RANGE.max, Math.max(LEAK_RANGE.min, v)));
}

export function computeSim(phase: SimPhase, leakInput: number): SimResult {
  const leakLps = clampLeak(leakInput);
  const leakActive = phase === 'leak' || phase === 'detect';
  const isolated = phase === 'repair';
  const q = leakActive ? leakLps : 0;

  const school = isolated ? 0 : DEMAND_LPS.school;
  const barrio = DEMAND_LPS.barrio;
  const p05up = isolated ? 0 : school + q;
  const p05down = school;
  const p03 = p05up;
  const p04 = barrio;
  const p06 = barrio;
  const p02 = p03 + p04;
  const p01 = p02;

  const pTron = TANK_HEAD_M - headLoss('P-03', p03);
  const pSchool = pTron - LEAK_AT * headLoss('P-05', p05up) - (1 - LEAK_AT) * headLoss('P-05', p05down);
  const pValv = TANK_HEAD_M - headLoss('P-04', p04);
  const pBarrio = pValv - headLoss('P-06', p06);

  const r = (nodeId: string, pressureM: number | null, flowLps: number, override?: { tone: SimTone; statusLabel?: string; note?: string }): SimReading => {
    const tone = override?.tone ?? (pressureM === null ? 'ok' : toneFor(nodeId, pressureM));
    return { nodeId, pressureM: pressureM === null ? null : round1(pressureM), flowLps: round1(flowLps), tone, statusLabel: override?.statusLabel ?? TONE_LABEL[tone], note: override?.note };
  };

  const readings: Record<string, SimReading> = {
    'N-TOMA-01': r('N-TOMA-01', null, p01),
    'N-PLANTA-02': r('N-PLANTA-02', null, p02),
    'N-TANQ-03': r('N-TANQ-03', TANK_HEAD_M, p03 + p04),
    'N-TRON-04': isolated
      ? r('N-TRON-04', pTron, p03, { tone: 'attention', statusLabel: 'Válvula cerrada', note: 'Cerrada para aislar el tramo P-05 durante la reparación.' })
      : r('N-TRON-04', pTron, p03),
    'N-VALV-05': r('N-VALV-05', pValv, p04),
    'N-DIST-06': isolated ? r('N-DIST-06', 0, 0, { tone: 'offline', note: 'Sin servicio mientras dura la intervención.' }) : r('N-DIST-06', pSchool, p05down),
    'N-DIST-07': r('N-DIST-07', pBarrio, p06),
  };

  const inflowLps = round1(p03);
  const deliveredLps = round1(p05down);
  const missingLps = round1(inflowLps - deliveredLps);
  const balance = { inflowLps, deliveredLps, missingLps, uncertaintyLps: METER_UNCERTAINTY_LPS, detectable: missingLps > 2 * METER_UNCERTAINTY_LPS };

  return {
    phase,
    leakLps,
    leakActive,
    isolated,
    repaired: phase === 'repair' || phase === 'verified',
    readings,
    pipes: {
      'P-01': { up: p01, down: p01 },
      'P-02': { up: p02, down: p02 },
      'P-03': { up: p03, down: p03 },
      'P-04': { up: p04, down: p04 },
      'P-05': { up: p05up, down: p05down },
      'P-06': { up: p06, down: p06 },
    },
    balance,
  };
}

export const fmt1 = (v: number) => v.toLocaleString('es', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Explicación de cada paso, con las cifras del estado actual. */
export function phaseText(sim: SimResult): string {
  const school = sim.readings['N-DIST-06'];
  const b = sim.balance;
  switch (sim.phase) {
    case 'normal':
      return `El tanque Mirador abastece la red por gravedad. Lo que entra en la Troncal Norte (${fmt1(b.inflowLps)} L/s) llega completo a la escuela y al centro de salud, con ${fmt1(school.pressureM ?? 0)} m de presión.`;
    case 'leak':
      return `Una unión del tramo P-05 (HDPE, 110 mm) cede bajo la calle y pierde ${fmt1(sim.leakLps)} L/s en el suelo. La presión en la escuela baja a ${fmt1(school.pressureM ?? 0)} m. Los sensores registran la caída, pero ella sola no dice dónde está el problema.`;
    case 'detect':
      return b.detectable
        ? `Aqua Sentinel compara los dos medidores: entran ${fmt1(b.inflowLps)} L/s en la Troncal y llegan ${fmt1(b.deliveredLps)} L/s a la escuela. Faltan ${fmt1(b.missingLps)} ± ${fmt1(b.uncertaintyLps)} L/s, así que la pérdida está entre ambos: el tramo candidato es P-05.`
        : `Con ${fmt1(sim.leakLps)} L/s la diferencia entre medidores (${fmt1(b.missingLps)} L/s) cabe en su incertidumbre (± ${fmt1(b.uncertaintyLps)} L/s). Aqua Sentinel no afirma una fuga sin evidencia suficiente: aumenta el tamaño de la fuga para ver cuándo se vuelve detectable.`;
    case 'repair':
      return 'Una persona acepta la recomendación y se crea la orden de trabajo. Se cierra la válvula de la Troncal, la cuadrilla excava y coloca una abrazadera de reparación. La escuela queda sin servicio durante la intervención.';
    case 'verified':
      return `Se reabre la válvula. La presión en la escuela vuelve a ${fmt1(school.pressureM ?? 0)} m y el balance se cierra (${fmt1(b.missingLps)} ± ${fmt1(b.uncertaintyLps)} L/s). La recuperación consta como medida, no supuesta, y queda sellada en el registro.`;
  }
}
