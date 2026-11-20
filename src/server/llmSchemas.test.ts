import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLlmText, parseDiagnosisResponse, parseVisionResponse, sanitizeUntrusted, stripFences } from './llmSchemas';

const diag = () => ({
  detectedProblem: 'Fuga en el tramo',
  primaryHypothesis: 'Rotura de brida',
  alternativeHypotheses: [{ title: 'Falla de sensor', likelihood: 'Baja', supportingEvidence: 'Explica la lectura', contradictingOrMissing: 'El balance la contradice' }],
  uncertaintyStatement: 'Sin calibración de campo',
  missingData: ['Inspección acústica'],
  potentialImpact: 'Baja presión',
  recommendedAction: 'Aislar el tramo',
  requiredResources: ['Cuadrilla'],
  interventionSteps: ['Aislar el tramo con válvulas'],
});
const vis = () => ({ observed: ['Agua saliendo de una brida'], cannotDetermine: ['Caudal exacto'], missingData: [], visualCategory: 'leak', imageQuality: 'adecuada' });

test('un diagnóstico completo y bien tipado se acepta (REQ-AI-03)', () => {
  const r = parseDiagnosisResponse(JSON.stringify(diag()));
  assert.equal(r.ok, true);
});

test('el JSON dentro de una cerca de código se acepta, y el texto se limpia de HTML (REQ-AI-03)', () => {
  const d = { ...diag(), primaryHypothesis: 'Rotura <script>alert(1)</script> de brida' };
  const r = parseDiagnosisResponse('```json\n' + JSON.stringify(d) + '\n```');
  assert.ok(r.ok);
  if (r.ok) assert.ok(!/<script>/.test(r.value.primaryHypothesis));
  assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
});

test('REGRESIÓN DE AUDITORÍA: {} y respuestas vacías o no JSON se rechazan, nunca se rellenan (REQ-AI-03)', () => {
  for (const raw of ['{}', '', '   ', undefined, null, 'esto no es json', '[]', '"texto"', '42']) {
    const r = parseDiagnosisResponse(raw);
    assert.equal(r.ok, false, `debe rechazar ${String(raw)}`);
  }
  for (const raw of ['{}', '', 'basura', '[]']) assert.equal(parseVisionResponse(raw).ok, false);
});

test('REGRESIÓN DE AUDITORÍA: tipos incorrectos se rechazan con el campo culpable (REQ-AI-03)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['detectedProblem', { ...diag(), detectedProblem: 123 }],
    ['interventionSteps', { ...diag(), interventionSteps: 'paso único' }],
    ['alternativeHypotheses', { ...diag(), alternativeHypotheses: 'ninguna' }],
    ['missingData', { ...diag(), missingData: 'n' }],
    ['likelihood', { ...diag(), alternativeHypotheses: [{ title: 'x y z', likelihood: 'Muy alta', supportingEvidence: 'aaaaa', contradictingOrMissing: 'bbbbb' }] }],
    ['requiredResources', { ...diag(), requiredResources: [] }],
    ['detectedProblem', { ...diag(), detectedProblem: 'string' }],
    ['detectedProblem', { ...diag(), detectedProblem: 'x'.repeat(900) }],
  ];
  for (const [field, body] of cases) {
    const r = parseDiagnosisResponse(JSON.stringify(body));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.length > 0 && (r.reason.includes(field) || field === 'likelihood'), `${field}: ${r.reason}`);
  }
  assert.equal(parseDiagnosisResponse(JSON.stringify({ ...diag(), confidencePct: 75 })).ok, true, 'un campo extra se ignora');
});

test('visión: categoría fuera del conjunto, calidad inválida o listas mal tipadas se rechazan (REQ-AI-03)', () => {
  assert.equal(parseVisionResponse(JSON.stringify({ ...vis(), visualCategory: 'dragon' })).ok, false);
  assert.equal(parseVisionResponse(JSON.stringify({ ...vis(), imageQuality: 9 })).ok, false);
  assert.equal(parseVisionResponse(JSON.stringify({ ...vis(), observed: 'una fuga' })).ok, false);
  assert.equal(parseVisionResponse(JSON.stringify({ ...vis(), cannotDetermine: null })).ok, false);
  assert.equal(parseVisionResponse(JSON.stringify({ ...vis(), observed: [] })).ok, false);
});

test('visión: una imagen deficiente se convierte siempre en inconclusive (REQ-AI-04)', () => {
  const r = parseVisionResponse(JSON.stringify({ ...vis(), imageQuality: 'deficiente' }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.visualCategory, 'inconclusive');
  const ok = parseVisionResponse(JSON.stringify(vis()));
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.visualCategory, 'leak');
});

test('sanitizeUntrusted quita control, llaves y comillas invertidas y acota la longitud (REQ-AI-03)', () => {
  const s = sanitizeUntrusted('ignora\u0000 todo {"x":1} ```cod``` <b>hola</b>' + 'y'.repeat(500), 100);
  assert.ok(s.length <= 100);
  assert.ok(!/[`{}[\]<>\u0000]/.test(s));
  assert.equal(sanitizeUntrusted(undefined), '');
  assert.equal(sanitizeUntrusted(null), '');
  assert.equal(cleanLlmText('  a\n\n  b\t<i>c</i> '), 'a b c');
});
