import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStructurallyValidReading,
  MAX_BATCH_SIZE,
  readingDedupKey,
  readingFingerprint,
  validateReading,
  validateReadingBatch,
} from './telemetryValidation';
import { parseCsvTelemetry } from './deterministicEngine';

const ctx = { knownNodeIds: new Set(['N-TOMA-01', 'N-TRON-04']), nowMs: Date.parse('2026-11-19T12:00:00Z') };
const good = {
  nodeId: 'N-TOMA-01',
  timestamp: '2026-11-19T11:59:00Z',
  pressureBar: 1.4,
  flowLs: 48,
  levelPct: 84,
  turbidityNtu: 1.2,
  chlorineMgL: 0.85,
  ph: 7.2,
};

test('lectura válida se normaliza y se marca sintética por defecto (REQ-RES-01)', () => {
  const v = validateReading({ ...good, synthetic: false, extra: 'ignorado' }, ctx, { source: 'api' });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.reading.synthetic, true, 'un cliente no puede autodeclarar dato real');
    assert.equal(v.reading.timestamp, '2026-11-19T11:59:00.000Z');
    assert.equal(v.reading.source, 'api');
    assert.ok(!('extra' in v.reading));
  }
});

test('trustSyntheticFlag solo se honra si el servidor lo habilita explícitamente (REQ-RES-01)', () => {
  const v = validateReading({ ...good, synthetic: false }, ctx, { source: 'api', trustSyntheticFlag: true });
  assert.equal(v.ok && v.reading.synthetic, false);
});

test('rechaza el caso que dejaba la interfaz en blanco: solo nodeId (REQ-RES-01)', () => {
  const v = validateReading({ nodeId: 'N-TOMA-01' }, ctx, { source: 'api' });
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => e.startsWith('pressureBar')));
});

test('rechaza cadenas, null, NaN, Infinity y magnitudes absurdas (REQ-RES-01)', () => {
  const cases: Array<[string, unknown]> = [
    ['pressureBar', 'abc'],
    ['flowLs', null],
    ['levelPct', Number.NaN],
    ['turbidityNtu', Infinity],
    ['chlorineMgL', 1e9],
    ['ph', 99999],
  ];
  for (const [field, value] of cases) {
    const v = validateReading({ ...good, [field]: value }, ctx, { source: 'api' });
    assert.equal(v.ok, false, `${field}=${String(value)} debería rechazarse`);
  }
});

test('acepta valores finitos físicamente imposibles para que el motor los marque como falla de sensor (REQ-RES-01)', () => {
  const v = validateReading({ ...good, turbidityNtu: -1.4, ph: 15 }, ctx, { source: 'api' });
  assert.equal(v.ok, true);
});

test('rechaza nodo desconocido, fecha inválida, futura o fuera de rango (REQ-RES-01)', () => {
  assert.equal(validateReading({ ...good, nodeId: 'N-X' }, ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading({ ...good, timestamp: 'ayer' }, ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading({ ...good, timestamp: '2026-12-31T00:00:00Z' }, ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading({ ...good, timestamp: '1990-01-01T00:00:00Z' }, ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading({ ...good, timestamp: undefined }, ctx, { source: 'api' }).ok, false);
});

test('rechaza no-objetos y valveState inválido (REQ-RES-01)', () => {
  assert.equal(validateReading(null, ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading([1], ctx, { source: 'api' }).ok, false);
  assert.equal(validateReading({ ...good, valveState: 'rota' }, ctx, { source: 'api' }).ok, false);
});

test('lote: separa aceptadas y rechazadas con índice, y limita el tamaño (REQ-RES-01)', () => {
  const r = validateReadingBatch([good, { nodeId: 'N-TOMA-01' }], ctx, { source: 'api' });
  assert.ok(!('fatal' in r));
  if (!('fatal' in r)) {
    assert.equal(r.accepted.length, 1);
    assert.equal(r.rejected[0].index, 1);
  }
  assert.ok('fatal' in validateReadingBatch('x', ctx, { source: 'api' }));
  assert.ok('fatal' in validateReadingBatch([], ctx, { source: 'api' }));
  assert.ok('fatal' in validateReadingBatch(new Array(MAX_BATCH_SIZE + 1).fill(good), ctx, { source: 'api' }));
});

test('clave de deduplicación normaliza la marca temporal y la huella distingue valores (REQ-RES-07)', () => {
  const a = validateReading(good, ctx, { source: 'api' });
  const b = validateReading({ ...good, timestamp: '2026-11-19T11:59:00.000Z' }, ctx, { source: 'api' });
  const c = validateReading({ ...good, flowLs: 49 }, ctx, { source: 'api' });
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) {
    assert.equal(readingDedupKey(a.reading), readingDedupKey(b.reading));
    assert.equal(readingFingerprint(a.reading), readingFingerprint(b.reading));
    assert.notEqual(readingFingerprint(a.reading), readingFingerprint(c.reading));
  }
});

test('isStructurallyValidReading detecta lecturas persistidas corruptas (REQ-RES-02)', () => {
  const v = validateReading(good, ctx, { source: 'api' });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(isStructurallyValidReading(v.reading), true);
    assert.equal(isStructurallyValidReading({ ...v.reading, pressureBar: undefined }), false);
    assert.equal(isStructurallyValidReading({ ...v.reading, timestamp: 'x' }), false);
    assert.equal(isStructurallyValidReading(null), false);
  }
});

test('CSV: Infinity, celdas vacías y fechas inválidas se rechazan (REQ-RES-01)', () => {
  const header = 'timestamp,nodeId,pressureBar,flowLs,levelPct,turbidityNtu,chlorineMgL,ph';
  const csv = [
    header,
    '2026-11-18T12:50:00Z,N-TOMA-01,1e999,48,84,1.2,0.8,7.2',
    '2026-11-18T12:50:00Z,N-TOMA-01,,48,84,1.2,0.8,7.2',
    'no-es-fecha,N-TOMA-01,1.4,48,84,1.2,0.8,7.2',
    '2026-11-18T12:50:00Z,N-TOMA-01,1.4,48,84,1.2,0.8,7.2',
  ].join('\n');
  const r = parseCsvTelemetry(csv);
  assert.equal(r.readings.length, 1);
  assert.equal(r.errors.length, 3);
  assert.equal(r.readings[0].source, 'csv');
});
