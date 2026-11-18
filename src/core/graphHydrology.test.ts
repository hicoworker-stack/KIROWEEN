import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeNetworkHydraulics,
  enrichAnomalyWithNetworkContext,
  evaluatePipeMassBalances,
  getDownstreamNodeIds,
} from './graphHydrology';
import { createBaselineNodes, DIFFERENTIAL_SCENARIOS, NETWORK_PIPES } from './networkData';
import { evaluateTelemetryReading } from './deterministicEngine';

test('getDownstreamNodeIds traverses directed hydraulic graph cleanly', () => {
  const fromIntake = getDownstreamNodeIds('N-TOMA-01', NETWORK_PIPES);
  assert.deepEqual(fromIntake, [
    'N-PLANTA-02',
    'N-TANQ-03',
    'N-TRON-04',
    'N-VALV-05',
    'N-DIST-06',
    'N-DIST-07',
  ]);

  const fromValve = getDownstreamNodeIds('N-VALV-05', NETWORK_PIPES);
  assert.deepEqual(fromValve, ['N-DIST-07']);
});

test('evaluatePipeMassBalances flags nodal divergence on leak scenario', () => {
  const nodes = createBaselineNodes();
  const leakScenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'leak')!;
  const updatedNodes = nodes.map((n) =>
    n.id === leakScenario.nodeId
      ? {
          ...n,
          status: 'critical' as const,
          current: {
            ...leakScenario.injectedReading,
            id: 'READ-LEAK',
            timestamp: new Date().toISOString(),
          },
        }
      : n
  );

  const balances = evaluatePipeMassBalances(updatedNodes, NETWORK_PIPES);
  const northTrunk = balances.find((b) => b.nodeId === 'N-TRON-04')!;
  assert.ok(northTrunk);
  assert.equal(northTrunk.flagged, true);
  assert.ok(northTrunk.deviationLs > 5);
});

test('analyzeNetworkHydraulics propagates downstream risk and skips sensor_fault', () => {
  const nodes = createBaselineNodes();
  const contamScenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'contamination')!;
  const intakeNode = nodes.find((n) => n.id === contamScenario.nodeId)!;
  const contamAnom = evaluateTelemetryReading(
    { ...contamScenario.injectedReading, id: 'READ-CONTAM', timestamp: new Date().toISOString() },
    intakeNode
  )!;
  const enriched = enrichAnomalyWithNetworkContext(contamAnom, nodes, NETWORK_PIPES);

  assert.equal(enriched.downstreamAffectedNodeIds?.length, 6);
  assert.equal(enriched.downstreamPopulationAffected, 4800);

  const summary = analyzeNetworkHydraulics(nodes, NETWORK_PIPES, [enriched]);
  assert.equal(summary.propagatedByNode['N-DIST-06']?.impactLevel, 'high');
  assert.ok(summary.affectedPipeIds.includes('P-01'));
  assert.ok(summary.affectedPipeIds.includes('P-05'));

  const faultScenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'sensor_fault')!;
  const tankNode = nodes.find((n) => n.id === faultScenario.nodeId)!;
  const faultAnom = evaluateTelemetryReading(
    { ...faultScenario.injectedReading, id: 'READ-FAULT', timestamp: new Date().toISOString() },
    tankNode
  )!;
  const faultSummary = analyzeNetworkHydraulics(nodes, NETWORK_PIPES, [faultAnom]);
  assert.equal(Object.keys(faultSummary.propagatedByNode).length, 0);
});

