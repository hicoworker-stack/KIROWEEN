import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeNetworkHydraulics,
  enrichAnomalyWithNetworkContext,
  evaluatePipeMassBalances,
  getDownstreamNodeIds,
  getUpstreamNodeIds,
} from './graphHydrology';
import { createBaselineNodes, NETWORK_PIPES } from './networkData';
import { evaluateTelemetryReading } from './deterministicEngine';
import { applyFrameToNodes, buildScenarioFrames } from '../sim/scenarioGenerator';

const ts = '2026-11-19T12:00:00.000Z';

test('getDownstreamNodeIds traverses directed hydraulic graph cleanly (REQ-HYD-01)', () => {
  assert.deepEqual(getDownstreamNodeIds('N-TOMA-01', NETWORK_PIPES), ['N-PLANTA-02', 'N-TANQ-03', 'N-TRON-04', 'N-VALV-05', 'N-DIST-06', 'N-DIST-07']);
  assert.deepEqual(getDownstreamNodeIds('N-VALV-05', NETWORK_PIPES), ['N-DIST-07']);
  assert.deepEqual(getUpstreamNodeIds('N-DIST-06', NETWORK_PIPES), ['N-TRON-04']);
});

test('evaluatePipeMassBalances: la línea base es coherente y los tanques no se evalúan (REQ-HYD-03)', () => {
  const balances = evaluatePipeMassBalances(createBaselineNodes(), NETWORK_PIPES);
  assert.ok(balances.every((b) => !b.flagged));
  assert.ok(!balances.some((b) => b.nodeId === 'N-TANQ-03'), 'el tanque no es evaluable');
});

test('evaluatePipeMassBalances marca el desbalance de una rotura generada por el solver (REQ-HYD-03)', () => {
  const frames = buildScenarioFrames('leak', Date.parse(ts));
  const nodes = applyFrameToNodes(createBaselineNodes(), frames[frames.length - 1]);
  const trunk = evaluatePipeMassBalances(nodes, NETWORK_PIPES).find((b) => b.nodeId === 'N-TRON-04')!;
  assert.equal(trunk.flagged, true);
  assert.ok(trunk.deviationLs > 8, `exceso ${trunk.deviationLs}`);
});

test('REGRESIÓN DE AUDITORÍA: la demanda ×1.5 no marca ningún nodo como desbalanceado (REQ-HYD-03)', () => {
  const nodes = createBaselineNodes().map((n) => ({ ...n, current: { ...n.current, flowLs: Number((n.baseline.flowLs * 1.5).toFixed(2)) } }));
  assert.ok(evaluatePipeMassBalances(nodes, NETWORK_PIPES).every((b) => !b.flagged));
});

test('analyzeNetworkHydraulics propaga el riesgo aguas abajo y omite sensor_fault (REQ-HYD-01, REQ-ING-03)', () => {
  const nodes = createBaselineNodes();
  const intake = nodes.find((n) => n.id === 'N-TOMA-01')!;
  const contam = evaluateTelemetryReading({ ...intake.current, id: 'R', timestamp: ts, turbidityNtu: 14.8, chlorineMgL: 0.16, ph: 6.2 }, intake)!;
  const enriched = enrichAnomalyWithNetworkContext(contam, nodes, NETWORK_PIPES);
  assert.equal(enriched.downstreamAffectedNodeIds?.length, 6);
  assert.equal(enriched.downstreamPopulationAffected, 4800);
  const summary = analyzeNetworkHydraulics(nodes, NETWORK_PIPES, [enriched]);
  assert.equal(summary.propagatedByNode['N-DIST-06']?.impactLevel, 'high');
  assert.ok(summary.affectedPipeIds.includes('P-01'));
  assert.ok(summary.affectedPipeIds.includes('P-05'));

  const tank = nodes.find((n) => n.id === 'N-TANQ-03')!;
  const fault = evaluateTelemetryReading({ ...tank.current, id: 'R', timestamp: ts, pressureBar: 4.9, flowLs: 0, turbidityNtu: -1.4 }, tank)!;
  assert.equal(Object.keys(analyzeNetworkHydraulics(nodes, NETWORK_PIPES, [fault]).propagatedByNode).length, 0);
});
