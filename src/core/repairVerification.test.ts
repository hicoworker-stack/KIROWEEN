import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createBaselineNodes } from './networkData';
import { assessRepair, DEFAULT_REPAIR_POLICY, recomputeSealedVerdict, repairOutcomeFromLedger, RepairEvidenceData, summarizeAssessment } from './repairVerification';
import { TelemetryReading, TrustLedgerEntry } from './types';

/**
 * REQ-REP-01..04: el veredicto de una reparación. Las pruebas por ejemplo fijan los casos; las pruebas basadas en propiedades
 * (fast-check) protegen el invariante central del producto: NUNCA se declara una reparación verificada sin mediciones
 * posteriores suficientes, consecutivas y normales, sea cual sea el orden, el ruido o los datos rezagados que lleguen.
 */
const node = createBaselineNodes().find((n) => n.id === 'N-TRON-04')!;
const CLOSED = '2026-11-20T12:00:00.000Z';
const T0 = Date.parse(CLOSED);
const MIN = 60_000;

function reading(id: string, offsetMin: number, kind: 'ok' | 'bad' | 'fault', jitter = 0): TelemetryReading {
  const b = node.baseline;
  const wobble = 1 + jitter * 0.002;
  return {
    id,
    timestamp: new Date(T0 + offsetMin * MIN).toISOString(),
    nodeId: node.id,
    ...b,
    pressureBar: kind === 'bad' ? b.pressureBar * 0.6 * wobble : b.pressureBar * wobble,
    flowLs: kind === 'bad' ? b.flowLs * 1.6 * wobble : kind === 'fault' ? 0 : b.flowLs * wobble,
    turbidityNtu: kind === 'fault' ? -1.4 : b.turbidityNtu,
    synthetic: true,
  };
}
const assess = (series: TelemetryReading[], extra: Partial<Parameters<typeof assessRepair>[0]> = {}) => assessRepair({ node, closedAt: CLOSED, series, ...extra });

test('REQ-REP-01: sin mediciones posteriores el resultado es PENDING, aunque haya muchas anteriores al cierre', () => {
  assert.equal(assess([]).outcome, 'PENDING');
  const before = [reading('a', -10, 'ok', 1), reading('b', -5, 'ok', 2), reading('c', 0, 'ok', 3)];
  const a = assess(before);
  assert.equal(a.outcome, 'PENDING');
  assert.equal(a.measuredAfter, 0, 'una lectura con marca igual al cierre tampoco cuenta');
});

test('REQ-REP-02: una o dos mediciones normales no bastan (INCONCLUSIVE); tres consecutivas verifican y lo declaran simulado', () => {
  const one = assess([reading('p1', 1, 'ok', 1)]);
  assert.equal(one.outcome, 'INCONCLUSIVE');
  assert.match(one.reasons.join(' '), /Se necesitan 3 mediciones/);
  assert.equal(assess([reading('p1', 1, 'ok', 1), reading('p2', 2, 'ok', 2)]).outcome, 'INCONCLUSIVE');
  const three = assess([reading('p1', 1, 'ok', 1), reading('p2', 2, 'ok', 2), reading('p3', 3, 'ok', 3)]);
  assert.equal(three.outcome, 'VERIFIED');
  assert.equal(three.synthetic, true, 'con datos simulados, la verificación se declara simulada');
  assert.match(three.reasons.join(' '), /datos simulados/);
});

test('REQ-REP-03: dos mediciones anómalas consecutivas reabren el caso; una sola, o una anómala entre normales, no concluyen', () => {
  assert.equal(assess([reading('p1', 1, 'bad', 1), reading('p2', 2, 'bad', 2)]).outcome, 'REOPENED');
  assert.equal(assess([reading('p1', 1, 'bad', 1)]).outcome, 'INCONCLUSIVE');
  const transient = assess([reading('p1', 1, 'bad', 1), reading('p2', 2, 'ok', 2), reading('p3', 3, 'ok', 3)]);
  assert.equal(transient.outcome, 'INCONCLUSIVE', 'una anomalía y solo dos normales después: aún no hay tres normales seguidas');
  assert.equal(assess([reading('p1', 1, 'bad', 1), reading('p2', 2, 'ok', 2), reading('p3', 3, 'ok', 3), reading('p4', 4, 'ok', 4)]).outcome, 'VERIFIED');
});

test('REQ-REP-03: las mediciones de un sensor defectuoso no sirven de evidencia ni para verificar ni para reabrir', () => {
  const faulty = assess([reading('f1', 1, 'fault'), reading('f2', 2, 'fault'), reading('f3', 3, 'fault')]);
  assert.equal(faulty.outcome, 'INCONCLUSIVE');
  assert.equal(faulty.unusable, 3);
  assert.equal(faulty.measuredAfter, 0);
});

test('REQ-REP-03: el balance hidráulico también decide: una fuga que persiste reabre; un exceso sin concluir impide verificar', () => {
  const clean = [reading('p1', 1, 'ok', 1), reading('p2', 2, 'ok', 2), reading('p3', 3, 'ok', 3)];
  assert.equal(assess(clean, { hydraulic: { level: 'localized_leak', excessLs: 11.8 } }).outcome, 'REOPENED', 'los sensores del punto parecen normales, pero el balance sigue viendo la fuga');
  assert.equal(assess(clean, { hydraulic: { level: 'possible_leak' } }).outcome, 'REOPENED');
  assert.equal(assess(clean, { hydraulic: { level: 'flow_anomaly', excessLs: 3 } }).outcome, 'INCONCLUSIVE');
  assert.equal(assess(clean, { hydraulic: { level: 'no_anomaly' } }).outcome, 'VERIFIED');
});

test('REQ-REP-01: valores idénticos repetidos (sensor congelado) no verifican una reparación', () => {
  const frozen = [1, 2, 3, 4, 5].map((i) => reading(`z${i}`, i, 'ok', 0));
  const a = assess(frozen);
  assert.notEqual(a.outcome, 'VERIFIED');
});

test('REQ-REP-04: el veredicto sellado en el ledger se recomputa a partir de sus lecturas y detecta una alteración', () => {
  const series = [reading('p1', 1, 'ok', 1), reading('p2', 2, 'ok', 2), reading('p3', 3, 'ok', 3)];
  const a = assess(series);
  const data: RepairEvidenceData = { workOrderId: 'WO-1', nodeId: node.id, closedAt: CLOSED, outcome: 'VERIFIED', policy: DEFAULT_REPAIR_POLICY, readings: series, hydraulic: null, assessment: summarizeAssessment(a) };
  assert.equal(recomputeSealedVerdict(node, data).matches, true);
  assert.equal(recomputeSealedVerdict(node, { ...data, readings: series.slice(0, 2) }).matches, false, 'quitar una medición ya no sustenta VERIFIED');
  assert.equal(recomputeSealedVerdict(node, { ...data, readings: [...series.slice(0, 2), reading('p3', 3, 'bad', 3)] }).matches, false, 'cambiar una medición a anómala tampoco');
  assert.equal(recomputeSealedVerdict(node, { ...data, outcome: 'REOPENED' }).matches, false, 'declarar otro resultado con las mismas lecturas tampoco');
  const ledger = [{ action: 'REPAIR_VERIFIED', evidenceData: data }, { action: 'WORK_ORDER_CLOSED', evidenceData: { workOrderId: 'WO-1' } }] as unknown as TrustLedgerEntry[];
  assert.equal(repairOutcomeFromLedger(ledger, 'WO-1')?.outcome, 'VERIFIED');
  assert.equal(repairOutcomeFromLedger(ledger, 'WO-2'), null);
});

// ───────────── Propiedades ─────────────
const kindArb = fc.constantFrom<'ok' | 'bad' | 'fault'>('ok', 'ok', 'ok', 'bad', 'fault');
const readingsArb = fc
  .array(fc.record({ offset: fc.integer({ min: -30, max: 40 }), kind: kindArb, jitter: fc.integer({ min: 0, max: 50 }) }), { maxLength: 14 })
  .map((rows) => rows.map((r, i) => reading(`r${i}`, r.offset + (i % 7) * 0.01, r.kind, r.jitter)));
const gateArb = fc.option(fc.constantFrom<'insufficient_data' | 'no_anomaly' | 'flow_anomaly' | 'possible_leak' | 'localized_leak'>('insufficient_data', 'no_anomaly', 'flow_anomaly', 'possible_leak', 'localized_leak').map((level) => ({ level })), { nil: null });
const RUNS = { numRuns: 400 };

test('PROPIEDAD: VERIFIED exige al menos tres mediciones posteriores utilizables y normales, y ninguna fuga hidráulica', () => {
  fc.assert(
    fc.property(readingsArb, gateArb, (series, hydraulic) => {
      const a = assess(series, { hydraulic });
      if (a.outcome !== 'VERIFIED') return true;
      const postUsable = series.filter((r) => Date.parse(r.timestamp) > T0 && r.turbidityNtu >= 0);
      return a.measuredAfter >= DEFAULT_REPAIR_POLICY.minReadings && postUsable.length >= DEFAULT_REPAIR_POLICY.minReadings && hydraulic?.level !== 'possible_leak' && hydraulic?.level !== 'localized_leak' && hydraulic?.level !== 'flow_anomaly';
    }),
    RUNS
  );
});

test('PROPIEDAD: sin mediciones posteriores al cierre nunca hay veredicto distinto de PENDING', () => {
  fc.assert(
    fc.property(readingsArb, gateArb, (series, hydraulic) => {
      const onlyBefore = series.filter((r) => Date.parse(r.timestamp) <= T0);
      return assess(onlyBefore, { hydraulic }).outcome === 'PENDING';
    }),
    RUNS
  );
});

test('PROPIEDAD: añadir datos rezagados (anteriores o iguales al cierre) no cambia el veredicto', () => {
  fc.assert(
    fc.property(readingsArb, readingsArb, gateArb, (series, extra, hydraulic) => {
      const stale = extra.filter((r) => Date.parse(r.timestamp) <= T0).map((r) => ({ ...r, id: `stale-${r.id}` }));
      const own = series.filter((r) => Date.parse(r.timestamp) > T0);
      const alone = assess(own, { hydraulic });
      const mixed = assess([...stale, ...own], { hydraulic });
      return alone.outcome === mixed.outcome || (alone.outcome === 'PENDING' && mixed.outcome === 'PENDING');
    }),
    RUNS
  );
});

test('PROPIEDAD: el orden de llegada no cambia el veredicto', () => {
  fc.assert(
    fc.property(readingsArb, fc.integer({ min: 1, max: 9999 }), gateArb, (series, seed, hydraulic) => {
      const shuffled = [...series].sort((a, b) => ((Number(a.id.slice(1)) * seed) % 97) - ((Number(b.id.slice(1)) * seed) % 97));
      return assess(series, { hydraulic }).outcome === assess(shuffled, { hydraulic }).outcome;
    }),
    RUNS
  );
});

test('PROPIEDAD: una reparación verificada deja de estarlo si después llegan dos mediciones anómalas', () => {
  fc.assert(
    fc.property(readingsArb, (series) => {
      const a = assess(series);
      if (a.outcome !== 'VERIFIED') return true;
      const later = Math.max(...series.map((r) => Date.parse(r.timestamp))) / MIN - T0 / MIN;
      const worse = assess([...series, reading('late-1', later + 1, 'bad', 7), reading('late-2', later + 2, 'bad', 9)]);
      return worse.outcome === 'REOPENED';
    }),
    RUNS
  );
});

test('PROPIEDAD: el veredicto sellado siempre se recomputa igual con sus propias lecturas', () => {
  fc.assert(
    fc.property(readingsArb, gateArb, (series, hydraulic) => {
      const a = assess(series, { hydraulic });
      if (a.outcome !== 'VERIFIED' && a.outcome !== 'REOPENED') return true;
      const data: RepairEvidenceData = { workOrderId: 'WO', nodeId: node.id, closedAt: CLOSED, outcome: a.outcome, policy: DEFAULT_REPAIR_POLICY, readings: series, hydraulic, assessment: summarizeAssessment(a) };
      return recomputeSealedVerdict(node, data).matches;
    }),
    RUNS
  );
});
