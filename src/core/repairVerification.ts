import { evaluateTelemetryReading } from './deterministicEngine';
import type { HydraulicLevel } from './hydraulicDiagnosis';
import type { NetworkNode, TelemetryReading, TrustLedgerEntry } from './types';

/**
 * REQ-REP-01..04: verificación de una reparación con mediciones POSTERIORES. Función pura: la usan el servidor (para decidir),
 * el verificador de expedientes (para recomputar el veredicto con las lecturas selladas) y la interfaz (para explicarlo).
 *
 * Una orden cerrada no demuestra nada por sí misma. Solo hay uno de estos resultados:
 *   PENDING       no ha llegado ninguna medición posterior al cierre.
 *   INCONCLUSIVE  hay mediciones, pero no bastan para afirmar nada (pocas, un solo valor anómalo, sensor defectuoso,
 *                 o el balance hidráulico todavía muestra un exceso de caudal sin concluir fuga).
 *   VERIFIED      las últimas `minReadings` mediciones utilizables son consecutivas, posteriores al cierre y están
 *                 dentro de lo normal, y el balance hidráulico no conserva una fuga.
 *   REOPENED      el problema persiste: `reopenAfter` mediciones anómalas consecutivas, o el balance hidráulico sigue
 *                 concluyendo una fuga.
 *
 * Nunca se declara VERIFIED con menos de `minReadings` mediciones. Una medición con marca temporal anterior o igual al cierre
 * nunca cuenta. El orden de llegada no importa (se ordena por marca temporal). Si todas las mediciones son sintéticas, el
 * resultado lo declara (`synthetic`): es una verificación sobre datos simulados, no sobre datos de campo.
 */
export type RepairOutcome = 'PENDING' | 'INCONCLUSIVE' | 'VERIFIED' | 'REOPENED';

/** Por qué el motor llegó a este resultado. La interfaz compone su texto en el idioma activo; easons queda como registro en español. */
export type RepairCode = 'no_measurements' | 'only_unusable' | 'hydraulic_leak' | 'anomalous_streak' | 'hydraulic_excess' | 'not_enough' | 'verified';

export interface RepairPolicy {
  /** Mediciones utilizables consecutivas, dentro de lo normal, que se exigen para verificar. */
  minReadings: number;
  /** Mediciones anómalas consecutivas que reabren el caso (coincide con las dos muestras que exige el detector). */
  reopenAfter: number;
}
export const DEFAULT_REPAIR_POLICY: RepairPolicy = { minReadings: 3, reopenAfter: 2 };
/** Lecturas que escribía el sistema (línea base, valor restaurado): jamás son mediciones. */
const NOT_A_MEASUREMENT = new Set<string>(['restored', 'baseline']);

/** Lo que el balance hidráulico de la red dice ahora sobre este punto (null si no hay hallazgo). */
export interface HydraulicGate {
  level: HydraulicLevel;
  excessLs?: number;
}

export type RepairNode = Pick<NetworkNode, 'id' | 'name' | 'sector' | 'populationServed' | 'baseline'>;

export interface RepairAssessment {
  outcome: RepairOutcome;
  code: RepairCode;
  /** Mediciones utilizables posteriores al cierre. */
  measuredAfter: number;
  required: number;
  /** Mediciones anómalas consecutivas al final de la serie. */
  anomalousInRow: number;
  /** Mediciones descartadas por indicar un sensor defectuoso o imposible. */
  unusable: number;
  /** Todas las mediciones utilizables son sintéticas. */
  synthetic: boolean;
  /** Identificadores de las mediciones utilizables, en orden temporal. */
  readingIds: string[];
  hydraulic: HydraulicGate | null;
  reasons: string[];
}

export type RepairAssessmentSummary = Pick<RepairAssessment, 'outcome' | 'code' | 'measuredAfter' | 'required' | 'anomalousInRow' | 'synthetic' | 'reasons'>;

export interface AssessRepairInput {
  node: RepairNode;
  closedAt: string;
  /** Serie del punto (con su historial previo). Solo cuentan como evidencia las lecturas posteriores a `closedAt`. */
  series: TelemetryReading[];
  hydraulic?: HydraulicGate | null;
  policy?: Partial<RepairPolicy>;
}

export function assessRepair(input: AssessRepairInput): RepairAssessment {
  const policy: RepairPolicy = { ...DEFAULT_REPAIR_POLICY, ...input.policy };
  const closedMs = Date.parse(input.closedAt);
  const hydraulic = input.hydraulic ?? null;
  const seen = new Set<string>();
  // Serie completa del punto, ordenada por marca temporal y sin duplicados. El historial de cada medición posterior son las
  // lecturas que la preceden en esa serie (también las anteriores al cierre), igual que al ingerirlas: así un sensor congelado
  // (valores idénticos repetidos) se descarta como evidencia en lugar de "verificar" una reparación.
  const full = input.series
    .filter((r) => r.nodeId === input.node.id && !NOT_A_MEASUREMENT.has(r.source ?? ''))
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  const post = full.filter((r) => Date.parse(r.timestamp) > closedMs);

  const base = { required: policy.minReadings, hydraulic };
  if (post.length === 0) {
    return { ...base, outcome: 'PENDING', code: 'no_measurements', measuredAfter: 0, anomalousInRow: 0, unusable: 0, synthetic: true, readingIds: [], reasons: ['Aún no hay mediciones posteriores al cierre de la orden.'] };
  }

  // Cada medición posterior se evalúa con las reglas deterministas del motor.
  // Una medición de sensor defectuoso no es evidencia, pero tampoco se ignora: interrumpe la racha. Si el sensor se congela
  // tras varias lecturas idénticas, esas lecturas no pueden usarse para verificar nada.
  type Step = { reading: TelemetryReading; kind: 'clean' | 'anomalous' | 'unusable' };
  const steps: Step[] = post.map((reading) => {
    const at = full.indexOf(reading);
    const hit = evaluateTelemetryReading(reading, input.node as NetworkNode, full.slice(Math.max(0, at - 19), at));
    return { reading, kind: hit === null ? 'clean' : hit.category === 'sensor_fault' ? 'unusable' : 'anomalous' };
  });
  const usable = steps.filter((s) => s.kind !== 'unusable').map((s) => ({ reading: s.reading, anomalous: s.kind === 'anomalous' }));
  const unusable = steps.length - usable.length;
  const run = (kind: Step['kind']) => {
    let n = 0;
    for (let i = steps.length - 1; i >= 0 && steps[i].kind === kind; i--) n++;
    return n;
  };
  const anomalousInRow = run('anomalous');
  const cleanInRow = run('clean');

  const common = { ...base, measuredAfter: usable.length, anomalousInRow, unusable, synthetic: usable.every((u) => u.reading.synthetic), readingIds: usable.map((u) => u.reading.id) };
  const leakStill = hydraulic?.level === 'possible_leak' || hydraulic?.level === 'localized_leak';

  if (usable.length === 0) {
    return { ...common, outcome: 'INCONCLUSIVE', code: 'only_unusable', reasons: ['Las mediciones posteriores indican un sensor defectuoso o imposible: no sirven como evidencia.'] };
  }
  if (leakStill) {
    return { ...common, outcome: 'REOPENED', code: 'hydraulic_leak', reasons: [`El balance hidráulico sigue concluyendo una fuga tras el cierre${hydraulic?.excessLs !== undefined ? ` (exceso de ${hydraulic.excessLs} L/s)` : ''}.`] };
  }
  if (anomalousInRow >= policy.reopenAfter) {
    return { ...common, outcome: 'REOPENED', code: 'anomalous_streak', reasons: [` mediciones consecutivas posteriores al cierre siguen fuera de lo normal: la reparación no resolvió el problema.`] };
  }
  const reasons: string[] = [];
  if (cleanInRow >= policy.minReadings) {
    if (hydraulic?.level === 'flow_anomaly') {
      return { ...common, outcome: 'INCONCLUSIVE', code: 'hydraulic_excess', reasons: ['Las mediciones del punto son normales, pero el balance hidráulico aún muestra un exceso de caudal sin concluir fuga: no se puede confirmar.'] };
    }
    return { ...common, outcome: 'VERIFIED', code: 'verified', reasons: [`${cleanInRow} mediciones consecutivas posteriores al cierre dentro de lo normal${common.synthetic ? ' (datos simulados)' : ''}, y el balance hidráulico no conserva una fuga.`] };
  }
  if (anomalousInRow > 0) reasons.push(`La última medición sigue fuera de lo normal; con ${policy.reopenAfter} seguidas se reabre el caso.`);
  reasons.push(`Se necesitan ${policy.minReadings} mediciones consecutivas dentro de lo normal y hay ${cleanInRow}.`);
  if (unusable > 0) reasons.push(`${unusable} medición(es) se descartaron por sensor defectuoso.`);
  return { ...common, outcome: 'INCONCLUSIVE', code: 'not_enough', reasons };
}

export const summarizeAssessment = (a: RepairAssessment): RepairAssessmentSummary => ({
  outcome: a.outcome,
  code: a.code,
  measuredAfter: a.measuredAfter,
  required: a.required,
  anomalousInRow: a.anomalousInRow,
  synthetic: a.synthetic,
  reasons: a.reasons,
});

/** Acciones del ledger que cierran la verificación de una orden. */
export const REPAIR_LEDGER_ACTIONS = { VERIFIED: 'REPAIR_VERIFIED', REOPENED: 'REPAIR_REOPENED' } as const;

/** Qué quedó registrado (y sellado en la cadena) sobre la verificación de una orden; null si todavía no hay veredicto. */
export function repairOutcomeFromLedger(ledger: TrustLedgerEntry[], workOrderId: string): { outcome: 'VERIFIED' | 'REOPENED'; entry: TrustLedgerEntry } | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i];
    if ((e.action === REPAIR_LEDGER_ACTIONS.VERIFIED || e.action === REPAIR_LEDGER_ACTIONS.REOPENED) && (e.evidenceData as { workOrderId?: string } | undefined)?.workOrderId === workOrderId) {
      return { outcome: e.action === REPAIR_LEDGER_ACTIONS.VERIFIED ? 'VERIFIED' : 'REOPENED', entry: e };
    }
  }
  return null;
}

/** Datos que el servidor sella en el ledger al emitir un veredicto: bastan para recomputarlo sin confiar en el servidor. */
export interface RepairEvidenceData {
  workOrderId: string;
  nodeId: string;
  closedAt: string;
  outcome: 'VERIFIED' | 'REOPENED';
  policy: RepairPolicy;
  readings: TelemetryReading[];
  hydraulic: HydraulicGate | null;
  assessment: RepairAssessmentSummary;
}

/** Recomputa el veredicto a partir de lo sellado y dice si coincide con el registrado. */
export function recomputeSealedVerdict(node: RepairNode, data: RepairEvidenceData): { matches: boolean; recomputed: RepairAssessment } {
  const recomputed = assessRepair({ node, closedAt: data.closedAt, series: data.readings, hydraulic: data.hydraulic, policy: data.policy });
  return { matches: recomputed.outcome === data.outcome && recomputed.measuredAfter === data.assessment.measuredAfter, recomputed };
}
