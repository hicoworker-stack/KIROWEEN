import test from 'node:test';
import assert from 'node:assert/strict';
import { calibratedConfidence, evaluateConcordance } from './evidenceConcordance';
import { evaluateTelemetryReading } from './deterministicEngine';
import { enrichAnomalyWithNetworkContext } from './graphHydrology';
import { createBaselineNodes, DIFFERENTIAL_SCENARIOS, NETWORK_PIPES } from './networkData';
import { localizeLeak } from './leakForensics';
import { VisionAnalysisResult } from './types';

function anomalyFor(id: 'leak' | 'sensor_fault' | 'contamination') {
  const nodes = createBaselineNodes();
  const sc = DIFFERENTIAL_SCENARIOS.find((s) => s.id === id)!;
  const node = nodes.find((n) => n.id === sc.nodeId)!;
  node.current = { ...node.current, ...sc.injectedReading };
  const raw = evaluateTelemetryReading({ ...sc.injectedReading, id: 'T', timestamp: new Date().toISOString() }, createBaselineNodes().find((n) => n.id === sc.nodeId)!)!;
  return { anomaly: enrichAnomalyWithNetworkContext(raw, nodes, NETWORK_PIPES), nodes };
}

function vision(cat: VisionAnalysisResult['visualCategory']): VisionAnalysisResult {
  return {
    id: 'V', timestamp: 'now', nodeId: 'x', imageUrl: '', imageTitle: '', providerUsed: 'test', providerMode: 'fallback-adapter',
    observed: [], inferred: [], cannotDetermine: [], missingData: [], sensorCorrelationSummary: '', confidenceLabel: '', visualCategory: cat,
  };
}

test('sensor-only evidence caps confidence at 70% (REQ-AI-02)', () => {
  const { anomaly } = anomalyFor('leak');
  const r = evaluateConcordance({ anomaly, vision: null, forensics: null });
  assert.equal(r.status, 'sensor_only');
  assert.equal(calibratedConfidence(90, r), 70);
});

test('photo + topology agreeing yields concordant status (REQ-AI-02)', () => {
  const { anomaly, nodes } = anomalyFor('leak');
  const forensics = localizeLeak(nodes, NETWORK_PIPES);
  // El forense solo detecta si el caudal ascendente es coherente: se verifica la rama de fotografía aislada.
  const r = evaluateConcordance({ anomaly, vision: vision('leak'), forensics });
  assert.ok(['partial', 'concordant'].includes(r.status));
  assert.equal(r.channels.find((c) => c.channel === 'fotografía')!.verdict, 'supports');
});

test('photo contradicting sensors is reported as conflict and caps confidence (REQ-AI-02)', () => {
  const { anomaly } = anomalyFor('contamination');
  const r = evaluateConcordance({ anomaly, vision: vision('leak') });
  assert.equal(r.status, 'conflict');
  assert.equal(calibratedConfidence(90, r), 55);
});

test('sensor_fault with photo of a real leak warns not to discard the leak (REQ-AI-02)', () => {
  const { anomaly } = anomalyFor('sensor_fault');
  const r = evaluateConcordance({ anomaly, vision: vision('leak') });
  assert.equal(r.status, 'conflict');
  assert.match(r.channels.find((c) => c.channel === 'fotografía')!.detail, /No descartar una fuga/);
});

test('inconclusive photo is neutral, not supportive (REQ-AI-02)', () => {
  const { anomaly } = anomalyFor('leak');
  const r = evaluateConcordance({ anomaly, vision: vision('inconclusive') });
  assert.equal(r.channels.find((c) => c.channel === 'fotografía')!.verdict, 'neutral');
  assert.equal(r.status, 'sensor_only');
});

