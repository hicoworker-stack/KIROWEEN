import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConcordance } from './evidenceConcordance';
import { buildDeterministicDiagnosisBody } from './diagnosisTemplates';
import { evaluateTelemetryReading } from './deterministicEngine';
import { createBaselineNodes } from './networkData';
import { AnomalyEvent, VisionAnalysisResult } from './types';

function leakAnomaly(): AnomalyEvent {
  const node = createBaselineNodes().find((n) => n.id === 'N-TRON-04')!;
  return evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: '2026-11-19T12:00:00.000Z', pressureBar: 2.6, flowLs: 29.4 }, node)!;
}

function vision(over: Partial<VisionAnalysisResult> = {}): VisionAnalysisResult {
  return {
    id: 'V', timestamp: 'now', nodeId: 'N-TRON-04', imageUrl: '', imageTitle: '', providerUsed: 'test', providerMode: 'gemini-live',
    observed: ['agua saliendo'], inferred: [], cannotDetermine: [], missingData: [], sensorCorrelationSummary: '',
    analysisStatus: 'analyzed', visualCategory: 'leak', ...over,
  };
}

const hydroSupports = { level: 'localized_leak' as const, excessLs: 6.6, sigmaLs: 1.2, candidatePipeIds: ['P-05'] };

test('solo sensores: nivel "baja", sin número alguno (REQ-AI-02)', () => {
  const r = evaluateConcordance({ anomaly: leakAnomaly(), vision: null, hydraulic: null });
  assert.equal(r.level, 'baja');
  assert.ok(!('score' in r) && !('confidenceCapPct' in r), 'ya no hay puntajes ni topes porcentuales');
  assert.deepEqual(r.basis, ['sensores']);
});

test('un canal adicional que coincide da "media"; los dos dan "alta" (REQ-AI-02)', () => {
  const a = leakAnomaly();
  assert.equal(evaluateConcordance({ anomaly: a, hydraulic: hydroSupports }).level, 'media');
  assert.equal(evaluateConcordance({ anomaly: a, vision: vision() }).level, 'media');
  assert.equal(evaluateConcordance({ anomaly: a, hydraulic: hydroSupports, vision: vision() }).level, 'alta');
});

test('REGRESIÓN DE AUDITORÍA: una fotografía NO analizada no suma nivel (REQ-AI-02, REQ-AI-04)', () => {
  const a = leakAnomaly();
  const notAnalyzed = vision({ analysisStatus: 'not_analyzed', visualCategory: undefined, evidenceRole: 'not_analyzed' });
  const r = evaluateConcordance({ anomaly: a, vision: notAnalyzed });
  assert.equal(r.level, 'baja');
  assert.equal(r.channels.find((c) => c.channel === 'fotografía')!.verdict, 'missing');
});

test('una foto inconclusa es neutral, no respalda (REQ-AI-02)', () => {
  const r = evaluateConcordance({ anomaly: leakAnomaly(), vision: vision({ visualCategory: 'inconclusive' }) });
  assert.equal(r.level, 'baja');
  assert.equal(r.channels.find((c) => c.channel === 'fotografía')!.verdict, 'neutral');
});

test('foto analizada que contradice: "en_conflicto", se reporta y no se promedia (REQ-AI-02)', () => {
  const r = evaluateConcordance({ anomaly: leakAnomaly(), vision: vision({ visualCategory: 'contamination' }), hydraulic: hydroSupports });
  assert.equal(r.level, 'en_conflicto');
  assert.match(r.statement, /contradice/);
});

test('sensor_fault con foto analizada de fuga: advierte no descartar la fuga (REQ-AI-02)', () => {
  const node = createBaselineNodes().find((n) => n.id === 'N-TANQ-03')!;
  const a = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: 't', turbidityNtu: -1.4, flowLs: 0, pressureBar: 4.9 }, node)!;
  assert.equal(a.category, 'sensor_fault');
  const r = evaluateConcordance({ anomaly: a, vision: vision({ nodeId: 'N-TANQ-03', visualCategory: 'leak' }) });
  assert.equal(r.level, 'en_conflicto');
  assert.match(r.channels.find((c) => c.channel === 'fotografía')!.detail, /No descartar una fuga/);
});

test('el canal hidráulico solo aplica a fugas y distingue anomalía de caudal de fuga corroborada (REQ-AI-02, REQ-HYD-03)', () => {
  const leak = leakAnomaly();
  const flow = evaluateConcordance({ anomaly: leak, hydraulic: { level: 'flow_anomaly', excessLs: 4 } });
  assert.equal(flow.level, 'baja', 'una anomalía de caudal sin corroboración de presión no es respaldo');
  assert.equal(flow.channels.find((c) => c.channel === 'hidráulica')!.verdict, 'neutral');
  const insuff = evaluateConcordance({ anomaly: leak, hydraulic: { level: 'insufficient_data' } });
  assert.match(insuff.channels.find((c) => c.channel === 'hidráulica')!.detail, /insuficientes/);
  const node = createBaselineNodes().find((n) => n.id === 'N-TOMA-01')!;
  const q = evaluateTelemetryReading({ ...node.current, id: 'T', timestamp: 't', turbidityNtu: 14.8, chlorineMgL: 0.16 }, node)!;
  assert.equal(evaluateConcordance({ anomaly: q, hydraulic: hydroSupports }).channels.find((c) => c.channel === 'hidráulica')!.verdict, 'missing');
});

test('REGRESIÓN DE AUDITORÍA: el diagnóstico determinista no afirma contenido de una foto sin análisis (REQ-AI-04)', () => {
  const a = leakAnomaly();
  const node = createBaselineNodes().find((n) => n.id === 'N-TRON-04')!;
  const notAnalyzed = vision({ analysisStatus: 'not_analyzed', visualCategory: undefined });
  const body = buildDeterministicDiagnosisBody({ anomaly: a, node, vision: notAnalyzed });
  const text = JSON.stringify(body);
  assert.match(text, /NO analizada/);
  assert.ok(!/fractura|brida PVC|La fotografía muestra/i.test(text), 'no se describe lo que muestra una imagen no analizada');
  assert.ok(!/\+29%/.test(text), 'ninguna cifra fija de un escenario');
  assert.equal(body.evidenceLevel, 'baja');
});

test('el diagnóstico de fuga respeta el nivel hidráulico: localizada vs posible vs solo presión (REQ-HYD-03)', () => {
  const a = leakAnomaly();
  const node = createBaselineNodes().find((n) => n.id === 'N-TRON-04')!;
  const loc = buildDeterministicDiagnosisBody({ anomaly: { ...a, hydraulicLevel: 'localized_leak' }, node, hydraulic: { ...hydroSupports, estimatedLossM3PerDay: 570.2, reachLabels: ['P-05'] } });
  assert.match(loc.detectedProblem, /Fuga localizada en el tramo P-05/);
  assert.match(loc.uncertaintyStatement, /entre dos medidores/);
  assert.match(loc.potentialImpact, /sin validación de campo/);
  const poss = buildDeterministicDiagnosisBody({ anomaly: { ...a, hydraulicLevel: 'possible_leak' }, node, hydraulic: { level: 'possible_leak', excessLs: 5, sigmaLs: 1, candidatePipeIds: ['P-03', 'P-04'] } });
  assert.match(poss.detectedProblem, /Posible fuga/);
  assert.match(poss.primaryHypothesis, /no permiten asegurar un único tramo/);
  const pressureOnly = buildDeterministicDiagnosisBody({ anomaly: a, node });
  assert.match(pressureOnly.detectedProblem, /sin corroboración por balance/);
  assert.match(pressureOnly.uncertaintyStatement, /un solo canal/);
});
