import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeLeak, upstreamFlowConsequences } from './leakForensics';
import { createBaselineNodes, DIFFERENTIAL_SCENARIOS, NETWORK_PIPES } from './networkData';
import { NetworkNode } from './types';

function nodesWithLeak(applyConsequences: boolean): NetworkNode[] {
  const nodes = createBaselineNodes();
  const sc = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'leak')!;
  const node = nodes.find((n) => n.id === sc.nodeId)!;
  const lossLs = sc.injectedReading.flowLs - node.baseline.flowLs;
  node.current = { ...node.current, ...sc.injectedReading };
  if (applyConsequences) {
    for (const c of upstreamFlowConsequences(node.id, lossLs, NETWORK_PIPES)) {
      const up = nodes.find((n) => n.id === c.nodeId)!;
      up.current = { ...up.current, flowLs: Number((up.current.flowLs + c.flowDeltaLs).toFixed(2)) };
    }
  }
  return nodes;
}

test('nominal network yields no leak detection (REQ-HYD-02)', () => {
  const report = localizeLeak(createBaselineNodes(), NETWORK_PIPES);
  assert.equal(report.detected, false);
  assert.equal(report.estimatedLossLs, 0);
  assert.equal(report.suspects.length, 0);
});

test('synthetic leak with mass-conserving upstream flow localizes pipe P-05 and estimates loss (REQ-HYD-02)', () => {
  const report = localizeLeak(nodesWithLeak(true), NETWORK_PIPES, { photoNodeIds: ['N-TRON-04'] });
  assert.equal(report.detected, true);
  assert.equal(report.suspects[0].pipeId, 'P-05');
  assert.equal(report.suspects[0].probability, 1);
  assert.ok(Math.abs(report.estimatedLossLs - 6.6) < 0.05);
  assert.ok(Math.abs(report.estimatedLossM3PerDay - 570.2) < 1);
  assert.equal(report.confidence, 'alta');
  assert.equal(report.meterInconsistencies.length, 0);
});

test('meter inconsistency (outflow > inflow) is reported as calibration issue, never as a leak (REQ-HYD-02)', () => {
  const nodes = createBaselineNodes();
  // Aguas abajo del tanque se mide 12 L/s más que lo que entra: físicamente imposible sin error de medidor.
  nodes.find((n) => n.id === 'N-TRON-04')!.current.flowLs += 12;
  const report = localizeLeak(nodes, NETWORK_PIPES);
  assert.ok(report.meterInconsistencies.length > 0);
  assert.match(report.meterInconsistencies[0], /calibración/);
});

test('upstreamFlowConsequences walks every ancestor once (REQ-HYD-02)', () => {
  const ids = upstreamFlowConsequences('N-TRON-04', 6.6, NETWORK_PIPES).map((c) => c.nodeId);
  assert.deepEqual(ids, ['N-TANQ-03', 'N-PLANTA-02', 'N-TOMA-01']);
});

test('resolution note admits limits (REQ-HYD-02)', () => {
  const report = localizeLeak(nodesWithLeak(true), NETWORK_PIPES);
  assert.match(report.resolutionNote, /entre dos medidores/);
});

