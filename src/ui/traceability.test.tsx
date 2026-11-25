import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary, describeRenderError } from '../components/ErrorBoundary';
import { VisionIntelligenceView } from '../components/VisionIntelligenceView';
import { api, RunningServer, startServer } from '../server/testing/harness';
import { node } from './fixtures';
import type { VisionAnalysisResult } from '../core/types';

/**
 * Pruebas de requisitos antiguos que solo se verificaban «por compilación»: ahora cada uno tiene una prueba que falla si deja de cumplirse.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const noop = () => undefined;

test('REQ-RES-08: un error de renderizado no deja la pantalla en blanco: muestra qué falló, permite reintentar y tranquiliza sobre los datos', () => {
  assert.equal(describeRenderError(new Error('x'.repeat(500))).length, 300, 'el mensaje se acota');
  assert.equal(describeRenderError('texto plano'), 'texto plano');
  const boundary = new ErrorBoundary({ children: null, scope: 'Incidentes' });
  boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('dato inesperado'));
  const out = html(boundary.render() as React.ReactElement);
  assert.match(out, /role="alert"/);
  assert.match(text(out), /Error al mostrar «Incidentes»/);
  assert.match(text(out), /dato inesperado/);
  assert.match(text(out), /Los datos del servidor no se perdieron/);
  assert.match(text(out), /Reintentar/);
  const healthy = new ErrorBoundary({ children: React.createElement('p', null, 'ok') });
  assert.equal(html(healthy.render() as React.ReactElement), '<p>ok</p>', 'sin error, el contenido pasa intacto');
});

const photo = (over: Partial<VisionAnalysisResult>): VisionAnalysisResult =>
  ({ id: 'V1', nodeId: 'N-TRON-04', imageUrl: '/x.png', imageTitle: 'Foto de la troncal', providerUsed: 'Respaldo', analysisStatus: 'not_analyzed', observed: [], inferred: [], cannotDetermine: [], missingData: [], sensorCorrelationSummary: '', ...over }) as unknown as VisionAnalysisResult;

test('REQ-AI-09: el panel de visión muestra solo el análisis del nodo activo y rotula «NO analizada» una foto que ningún proveedor miró', () => {
  const nodes = [node({ id: 'N-TRON-04', name: 'Troncal' }), node({ id: 'N-VALV-05', name: 'Válvula' })];
  const props = { nodes, onSelectNode: noop, canAnalyze: true, onAnalyzeVision: async () => photo({}) };
  const own = text(html(<VisionIntelligenceView {...props} selectedNodeId="N-TRON-04" visionAnalyses={[photo({})]} />));
  assert.match(own, /Foto de la troncal/);
  assert.match(own, /NO analizada/);
  assert.match(own, /Sin observaciones: la imagen no fue analizada/, 'una foto no analizada nunca describe su contenido');
  const other = text(html(<VisionIntelligenceView {...props} selectedNodeId="N-VALV-05" visionAnalyses={[photo({})]} />));
  assert.doesNotMatch(other, /Foto de la troncal/, 'el análisis de otro nodo no se mezcla');
  const real = text(html(<VisionIntelligenceView {...props} selectedNodeId="N-TRON-04" visionAnalyses={[photo({ analysisStatus: 'analyzed', observed: ['Agua en la brida'] } as never)]} />));
  assert.match(real, /Analizada por un proveedor de visión/);
});

let srv: RunningServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
});

test('REQ-OFF-01: un reporte sin conexión se sincroniza una sola vez aunque el dispositivo reintente (clave idempotente) y se rotula como declarado', async () => {
  const report = { id: 'OFF-1', idempotencyKey: 'clave-unica-1', createdAt: new Date().toISOString(), nodeId: 'N-DIST-06', category: 'leak', reporterName: 'Vecina', description: 'Charco que no se seca' };
  const first = await api(srv.base, 'POST', '/api/sync/offline', { reports: [report] });
  assert.equal(first.status, 200);
  assert.equal(first.data.results[0].status, 'synced');
  const before = (await api(srv.base, 'GET', '/api/state')).data;
  const again = await api(srv.base, 'POST', '/api/sync/offline', { reports: [report] });
  assert.equal(again.data.results[0].status, 'duplicate', 'el reintento no crea otro incidente');
  const after = (await api(srv.base, 'GET', '/api/state')).data;
  assert.equal(after.anomalies.length, before.anomalies.length);
  assert.equal(after.ledger.length, before.ledger.length, 'ni escribe de nuevo en el ledger');
  const anomaly = after.anomalies.find((a: any) => a.id === first.data.results[0].anomalyId);
  assert.equal(anomaly.origin, 'offline-report', 'queda como reporte DECLARADO, no como medición');
  const incomplete = await api(srv.base, 'POST', '/api/sync/offline', { reports: [{ ...report, id: 'OFF-2', idempotencyKey: '' }] });
  assert.equal(incomplete.data.results[0].status, 'conflict', 'un reporte incompleto no crea ningún incidente');
  assert.equal((await api(srv.base, 'GET', '/api/state')).data.anomalies.length, before.anomalies.length);
});
