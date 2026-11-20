import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import {
  baselineLocalDemands,
  buildTopology,
  calibrateDownstreamElevations,
  hazenWilliamsHeadLossM,
  M_PER_BAR,
  solveSteadyState,
} from './hydraulicModel';

const nodes = createBaselineNodes();
const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('la red es un árbol con una única raíz y orden topológico (REQ-HYD-04)', () => {
  const t = buildTopology(nodes, NETWORK_PIPES);
  assert.equal(t.rootId, 'N-TOMA-01');
  assert.equal(t.order.length, nodes.length);
  assert.throws(() => buildTopology(nodes, [...NETWORK_PIPES, { ...NETWORK_PIPES[0], id: 'P-X', from: 'N-DIST-06', to: 'N-TRON-04' }]));
});

test('Hazen-Williams reproduce un valor de referencia calculado a mano (REQ-HYD-04)', () => {
  // 15 L/s, D200, L1000, C140 → ≈1.206 m (EPANET da 1.203 m con su exponente 4.871)
  near(hazenWilliamsHeadLossM(15, 1000, 200, 140), 1.206, 0.01);
  assert.equal(hazenWilliamsHeadLossM(0, 1000, 200, 140), 0);
  assert.ok(hazenWilliamsHeadLossM(-15, 1000, 200, 140) < 0, 'el sentido inverso invierte el signo');
});

test('REGRESIÓN DE AUDITORÍA: el solver reproduce la línea base (caudales y presiones coherentes con las cotas) (REQ-HYD-04)', () => {
  const s = solveSteadyState({ nodes, pipes: NETWORK_PIPES });
  for (const n of nodes) {
    near(s.inflowLs[n.id], n.baseline.flowLs, 0.001, `caudal ${n.id}`);
    near(s.pressureBar[n.id], n.baseline.pressureBar, 0.01, `presión ${n.id}`);
  }
});

test('las cotas de networkData son las calibradas con el solver (sin 11 bar de carga estática vs 4.5 declarados) (REQ-HYD-04)', () => {
  const cal = calibrateDownstreamElevations(nodes, NETWORK_PIPES);
  for (const [id, elev] of Object.entries(cal)) {
    near(nodes.find((n) => n.id === id)!.elevationM, elev, 0.05, `cota ${id}`);
  }
  const tank = nodes.find((n) => n.kind === 'tank')!;
  const tron = nodes.find((n) => n.id === 'N-TRON-04')!;
  const staticBar = (tank.elevationM + tank.baseline.pressureBar * M_PER_BAR - tron.elevationM) / M_PER_BAR;
  near(staticBar, tron.baseline.pressureBar, 0.5, 'la carga estática debe ser del orden de la presión declarada');
});

test('conservación de masa en cada nodo con demanda, fugas y estrangulamiento (REQ-HYD-04)', () => {
  const s = solveSteadyState({
    nodes,
    pipes: NETWORK_PIPES,
    demandFactor: 1.3,
    demandFactorByNode: { 'N-DIST-06': 1.2 },
    leaks: [{ pipeId: 'P-05', nominalFlowLs: 9 }, { pipeId: 'P-06', nominalFlowLs: 4 }],
  });
  const demands = baselineLocalDemands(nodes, NETWORK_PIPES);
  for (const n of nodes) {
    const out = NETWORK_PIPES.filter((p) => p.from === n.id).reduce((a, p) => a + s.inflowLs[p.to], 0);
    const leakHere = NETWORK_PIPES.filter((p) => p.from === n.id).reduce((a, p) => a + (s.leakFlowLs[p.id] ?? 0), 0);
    const local = demands[n.id] * 1.3 * (n.id === 'N-DIST-06' ? 1.2 : 1);
    near(s.inflowLs[n.id], local + leakHere + out, 1e-6, `balance ${n.id}`);
  }
});

test('una fuga eleva el caudal de entrada del nodo y de sus ancestros, y no el de los hijos (REQ-HYD-04)', () => {
  const base = solveSteadyState({ nodes, pipes: NETWORK_PIPES });
  const s = solveSteadyState({ nodes, pipes: NETWORK_PIPES, leaks: [{ pipeId: 'P-05', nominalFlowLs: 12 }] });
  const q = s.leakFlowLs['P-05'];
  assert.ok(q > 11 && q < 12, 'la fuga depende de la presión (baja algo porque la presión baja)');
  for (const id of ['N-TRON-04', 'N-TANQ-03', 'N-PLANTA-02', 'N-TOMA-01']) near(s.inflowLs[id] - base.inflowLs[id], q, 1e-6, id);
  near(s.inflowLs['N-DIST-06'], base.inflowLs['N-DIST-06'], 1e-9);
  near(s.inflowLs['N-VALV-05'], base.inflowLs['N-VALV-05'], 1e-9);
});

test('la fuga baja la presión por fricción solo aguas abajo del tanque; aguas arriba (bombeo) se mantiene (REQ-HYD-04)', () => {
  const base = solveSteadyState({ nodes, pipes: NETWORK_PIPES });
  const s = solveSteadyState({ nodes, pipes: NETWORK_PIPES, leaks: [{ pipeId: 'P-05', nominalFlowLs: 12 }] });
  const drop = base.pressureBar['N-TRON-04'] - s.pressureBar['N-TRON-04'];
  assert.ok(drop > 0.2 && drop < 0.5, `caída de ${drop.toFixed(3)} bar en el nodo de la fuga`);
  near(s.pressureBar['N-TOMA-01'], base.pressureBar['N-TOMA-01'], 1e-9);
  near(s.pressureBar['N-TANQ-03'], base.pressureBar['N-TANQ-03'], 1e-9);
  assert.ok(s.pressureBar['N-DIST-06'] < base.pressureBar['N-DIST-06'], 'el efecto se propaga aguas abajo');
});

test('REGRESIÓN DE AUDITORÍA: una fuga de 6.6 L/s NO produce la caída de -42% del escenario original (REQ-HYD-04)', () => {
  const base = solveSteadyState({ nodes, pipes: NETWORK_PIPES });
  const s = solveSteadyState({ nodes, pipes: NETWORK_PIPES, leaks: [{ pipeId: 'P-05', nominalFlowLs: 6.6 }] });
  const pct = (base.pressureBar['N-TRON-04'] - s.pressureBar['N-TRON-04']) / base.pressureBar['N-TRON-04'];
  assert.ok(pct < 0.06, `la física da ${(pct * 100).toFixed(1)}% de caída, no 42%`);
});

test('el acople presión-fuga converge y un cambio de carga del tanque se refleja aguas abajo (REQ-HYD-04)', () => {
  const s = solveSteadyState({ nodes, pipes: NETWORK_PIPES, leaks: [{ pipeId: 'P-06', nominalFlowLs: 8 }], tankHeadShiftM: -5 });
  assert.ok(s.iterations < 50);
  const base = solveSteadyState({ nodes, pipes: NETWORK_PIPES });
  assert.ok(s.pressureBar['N-DIST-07'] < base.pressureBar['N-DIST-07'] - 0.4);
  near(s.pressureBar['N-TANQ-03'], base.pressureBar['N-TANQ-03'] - 5 / M_PER_BAR, 1e-9);
});
