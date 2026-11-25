import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeakPreview } from '../server/leakPreview';
import { buildSimView, engineSummary, fmt1, phaseText, SIM_NODES, SIM_PHASES, SIM_PIPE_PATHS, SIM_PIPES, SimPhase } from './sim3dModel';

/**
 * REQ-SIM-01: la maqueta 3D no tiene física ni umbrales propios: dibuja y narra lo que concluyen los motores reales
 * (src/server/leakPreview.ts). Estas pruebas fijan que cada paso corresponde a la instantánea correcta y que el texto cita
 * las cifras del motor, incluidas sus negativas a concluir.
 */
const view = (phase: SimPhase, leak = 12, mode: 'repaired' | 'unresolved' | 'sparse' = 'repaired') => {
  const preview = buildLeakPreview(leak, mode);
  return { preview, sim: buildSimView(phase, preview) };
};

test('REQ-SIM-01: los cinco pasos usan los nombres de estado del producto y la geometría usa los nodos y tramos reales de la red', () => {
  assert.deepEqual(SIM_PHASES.map((p) => p.label), ['Operación normal', 'Anomalía', 'Investigación', 'Intervención', 'Verificación']);
  assert.equal(SIM_NODES.length, 7);
  for (const n of SIM_NODES) assert.notEqual(n.name, n.id, `${n.id} sin nombre de la red`);
  assert.deepEqual(SIM_PIPES.map((p) => p.id).sort(), Object.keys(SIM_PIPE_PATHS).sort());
  const ids = new Set(SIM_NODES.map((n) => n.id));
  for (const p of SIM_PIPES) assert.ok(ids.has(p.from) && ids.has(p.to), p.id);
});

test('REQ-SIM-01: operación normal sin fuga ni alertas; la anomalía muestra la fuga simulada y sus efectos en los sensores', () => {
  const normal = view('normal').sim;
  assert.equal(normal.leakActive, false);
  for (const r of Object.values(normal.readings)) assert.equal(r.tone, 'ok', r.nodeId);
  const leak = view('leak').sim;
  assert.equal(leak.leakActive, true);
  assert.ok(Math.abs(leak.leakLps - 12) < 0.5);
  assert.ok(leak.readings['N-DIST-06'].pressureBar < normal.readings['N-DIST-06'].pressureBar);
  assert.ok(leak.pipes['P-05'].up - leak.pipes['P-05'].down > 10, 'antes de la fuga pasa más agua que después');
});

test('REQ-SIM-01: la investigación cita las cifras del motor y cambia de conclusión con el tamaño de la fuga (sin inventar hallazgos)', () => {
  const big = view('detect', 12);
  assert.match(phaseText(big.sim, big.preview), /fuga localizada/);
  assert.ok(phaseText(big.sim, big.preview).includes(fmt1(big.preview.engine.balance!.excessLs)), 'el texto incluye el exceso que midió el motor');
  assert.match(engineSummary(big.preview.engine), /exceso de .* ± .* L\/s \(el motor exige superar/);
  const mid = view('detect', 6);
  assert.match(phaseText(mid.sim, mid.preview), /NO afirma que haya una fuga/);
  const small = view('detect', 1);
  assert.match(phaseText(small.sim, small.preview), /no afirma nada/);
  assert.doesNotMatch(phaseText(small.sim, small.preview), /fuga localizada|NO afirma que haya una fuga/);
});

test('REQ-SIM-01: durante la intervención se aísla el tramo y la escuela queda sin servicio; cerrar la orden no verifica nada', () => {
  const { sim, preview } = view('repair');
  assert.equal(sim.isolated, true);
  assert.deepEqual(sim.pipes['P-05'], { up: 0, down: 0 });
  assert.equal(sim.readings['N-DIST-06'].tone, 'offline');
  assert.equal(sim.readings['N-TRON-04'].statusLabel, 'Válvula cerrada');
  assert.equal(sim.verdict, null, 'en este paso todavía no hay veredicto');
  assert.match(phaseText(sim, preview), /no demuestra que funcionó/);
});

test('REQ-SIM-01/REQ-REP-03: la verificación refleja el veredicto del motor: VERIFIED recupera la red, REOPENED reactiva la fuga, INCONCLUSIVE no se presenta como recuperado', () => {
  const ok = view('verified', 12, 'repaired');
  assert.equal(ok.sim.verdict, 'VERIFIED');
  assert.equal(ok.sim.leakActive, false);
  assert.equal(ok.sim.readings['N-TRON-04'].tone, 'ok');
  assert.match(phaseText(ok.sim, ok.preview), /VERIFICADA y sella el veredicto/);
  assert.match(phaseText(ok.sim, ok.preview), /datos simulados/);

  const bad = view('verified', 12, 'unresolved');
  assert.equal(bad.sim.verdict, 'REOPENED');
  assert.equal(bad.sim.leakActive, true, 'la fuga sigue activa en la maqueta');
  assert.equal(bad.sim.repaired, false);
  assert.match(phaseText(bad.sim, bad.preview), /reabre el caso/);

  const thin = view('verified', 12, 'sparse');
  assert.equal(thin.sim.verdict, 'INCONCLUSIVE');
  assert.equal(thin.sim.readings['N-TRON-04'].statusLabel, 'En verificación', 'con una sola medición el punto no se muestra como recuperado');
  assert.notEqual(thin.sim.readings['N-TRON-04'].tone, 'ok');
  assert.match(phaseText(thin.sim, thin.preview), /nunca se declara recuperado con evidencia insuficiente/);
});
