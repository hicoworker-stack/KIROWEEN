import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackDiagnosis,
  buildFallbackVisionAnalysis,
  classifyFallbackReason,
  DEFAULT_GEMINI_TIMEOUT_MS,
  formatFallbackProviderLabel,
} from './aiProvider';
import { createBaselineNodes, DEMO_PHOTO_ASSETS, DIFFERENTIAL_SCENARIOS } from '../core/networkData';
import { evaluateTelemetryReading } from '../core/deterministicEngine';

test('fallback reason classification and labels distinguish timeout vs api_error vs missing_key', () => {
  assert.equal(DEFAULT_GEMINI_TIMEOUT_MS >= 12000, true);
  assert.equal(classifyFallbackReason(new Error('Vision analyze timeout (14000ms)')), 'timeout');
  assert.equal(classifyFallbackReason(new Error('503 Service Unavailable')), 'api_error');

  assert.match(formatFallbackProviderLabel('vision', 'timeout'), /Timeout Gemini API/);
  assert.match(formatFallbackProviderLabel('diagnosis', 'api_error'), /Error Gemini API/);
  assert.match(formatFallbackProviderLabel('vision', 'missing_key'), /Sin API Key/);
  assert.match(formatFallbackProviderLabel('diagnosis', 'missing_key', true), /Preliminar|Inmediata/i);
});

test('provisional fallback builders mark enrichmentStatus pending without disguising as live Gemini', () => {
  const nodes = createBaselineNodes();
  const scenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'leak')!;
  const node = nodes.find((n) => n.id === scenario.nodeId)!;
  const anomaly = evaluateTelemetryReading(
    { ...scenario.injectedReading, id: 'READ-TEST', timestamp: new Date().toISOString() },
    node
  )!;

  const vis = buildFallbackVisionAnalysis(
    {
      node,
      imageUrl: DEMO_PHOTO_ASSETS.leak,
      imageTitle: scenario.imageTitle!,
      activeAnomaly: anomaly,
    },
    new Date().toISOString(),
    { provisional: true, reason: 'missing_key' }
  );
  assert.equal(vis.providerMode, 'fallback-adapter');
  assert.equal(vis.enrichmentStatus, 'pending');

  const diag = buildFallbackDiagnosis(
    { anomaly, node, visionAnalysis: vis },
    new Date().toISOString(),
    { provisional: false, reason: 'timeout' }
  );
  assert.equal(diag.providerMode, 'fallback-adapter');
  assert.equal(diag.enrichmentStatus, 'fallback');
  assert.equal(diag.fallbackReason, 'timeout');
  assert.match(diag.providerUsed, /Timeout Gemini API/);
});

