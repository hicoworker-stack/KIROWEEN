import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainVisionLink,
  isVisionLinkedToAnomaly,
  PHOTO_PRE_INCIDENT_WINDOW_MS,
  selectVisionForAnomaly,
  visionRoleForAnomaly,
} from './evidenceLinking';
import { VisionAnalysisResult } from './types';

const anomaly = { id: 'ANOM-1', nodeId: 'N-TRON-04', timestamp: '2026-11-19T12:00:00.000Z', category: 'leak' as const };

function vision(over: Partial<VisionAnalysisResult> = {}): VisionAnalysisResult {
  return {
    id: 'V1',
    timestamp: '2026-11-19T12:01:00.000Z',
    nodeId: 'N-TRON-04',
    imageUrl: 'x',
    imageTitle: 'x',
    providerUsed: 't',
    providerMode: 'gemini-live',
    observed: [],
    inferred: [],
    cannotDetermine: [],
    missingData: [],
    sensorCorrelationSummary: '',
    analysisStatus: 'analyzed',
    visualCategory: 'leak',
    anomalyId: 'ANOM-1',
    ...over,
  };
}

test('una foto sin vínculo no es evidencia, aunque sea del mismo nodo (REQ-AI-05)', () => {
  const v = vision({ anomalyId: undefined });
  assert.equal(isVisionLinkedToAnomaly(v, anomaly), false);
  assert.equal(selectVisionForAnomaly([v], anomaly), null);
});

test('la foto de un incidente anterior en el mismo nodo no se reutiliza (REQ-AI-05, regresión de auditoría)', () => {
  const old = vision({ id: 'OLD', anomalyId: 'ANOM-0', timestamp: '2026-10-01T10:00:00.000Z' });
  const r = explainVisionLink(old, anomaly);
  assert.deepEqual(r, { linked: false, reason: 'otro_incidente' });
  assert.equal(selectVisionForAnomaly([old], anomaly), null);
});

test('un vínculo con otro nodo o con fecha muy anterior al incidente se rechaza (REQ-AI-05)', () => {
  assert.deepEqual(explainVisionLink(vision({ nodeId: 'N-VALV-05' }), anomaly), { linked: false, reason: 'otro_nodo' });
  const early = new Date(Date.parse(anomaly.timestamp) - PHOTO_PRE_INCIDENT_WINDOW_MS - 1000).toISOString();
  assert.deepEqual(explainVisionLink(vision({ timestamp: early }), anomaly), { linked: false, reason: 'anterior_al_incidente' });
  const justInside = new Date(Date.parse(anomaly.timestamp) - PHOTO_PRE_INCIDENT_WINDOW_MS + 1000).toISOString();
  assert.equal(explainVisionLink(vision({ timestamp: justInside }), anomaly).linked, true);
});

test('selectVisionForAnomaly devuelve la más reciente vinculada (REQ-AI-05)', () => {
  const a = vision({ id: 'A', timestamp: '2026-11-19T12:05:00.000Z' });
  const b = vision({ id: 'B', timestamp: '2026-11-19T12:20:00.000Z' });
  assert.equal(selectVisionForAnomaly([a, b], anomaly)?.id, 'B');
  assert.equal(selectVisionForAnomaly([a], null), null);
});

test('rol de la foto: no analizada, inconclusa, confirmatoria o contradictoria (REQ-AI-04)', () => {
  assert.equal(visionRoleForAnomaly(null, anomaly), 'not_analyzed');
  assert.equal(visionRoleForAnomaly(vision({ analysisStatus: 'not_analyzed', visualCategory: undefined }), anomaly), 'not_analyzed');
  assert.equal(visionRoleForAnomaly(vision({ visualCategory: 'inconclusive' }), anomaly), 'inconclusive');
  assert.equal(visionRoleForAnomaly(vision({ visualCategory: 'leak' }), anomaly), 'confirmatory');
  assert.equal(visionRoleForAnomaly(vision({ visualCategory: 'contamination' }), anomaly), 'contradictory');
});
