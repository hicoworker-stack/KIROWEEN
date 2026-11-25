import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRiskPriorityScore,
  evaluateTelemetryReading,
  parseCsvTelemetry,
  selectPrimaryHit,
} from './deterministicEngine';
import { createBaselineNodes, SAMPLE_CSV_PAYLOAD } from './networkData';

/**
 * Pruebas del motor de reglas por nodo. Las lecturas son ENTRADAS EXPLÍCITAS de cada prueba (no vienen de los
 * escenarios de la demostración): así se prueba la regla, no el generador.
 */
const nodeOf = (id: string) => createBaselineNodes().find((n) => n.id === id)!;
const ts = '2026-11-19T12:00:00.000Z';

test('nominal baseline reading produces no anomaly', () => {
  const node = nodeOf('N-TOMA-01');
  assert.equal(evaluateTelemetryReading(node.current, node), null);
});

test('una caída de presión del 42% con más caudal dispara PRESSURE_DROP_LEAK con prioridad alta (REQ-DET-01)', () => {
  const node = nodeOf('N-TRON-04');
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, pressureBar: 2.61, flowLs: 29.4 }, node);
  assert.ok(a);
  assert.equal(a.category, 'leak');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'PRESSURE_DROP_LEAK'));
  assert.ok(a.priority.totalScore >= 60);
});

test('caudal -54% con presión +26% dispara FLOW_OBSTRUCTION (REQ-DET-01)', () => {
  const node = nodeOf('N-VALV-05');
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, pressureBar: 5.29, flowLs: 8.4 }, node);
  assert.ok(a);
  assert.equal(a.category, 'obstruction');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'FLOW_OBSTRUCTION'));
});

test('turbidez negativa y caudal cero con presión alta: la falla de sensor tiene prioridad sobre fuga o calidad (REQ-DET-01)', () => {
  const node = nodeOf('N-TANQ-03');
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, pressureBar: 4.9, flowLs: 0, levelPct: 81, turbidityNtu: -1.4 }, node);
  assert.ok(a);
  assert.equal(a.category, 'sensor_fault');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'SENSOR_PHYSICAL_IMPLAUSIBILITY'));
});

test('turbidez 14.8 NTU, cloro 0.16 mg/L y pH 6.2 disparan QUALITY_PARAMETER_ANOMALY como contaminación crítica (REQ-DET-01)', () => {
  const node = nodeOf('N-TOMA-01');
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, turbidityNtu: 14.8, chlorineMgL: 0.16, ph: 6.2, levelPct: 88 }, node);
  assert.ok(a);
  assert.equal(a.category, 'contamination');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'QUALITY_PARAMETER_ANOMALY'));
  assert.equal(a.priority.priority, 'Crítica');
});

test('computeRiskPriorityScore clamps between 0 and 100 (REQ-DET-03)', () => {
  const high = computeRiskPriorityScore({ category: 'contamination', maxRuleSeverity: 120, populationServed: 10000, ruleCount: 4 });
  assert.equal(high.totalScore, 100);
  assert.equal(high.priority, 'Crítica');
  const low = computeRiskPriorityScore({ category: 'sensor_fault', maxRuleSeverity: 10, populationServed: 100, ruleCount: 1 });
  assert.ok(low.totalScore >= 0 && low.totalScore < 35);
  assert.equal(low.priority, 'Baja');
});

test('parseCsvTelemetry parses valid rows and catches malformed rows (REQ-ING-02)', () => {
  const valid = parseCsvTelemetry(SAMPLE_CSV_PAYLOAD);
  assert.equal(valid.readings.length, 4);
  assert.equal(valid.errors.length, 0);
  const malformed = parseCsvTelemetry('timestamp,nodeId,pressureBar,flowLs,levelPct,turbidityNtu,chlorineMgL,ph\n2026-11-18T12:00Z,N-TOMA-01,abc,10,50,1,0.8,7.2');
  assert.equal(malformed.readings.length, 0);
  assert.equal(malformed.errors.length, 1);
});

test('intentional valveState closed suppresses false-positive sensor implausibility (M-07, REQ-DET-02)', () => {
  const node = nodeOf('N-VALV-05');
  const r = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, flowLs: 0.0, pressureBar: 4.4, valveState: 'closed' }, node);
  assert.equal(r, null);
});

test('4 consecutive identical readings trigger SENSOR_STUCK_AT_VALUE (M-07, REQ-DET-02)', () => {
  const node = nodeOf('N-TRON-04');
  const frozen = { ...node.current, id: 'FROZEN', timestamp: ts };
  const a = evaluateTelemetryReading(frozen, node, [frozen, frozen, frozen]);
  assert.ok(a);
  assert.equal(a.category, 'sensor_fault');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'SENSOR_STUCK_AT_VALUE'));
});

test('minor chlorine drift classifies as quality_drift rather than contamination (M-07, REQ-DET-02)', () => {
  const node = nodeOf('N-DIST-06');
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: ts, chlorineMgL: 0.24, turbidityNtu: 0.6, ph: 7.2 }, node);
  assert.ok(a);
  assert.equal(a.category, 'quality_drift');
});

// REQ-DET-04: arbitraje leak vs calidad
function troncalReading(over: Record<string, number>) {
  const node = nodeOf('N-TRON-04');
  return evaluateTelemetryReading({ ...node.current, id: 'ARB', timestamp: ts, flowLs: 29, ...over }, node);
}

test('small leak + chlorine drift stays leak, drift kept as secondary evidence (REQ-DET-04)', () => {
  const a = troncalReading({ pressureBar: 3.5, chlorineMgL: 0.28 });
  assert.ok(a);
  assert.equal(a.category, 'leak');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'QUALITY_PARAMETER_ANOMALY'));
});

test('small leak is not hidden by contamination severity floor from chlorine/pH only (REQ-DET-04)', () => {
  const a = troncalReading({ pressureBar: 3.5, chlorineMgL: 0.15, ph: 8.6 });
  assert.ok(a);
  assert.equal(a.category, 'leak');
});

test('leak with high turbidity escalates to contamination (ingress) but keeps leak rule (REQ-DET-04)', () => {
  const a = troncalReading({ pressureBar: 3.4, turbidityNtu: 5 });
  assert.ok(a);
  assert.equal(a.category, 'contamination');
  assert.ok(a.rulesTriggered.some((r) => r.ruleId === 'PRESSURE_DROP_LEAK'));
});

test('quality drift without pressure drop never creates a leak (REQ-DET-04)', () => {
  const a = troncalReading({ pressureBar: 4.45, chlorineMgL: 0.24 });
  assert.ok(a);
  assert.equal(a.category, 'quality_drift');
  assert.ok(!a.rulesTriggered.some((r) => r.ruleId === 'PRESSURE_DROP_LEAK'));
});

test('selectPrimaryHit: sensor > turbidez+fuga > mayor severidad (REQ-DET-04, mutante M7 de la auditoría)', () => {
  const hit = (ruleId: string, category: string, severityScore: number) => ({ ruleId, category, severityScore }) as never;
  assert.equal(selectPrimaryHit([hit('PRESSURE_DROP_LEAK', 'leak', 90), hit('SENSOR_STUCK_AT_VALUE', 'sensor_fault', 10)], { turbidityNtu: 0.5 }).category, 'sensor_fault');
  const pair = [hit('PRESSURE_DROP_LEAK', 'leak', 60), hit('QUALITY_PARAMETER_ANOMALY', 'contamination', 58)];
  assert.equal(selectPrimaryHit(pair, { turbidityNtu: 4.01 }).category, 'contamination');
  assert.equal(selectPrimaryHit(pair, { turbidityNtu: 4.0 }).category, 'leak', 'el umbral es estrictamente mayor que 4.0 NTU');
  assert.equal(selectPrimaryHit(pair, { turbidityNtu: 39 }).category, 'contamination', 'un valor muy por encima del umbral también escala');
});
