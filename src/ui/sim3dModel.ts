import type { HydraulicLevel } from '../core/hydraulicDiagnosis';
import type { LeakPreview, PreviewSnapshot } from '../core/leakPreview';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import type { RepairAssessment, RepairOutcome } from '../core/repairVerification';
import type { PreviewEngine } from '../core/leakPreview';
import { live, t } from './i18n';
import { explainRepair } from './repairView';

/**
 * REQ-SIM-01: modelo de presentación de la maqueta 3D de Inicio.
 *
 * Aquí NO hay física ni umbrales: lo que se dibuja y lo que se lee sale de un LeakPreview, que calculan los motores reales en el
 * servidor (solver hidráulico, diagnóstico hidráulico, reglas de nodo y verificación de la reparación). Este módulo solo decide
 * qué instantánea corresponde a cada paso y redacta lo que el motor concluyó, con sus números.
 */

export type SimPhase = 'normal' | 'leak' | 'detect' | 'repair' | 'verified';
export type SimTone = 'ok' | 'attention' | 'critical' | 'offline';

export const SIM_PHASES: ReadonlyArray<{ id: SimPhase; readonly label: string; readonly title: string }> = [
  { id: 'normal', get label() { return t('Operación normal', 'Normal operation'); }, get title() { return t('La red funciona por gravedad', 'The network runs by gravity'); } },
  { id: 'leak', get label() { return t('Anomalía', 'Anomaly'); }, get title() { return t('Los sensores notan algo raro', 'The sensors notice something odd'); } },
  { id: 'detect', get label() { return t('Investigación', 'Investigation'); }, get title() { return t('El balance de agua entra en juego', 'The water balance comes into play'); } },
  { id: 'repair', get label() { return t('Intervención', 'Intervention'); }, get title() { return t('Orden de trabajo en campo', 'Work order in the field'); } },
  { id: 'verified', get label() { return t('Verificación', 'Verification'); }, get title() { return t('Solo cuentan las mediciones posteriores', 'Only later measurements count'); } },
];

export const LEAK_PIPE = 'P-05';
/** Dónde está la fuga a lo largo de P-05 en la maqueta (0 = N-TRON-04, 1 = N-DIST-06). Es la verdad SIMULADA: el motor solo llega al tramo. */
export const LEAK_AT = 0.4;

const NAMES: Record<string, string> = Object.fromEntries(createBaselineNodes().map((n) => [n.id, n.name]));

export interface SimNode {
  id: string;
  name: string;
  readonly role: string;
  pos: [number, number];
  /** Dónde está el poste del sensor (puede no coincidir con el edificio). */
  sensor: [number, number];
}
const LAYOUT: Array<Omit<SimNode, 'name' | 'role'> & { readonly role: string }> = [
  { id: 'N-TOMA-01', get role() { return t('Capta el agua de la quebrada.', 'Draws water from the stream.'); }, pos: [-10, -4], sensor: [-9.2, -3.1] },
  { id: 'N-PLANTA-02', get role() { return t('Filtra y desinfecta el agua antes de almacenarla.', 'Filters and disinfects the water before it is stored.'); }, pos: [-6.5, -4.5], sensor: [-5.3, -3.4] },
  { id: 'N-TANQ-03', get role() { return t('Tanque elevado: abastece toda la red por gravedad.', 'Elevated tank: feeds the whole network by gravity.'); }, pos: [-2, -1], sensor: [-0.9, 0.1] },
  { id: 'N-TRON-04', get role() { return t('Medidor de caudal y presión a la entrada del tramo P-05.', 'Flow and pressure meter at the inlet of reach P-05.'); }, pos: [3, -3], sensor: [3, -3] },
  { id: 'N-VALV-05', get role() { return t('Cámara de válvulas del ramal sur.', 'Valve chamber of the south branch.'); }, pos: [2.5, 3.5], sensor: [2.5, 3.5] },
  { id: 'N-DIST-06', get role() { return t('Escuela y centro de salud, al final del tramo P-05.', 'School and health center, at the end of reach P-05.'); }, pos: [9.5, -3], sensor: [8.2, -1.9] },
  { id: 'N-DIST-07', get role() { return t('Ramal residencial del barrio.', 'Residential branch of the neighborhood.'); }, pos: [8.5, 4], sensor: [7.1, 2.9] },
];
export const SIM_NODES: ReadonlyArray<SimNode> = LAYOUT.map((n) => Object.defineProperties({ id: n.id, name: NAMES[n.id] ?? n.id, pos: n.pos, sensor: n.sensor } as SimNode, { role: { get: () => n.role, enumerable: true } }));

/** Recorrido de cada tubería en la maqueta (plano x, z). Los tramos y sus materiales y diámetros vienen de la red de demostración. */
export const SIM_PIPE_PATHS: Record<string, Array<[number, number]>> = {
  'P-01': [[-10, -4], [-8.2, -4], [-8.2, -4.5], [-6.5, -4.5]],
  'P-02': [[-6.5, -4.5], [-4, -4.5], [-4, -1], [-2, -1]],
  'P-03': [[-2, -1], [0.5, -1], [0.5, -3], [3, -3]],
  'P-04': [[-2, -1], [-2, 3.5], [2.5, 3.5]],
  'P-05': [[3, -3], [9.5, -3]],
  'P-06': [[2.5, 3.5], [5, 3.5], [5, 4], [8.5, 4]],
};
export const SIM_PIPES = NETWORK_PIPES.filter((p) => SIM_PIPE_PATHS[p.id]).map((p) => ({ id: p.id, from: p.from, to: p.to, diameterMm: p.diameterMm, lengthM: p.lengthM, material: p.material }));

const locale = () => (t('es', 'en') === 'en' ? 'en-US' : 'es');
export const fmt1 = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmt2 = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const ENGINE_LEVEL_LABEL: Record<HydraulicLevel, string> = live(() => ({
  insufficient_data: t('Datos insuficientes', 'Insufficient data'),
  no_anomaly: t('Sin anomalía', 'No anomaly'),
  flow_anomaly: t('Anomalía de caudal (sin concluir fuga)', 'Flow anomaly (no leak concluded)'),
  possible_leak: t('Posible fuga', 'Possible leak'),
  localized_leak: t('Fuga localizada en un tramo', 'Leak localized to a reach'),
}));
export const OUTCOME_LABEL: Record<RepairOutcome, string> = live(() => ({
  PENDING: t('Pendiente', 'Pending'),
  INCONCLUSIVE: t('No concluyente', 'Inconclusive'),
  VERIFIED: t('Reparación verificada', 'Repair verified'),
  REOPENED: t('Caso reabierto', 'Case reopened'),
}));
const ruleLabel = (rule: string): string =>
  ({ PRESSURE_DROP_LEAK: t('Regla: caída de presión con más caudal', 'Rule: pressure drop with more flow'), FLOW_OBSTRUCTION: t('Regla: caudal bajo con presión alta', 'Rule: low flow with high pressure') })[rule] ??
  rule.replace('balance hidráulico: ', t('Balance hidráulico: ', 'Hydraulic balance: '));
const toneLabel = (tone: SimTone): string => ({ ok: t('Normal', 'Normal'), attention: t('Atención', 'Attention'), critical: t('Crítico', 'Critical'), offline: t('Sin servicio', 'Out of service') })[tone];

export interface SimReading {
  nodeId: string;
  pressureBar: number;
  flowLs: number;
  baselinePressureBar: number;
  baselineFlowLs: number;
  tone: SimTone;
  statusLabel: string;
  note?: string;
}

export interface SimResult {
  phase: SimPhase;
  /** Fuga real de la simulación en este paso (L/s). */
  leakLps: number;
  leakActive: boolean;
  /** Válvula de N-TRON-04 cerrada durante la intervención. */
  isolated: boolean;
  repaired: boolean;
  /** Veredicto de la reparación; solo existe en el paso de verificación. */
  verdict: RepairOutcome | null;
  readings: Record<string, SimReading>;
  /** Caudal de cada tramo; en P-05 «up» va antes de la fuga y «down» después. */
  pipes: Record<string, { up: number; down: number }>;
  engine: PreviewEngine;
  repair: RepairAssessment;
}

function readingsOf(snap: PreviewSnapshot, overrides: Record<string, Partial<SimReading>> = {}): Record<string, SimReading> {
  const out: Record<string, SimReading> = {};
  for (const [id, n] of Object.entries(snap.nodes)) {
    const tone: SimTone = n.tone;
    out[id] = {
      nodeId: id,
      pressureBar: n.pressureBar,
      flowLs: n.flowLs,
      baselinePressureBar: n.baselinePressureBar,
      baselineFlowLs: n.baselineFlowLs,
      tone,
      statusLabel: toneLabel(tone),
      note: n.rule ? ruleLabel(n.rule) : undefined,
      ...overrides[id],
    };
  }
  return out;
}

function pipeFlows(snap: PreviewSnapshot, isolated: boolean): SimResult['pipes'] {
  const out: SimResult['pipes'] = {};
  for (const p of SIM_PIPES) {
    const down = snap.nodes[p.to]?.flowLs ?? 0;
    out[p.id] = { up: p.id === LEAK_PIPE ? down + snap.truthLeakLps : down, down };
  }
  if (isolated) out[LEAK_PIPE] = { up: 0, down: 0 };
  return out;
}

/** Qué instantánea del motor corresponde a cada paso de la maqueta. */
export function buildSimView(phase: SimPhase, preview: LeakPreview): SimResult {
  const isolated = phase === 'repair';
  const snap = phase === 'normal' ? preview.normal : phase === 'verified' ? preview.after : preview.leak;
  const overrides: Record<string, Partial<SimReading>> = isolated
    ? {
        'N-TRON-04': { tone: 'attention', statusLabel: t('Válvula cerrada', 'Valve closed'), note: t('Cerrada para aislar el tramo P-05 durante la reparación.', 'Closed to isolate reach P-05 during the repair.') },
        'N-DIST-06': { tone: 'offline', statusLabel: toneLabel('offline'), pressureBar: 0, flowLs: 0, note: t('Sin servicio mientras dura la intervención.', 'Out of service during the intervention.') },
      }
    : {};
  const verdict = phase === 'verified' ? preview.repair.outcome : null;
  if (phase === 'verified' && verdict !== 'VERIFIED') {
    // Hasta que el motor lo verifica, el punto no se presenta como recuperado: aunque las lecturas sean buenas, queda «en verificación».
    const meter = 'N-TRON-04';
    overrides[meter] = verdict === 'REOPENED' ? {} : { tone: 'attention', statusLabel: t('En verificación', 'Being verified'), note: t('Aún no hay evidencia suficiente para confirmar la recuperación.', 'There is not enough evidence yet to confirm recovery.') };
  }
  return {
    phase,
    leakLps: isolated ? 0 : snap.truthLeakLps,
    leakActive: !isolated && snap.truthLeakLps > 0.05,
    isolated,
    repaired: isolated || (phase === 'verified' && verdict !== 'REOPENED'),
    verdict,
    readings: readingsOf(snap, overrides),
    pipes: pipeFlows(snap, isolated),
    engine: preview.engine,
    repair: preview.repair,
  };
}

/** Cifras del balance del motor, listas para mostrar. */
export function engineSummary(e: PreviewEngine): string {
  if (!e.balance) return t('El motor no pudo evaluar el balance de agua con las lecturas disponibles.', 'The engine could not assess the water balance with the available readings.');
  const b = e.balance;
  return t(`exceso de ${fmt1(b.excessLs)} ± ${fmt1(b.sigmaLs)} L/s (el motor exige superar ${fmt1(b.detectionLimitLs)} L/s)`, `excess of ${fmt1(b.excessLs)} ± ${fmt1(b.sigmaLs)} L/s (the engine requires more than ${fmt1(b.detectionLimitLs)} L/s)`);
}

/** Explicación de cada paso con lo que los motores concluyeron. */
export function phaseText(sim: SimResult, preview: LeakPreview): string {
  const school = preview.normal.nodes['N-DIST-06'];
  const tron = preview.normal.nodes['N-TRON-04'];
  const e = sim.engine;
  const leakSchool = preview.leak.nodes['N-DIST-06'];
  const leakTron = preview.leak.nodes['N-TRON-04'];
  const reach = e.candidatePipeIds.join(', ');
  switch (sim.phase) {
    case 'normal':
      return t(
        `El tanque Mirador abastece la red por gravedad. La Troncal mide ${fmt1(tron.flowLs)} L/s y la escuela tiene ${fmt2(school.pressureBar)} bar. El balance de agua cierra: el motor no ve ninguna anomalía.`,
        `The Mirador tank feeds the network by gravity. The trunk main reads ${fmt1(tron.flowLs)} L/s and the school has ${fmt2(school.pressureBar)} bar. The water balance closes: the engine sees no anomaly.`
      );
    case 'leak':
      return preview.leak.truthLeakLps < 0.05
        ? t('Con 0 L/s no hay fuga: nada cambia en los sensores. Sube el tamaño de la fuga para ver qué hace el motor.', 'At 0 L/s there is no leak: nothing changes in the sensors. Increase the leak size to see what the engine does.')
        : t(
            `En la simulación, una unión del tramo P-05 cede bajo la calle y pierde ${fmt1(preview.leak.truthLeakLps)} L/s (el motor no lo sabe: solo ve lecturas). La presión en la escuela baja de ${fmt2(school.pressureBar)} a ${fmt2(leakSchool.pressureBar)} bar y la Troncal mide ${fmt1(leakTron.flowLs)} L/s en vez de ${fmt1(tron.flowLs)}. Un valor suelto no dice dónde ni cuánto.`,
            `In the simulation, a joint on reach P-05 gives way under the street and loses ${fmt1(preview.leak.truthLeakLps)} L/s (the engine does not know that: it only sees readings). Pressure at the school drops from ${fmt2(school.pressureBar)} to ${fmt2(leakSchool.pressureBar)} bar and the trunk main reads ${fmt1(leakTron.flowLs)} L/s instead of ${fmt1(tron.flowLs)}. A single value does not say where or how much.`
          );
    case 'detect':
      if (e.level === 'localized_leak' || e.level === 'possible_leak') {
        const localized = e.level === 'localized_leak';
        return t(
          `El motor compara lo que entra con lo que sale: ${engineSummary(e)}. La presión baja tanto como predice la hidráulica, así que concluye ${localized ? 'una fuga localizada' : 'una posible fuga'} en ${reach || 'la red'}. Solo llega al tramo entre dos medidores, no al metro exacto.`,
          `The engine compares what goes in with what comes out: ${engineSummary(e)}. Pressure drops as much as the hydraulics predict, so it concludes ${localized ? 'a localized leak' : 'a possible leak'} in ${reach || 'the network'}. It only gets to the reach between two meters, not to the exact meter.`
        );
      }
      if (e.level === 'flow_anomaly') {
        return t(
          `El balance muestra un ${engineSummary(e)}, pero la presión no permite distinguir una fuga de un medidor desviado o de más consumo. El motor lo informa como anomalía de caudal y NO afirma que haya una fuga.`,
          `The balance shows an ${engineSummary(e)}, but pressure cannot tell a leak from a drifting meter or higher consumption. The engine reports it as a flow anomaly and does NOT claim there is a leak.`
        );
      }
      return e.balance
        ? t(
            `El balance da un ${engineSummary(e)}: no lo supera, así que el motor no afirma nada. Una fuga así de pequeña es indistinguible del ruido de los medidores.`,
            `The balance gives an ${engineSummary(e)}: it does not exceed it, so the engine claims nothing. A leak this small cannot be told apart from meter noise.`
          )
        : t('El motor no tiene datos suficientes para evaluar el balance de agua.', 'The engine does not have enough data to assess the water balance.');
    case 'repair':
      return t(
        'Una persona acepta la recomendación y se crea la orden de trabajo. Se cierra la válvula, se excava y se coloca una abrazadera; la escuela queda sin servicio mientras tanto. Cerrar la orden no demuestra que funcionó: falta verificarlo con mediciones posteriores.',
        'A person accepts the recommendation and the work order is created. The valve is closed, the street is excavated and a clamp is fitted; the school is out of service meanwhile. Closing the order does not prove it worked: it still has to be verified with later measurements.'
      );
    case 'verified': {
      const r = sim.repair;
      const why = explainRepair(r);
      if (r.outcome === 'VERIFIED') {
        return t(
          `${why} El motor declara la reparación VERIFICADA y sella el veredicto, con esas lecturas, en el Trust Ledger.`,
          `${why} The engine declares the repair VERIFIED and seals the verdict, with those readings, in the Trust Ledger.`
        );
      }
      if (r.outcome === 'REOPENED') return t(`La fuga continúa: ${why} El motor reabre el caso y no presenta el punto como recuperado.`, `The leak continues: ${why} The engine reopens the case and does not show the point as recovered.`);
      return t(
        `${why} El motor no concluye: el punto sigue «en verificación» y nunca se declara recuperado con evidencia insuficiente.`,
        `${why} The engine does not conclude: the point stays “being verified” and is never declared recovered on insufficient evidence.`
      );
    }
  }
}