import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPreviewLeak, PREVIEW_LEAK_RANGE } from '../core/leakPreview';
import { buildLeakPreview } from './leakPreview';
import { startInProc } from './testing/inproc';

/**
 * REQ-SIM-01/02: la maqueta 3D no tiene reglas propias. Todo lo que muestra lo deciden los motores reales, y el motor es
 * honesto: no concluye una fuga cuando la evidencia no lo permite (límite documentado en sim/evaluation.test.ts).
 */
test('REQ-SIM-02: sin fuga o con una fuga bajo la incertidumbre, el motor no ve ninguna anomalía (no inventa hallazgos)', () => {
  for (const leak of [0, 1, 2]) {
    const p = buildLeakPreview(leak, 'repaired');
    assert.equal(p.engine.level, 'no_anomaly', `${leak} L/s`);
    assert.deepEqual(p.engine.candidatePipeIds, []);
  }
});

test('REQ-SIM-02: una fuga mediana se ve como anomalía de caudal, pero el motor NO afirma fuga porque la presión no discrimina', () => {
  const p = buildLeakPreview(6, 'repaired');
  assert.equal(p.engine.level, 'flow_anomaly');
  assert.equal(p.engine.pressureVerdict, 'not_discriminating');
  assert.deepEqual(p.engine.candidatePipeIds, ['P-05']);
  assert.ok(p.engine.balance!.excessLs > 5 && p.engine.balance!.excessLs < 7.5, 'el exceso medido está cerca de los 6 L/s reales, con su incertidumbre');
  assert.ok(p.engine.balance!.sigmaLs > 0);
});

test('REQ-SIM-02: la fuga de demostración (12 L/s) se localiza en el tramo P-05 con presión coherente y baja la presión aguas abajo', () => {
  const p = buildLeakPreview(12, 'repaired');
  assert.equal(p.engine.level, 'localized_leak');
  assert.deepEqual(p.engine.candidatePipeIds, ['P-05']);
  assert.equal(p.engine.pressureVerdict, 'consistent');
  assert.equal(p.leak.nodes['N-DIST-06'].tone === 'ok' && p.leak.nodes['N-TRON-04'].tone === 'ok', false, 'algún punto afectado se marca');
  assert.ok(p.leak.nodes['N-DIST-06'].pressureBar < p.normal.nodes['N-DIST-06'].pressureBar, 'baja la presión en la escuela');
  assert.ok(p.leak.nodes['N-TRON-04'].flowLs > p.normal.nodes['N-TRON-04'].flowLs + 10, 'la Troncal mide el caudal extra');
  assert.equal(p.leak.nodes['N-DIST-07'].pressureBar, p.normal.nodes['N-DIST-07'].pressureBar, 'el ramal sur no comparte tramo con la fuga: no cambia');
  assert.ok(Math.abs(p.leak.truthLeakLps - 12) < 0.5, 'la verdad simulada existe solo en la simulación');
});

test('REQ-SIM-02: tras una reparación efectiva, el motor la verifica con tres mediciones simuladas y lo declara', () => {
  const p = buildLeakPreview(12, 'repaired');
  assert.equal(p.repair.outcome, 'VERIFIED');
  assert.equal(p.repair.measuredAfter, 3);
  assert.equal(p.repair.synthetic, true);
  assert.equal(p.after.truthLeakLps, 0);
  for (const n of Object.values(p.after.nodes)) assert.equal(n.tone, 'ok');
});

test('REQ-REP-03: si la fuga persiste, la maqueta termina REOPENED; con una sola medición, INCONCLUSIVE; nunca VERIFIED', () => {
  const persists = buildLeakPreview(12, 'unresolved');
  assert.equal(persists.repair.outcome, 'REOPENED');
  assert.ok(persists.after.truthLeakLps > 10, 'la fuga sigue ahí');
  const sparse = buildLeakPreview(12, 'sparse');
  assert.equal(sparse.repair.outcome, 'INCONCLUSIVE');
  assert.equal(sparse.repair.measuredAfter, 1);
});

test('REQ-SIM-02: es determinista y cada tamaño de fuga produce un balance coherente con su verdad simulada', () => {
  assert.deepEqual(buildLeakPreview(10, 'repaired'), buildLeakPreview(10, 'repaired'));
  for (const leak of [4, 8, 12, 16]) {
    const p = buildLeakPreview(leak, 'repaired');
    assert.ok(Math.abs(p.engine.balance!.excessLs - p.leak.truthLeakLps) <= 3 * p.engine.balance!.sigmaLs, `${leak} L/s: el exceso medido concuerda con la verdad dentro de 3σ`);
  }
});

test('REQ-SIM-02: la entrada se acota al rango del control y un modo inválido no rompe nada', () => {
  assert.equal(clampPreviewLeak(999), PREVIEW_LEAK_RANGE.max);
  assert.equal(clampPreviewLeak(-3), PREVIEW_LEAK_RANGE.min);
  assert.equal(clampPreviewLeak('abc'), PREVIEW_LEAK_RANGE.initial);
  assert.equal(clampPreviewLeak(5.3), 5.5);
});

test('REQ-SIM-02: el endpoint es público de solo lectura, no toca el estado y acota la entrada', async () => {
  const srv = await startInProc({ production: true, env: { AQUA_PUBLIC_MODE: '1' } });
  try {
    const anon = srv.anon();
    const before = JSON.stringify((await anon.request('GET', '/api/state')).data.ledger);
    const ok = await anon.request('GET', '/api/preview/leak?leakLps=12&repair=repaired');
    assert.equal(ok.status, 200);
    assert.equal(ok.data.engine.level, 'localized_leak');
    assert.equal(ok.data.repair.outcome, 'VERIFIED');
    assert.equal((await anon.request('GET', '/api/preview/leak?leakLps=%27%3Bdrop&repair=zzz')).status, 200, 'entradas raras se normalizan, no fallan');
    assert.equal((await anon.request('POST', '/api/preview/leak', {})).status, 401, 'solo la lectura (GET) es pública; escribir exige sesión');
    assert.equal(JSON.stringify((await anon.request('GET', '/api/state')).data.ledger), before, 'el estado no cambia');
  } finally {
    await srv.close();
  }
});

test('REQ-SIM-02: sin modo público, la vista previa también exige sesión', async () => {
  const srv = await startInProc({ production: true });
  try {
    assert.equal((await srv.anon().request('GET', '/api/preview/leak')).status, 401);
  } finally {
    await srv.close();
  }
});
