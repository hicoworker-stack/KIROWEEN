import test from 'node:test';
import assert from 'node:assert/strict';
import { clampLeak, computeSim, LEAK_RANGE, METER_UNCERTAINTY_LPS, phaseText, SIM_NODES, SIM_PHASES, SIM_PIPE_PATHS, SIM_PIPES } from './sim3dModel';

test('maqueta 3D: en operación normal el balance cierra y todos los sensores están en normal', () => {
  const s = computeSim('normal', 2.5);
  assert.equal(s.leakActive, false);
  assert.equal(s.balance.missingLps, 0);
  assert.equal(s.balance.inflowLps, s.balance.deliveredLps);
  for (const r of Object.values(s.readings)) assert.equal(r.tone, 'ok', r.nodeId);
  assert.equal(s.readings['N-DIST-06'].pressureM, 26);
});

test('maqueta 3D: la fuga hace faltar exactamente su caudal entre los dos medidores y baja la presión aguas abajo', () => {
  const normal = computeSim('normal', 2.5);
  const s = computeSim('leak', 2.5);
  assert.equal(s.balance.missingLps, 2.5);
  assert.equal(s.pipes['P-05'].up - s.pipes['P-05'].down, 2.5);
  assert.ok(s.readings['N-DIST-06'].pressureM! < normal.readings['N-DIST-06'].pressureM!);
  assert.ok(s.readings['N-TRON-04'].pressureM! < normal.readings['N-TRON-04'].pressureM!);
  assert.equal(s.readings['N-DIST-06'].tone, 'critical');
  // El ramal sur no comparte tramo con la fuga: no cambia.
  assert.deepEqual(s.readings['N-DIST-07'], normal.readings['N-DIST-07']);
  // Conservación: lo que sale del tanque es lo que entregan los dos ramales más la fuga.
  assert.equal(s.pipes['P-02'].up, s.pipes['P-05'].down + s.pipes['P-06'].down + 2.5);
});

test('maqueta 3D: una fuga más pequeña que dos veces la incertidumbre no se afirma', () => {
  const small = computeSim('detect', 0.5);
  assert.equal(small.balance.detectable, false);
  assert.match(phaseText(small), /incertidumbre/);
  assert.doesNotMatch(phaseText(small), /tramo candidato/);
  const big = computeSim('detect', 2 * METER_UNCERTAINTY_LPS + 0.1);
  assert.equal(big.balance.detectable, true);
  assert.match(phaseText(big), /tramo candidato es P-05/);
});

test('maqueta 3D: durante la reparación el tramo queda aislado y la escuela sin servicio; al verificar se recupera la operación normal', () => {
  const r = computeSim('repair', 3);
  assert.equal(r.isolated, true);
  assert.equal(r.pipes['P-05'].up, 0);
  assert.equal(r.readings['N-DIST-06'].tone, 'offline');
  assert.equal(r.readings['N-TRON-04'].statusLabel, 'Válvula cerrada');
  const v = computeSim('verified', 3);
  assert.deepEqual(v.readings, computeSim('normal', 3).readings);
  assert.equal(v.repaired, true);
  assert.match(phaseText(v), /medida, no supuesta/);
});

test('maqueta 3D: el tamaño de la fuga se acota al rango del control', () => {
  assert.equal(clampLeak(99), LEAK_RANGE.max);
  assert.equal(clampLeak(-1), LEAK_RANGE.min);
  assert.equal(clampLeak(Number.NaN), LEAK_RANGE.initial);
  assert.equal(computeSim('leak', 99).leakLps, LEAK_RANGE.max);
});

test('maqueta 3D: usa los nodos y tramos reales de la red de demostración, cada paso tiene su texto', () => {
  assert.equal(SIM_NODES.length, 7);
  for (const n of SIM_NODES) assert.notEqual(n.name, n.id, `${n.id} sin nombre de la red`);
  assert.deepEqual(SIM_PIPES.map((p) => p.id).sort(), Object.keys(SIM_PIPE_PATHS).sort());
  const ids = new Set(SIM_NODES.map((n) => n.id));
  for (const p of SIM_PIPES) assert.ok(ids.has(p.from) && ids.has(p.to), p.id);
  for (const ph of SIM_PHASES) assert.ok(phaseText(computeSim(ph.id, 2.5)).length > 40, ph.id);
});
