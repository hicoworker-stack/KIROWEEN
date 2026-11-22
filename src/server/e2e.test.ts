import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DecisionDossier } from '../core/dossier';
import { buildScenarioFrames } from '../sim/scenarioGenerator';
import { verifyDossierFull } from './dossierVerify';
import { admin, anonApi, api, authedFetch, PNG_1X1, RunningServer, Session, startServer } from './testing/harness';

/**
 * Pruebas de extremo a extremo REALES: arrancan server.ts como proceso y recorren el flujo completo.
 * Sin IA externa ni red (REQ-DEMO-01). Cada bloque reproduce un defecto de la auditoría adversarial.
 */

let srv: RunningServer;
const S: { orderId: string; sha: string; anomalyId: string; visionId: string; keyPem: string; keyId: string; snapshot: any } = {
  orderId: '',
  sha: '',
  anomalyId: '',
  visionId: '',
  keyPem: '',
  keyId: '',
  snapshot: null,
};
const get = (url: string) => api(srv.base, 'GET', url);
const post = (url: string, body?: unknown, headers?: Record<string, string>) => api(srv.base, 'POST', url, body ?? {}, headers);
const patch = (url: string, body?: unknown) => api(srv.base, 'PATCH', url, body ?? {});
const clone = <T>(x: T): T => structuredClone(x);

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
});

// ───────────────────────── P0: operaciones destructivas ─────────────────────────

test('REQ-SEC-01: reset/demo/import exigen confirmación y token de operación; un POST "simple" desde otra web no pasa', async () => {
  assert.equal((await post('/api/reset')).status, 400, 'sin cabecera de confirmación');
  assert.equal((await api(srv.base, 'POST', '/api/reset', undefined, { 'x-aqua-confirm': 'reset' })).status, 401, 'sin token de operación');
  assert.equal((await post('/api/reset', {}, { 'x-aqua-confirm': 'reset', 'x-operation-token': 'token-inventado-0123456789' })).status, 401, 'token incorrecto');
  assert.equal((await post('/api/demo/frankenstein', {}, await admin('reset'))).status, 400, 'la confirmación debe nombrar la operación');
  assert.equal((await post('/api/state/import', {}, { 'x-aqua-confirm': 'import' })).status, 401);
  const text = await fetch(`${srv.base}/api/reset`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 401, 'una petición text/plain sin sesión ni cabeceras personalizadas (CSRF) se rechaza');
  const h = (await get('/api/health')).data;
  assert.equal(h.ledgerCount, 1, 'ninguno de los intentos fallidos tocó el estado');
  assert.match(h.security.destructiveOps, /reautenticación/);
});

test('REQ-SEC-01: sin usuarios ni sesión las operaciones destructivas quedan denegadas (401) y el estado intacto', async () => {
  const locked = await startServer({ noDefaultLogin: true });
  try {
    for (const op of ['reset', 'demo', 'import'] as const) {
      const url = op === 'reset' ? '/api/reset' : op === 'demo' ? '/api/demo/frankenstein' : '/api/state/import';
      assert.equal((await anonApi(locked.base, 'POST', url, {}, { 'x-aqua-confirm': op })).status, 401, op);
    }
    const s = await new Session(locked.base).as('admin');
    assert.equal((await s.request('GET', '/api/health')).data.ledgerCount, 1);
  } finally {
    await locked.stop();
  }
});
// ───────────────────────── Demo, hidráulica y reproducibilidad ─────────────────────────

test('REQ-DEMO-01/REQ-HYD-04: la demo genera datos con el solver y el diagnóstico concluye con incertidumbre, sin foto analizada ni porcentajes', async () => {
  const demo = await post('/api/demo/frankenstein', {}, await admin('demo'));
  assert.equal(demo.status, 200);
  const d = demo.data;
  assert.equal(d.demo.synthetic, true);
  assert.equal(d.anomaly.category, 'leak');
  assert.equal(d.anomaly.origin, 'network-balance', 'el incidente nace del balance de red, no de una lectura fabricada');
  assert.equal(d.anomaly.hydraulicLevel, 'localized_leak');
  assert.equal(d.anomaly.synthetic, true);
  assert.equal(d.hydraulic.level, 'localized_leak');
  const f = d.hydraulic.findings[0];
  assert.equal(f.nodeId, 'N-TRON-04');
  assert.deepEqual(f.candidates.map((c: any) => c.pipeId), ['P-05']);
  assert.ok(f.excessLs > 9 && f.excessLs < 15, `exceso estimado ${f.excessLs}`);
  assert.ok(f.sigmaLs > 0.5 && f.sigmaLs < 3, 'se reporta la incertidumbre');
  assert.equal(f.pressure.verdict, 'consistent');
  // Visión: sin proveedor, la foto no se analiza ni se infiere de su nombre.
  assert.equal(d.visionAnalysis.analysisStatus, 'not_analyzed');
  assert.equal(d.visionAnalysis.visualCategory, undefined);
  assert.deepEqual(d.visionAnalysis.observed, []);
  assert.equal(d.visionAnalysis.anomalyId, d.anomaly.id, 'la foto está vinculada a ESTE incidente');
  // Diagnóstico determinista, sin confianza numérica.
  assert.equal(d.diagnosis.providerMode, 'fallback-adapter');
  assert.equal(d.diagnosis.confidencePct, undefined);
  assert.equal(d.diagnosis.evidenceLevel, 'media');
  assert.ok(d.diagnosis.evidenceBasis.includes('hidráulica') && !d.diagnosis.evidenceBasis.includes('fotografía'));
  assert.ok(d.diagnosis.availableEvidences.some((e: string) => /NO analizada/.test(e)));
  assert.equal(d.persistence.mode, 'disk');
  for (const n of d.nodes) for (const k of ['pressureBar', 'flowLs', 'levelPct', 'turbidityNtu', 'chlorineMgL', 'ph']) assert.ok(Number.isFinite(n.current[k]));
  S.anomalyId = d.anomaly.id;
  S.visionId = d.visionAnalysis.id;
  S.orderId = '';
  const keys = (await get('/api/seal/public-key')).data;
  S.keyPem = keys.publicKeyPem;
  S.keyId = keys.keyId;
});

test('REQ-HYD-04: la demo es reproducible (mismas cifras con la misma semilla)', async () => {
  const first = (await get('/api/state')).data;
  const again = (await post('/api/demo/frankenstein', {}, await admin('demo'))).data;
  const a = first.hydraulic.findings[0];
  const b = again.hydraulic.findings[0];
  assert.equal(a.excessLs, b.excessLs);
  assert.equal(a.sigmaLs, b.sigmaLs);
  assert.equal(first.diagnoses[0].primaryHypothesis, again.diagnosis.primaryHypothesis);
  assert.deepEqual(
    first.seriesByNode['N-TRON-04'].slice(-6).map((r: any) => [r.pressureBar, r.flowLs]),
    again.seriesByNode['N-TRON-04'].slice(-6).map((r: any) => [r.pressureBar, r.flowLs])
  );
  S.anomalyId = again.anomaly.id;
  S.visionId = again.visionAnalysis.id;
});

test('REQ-RES-09: reset y demo archivan el estado anterior y enlazan la cadena nueva con la cabeza de la anterior', async () => {
  const backups = path.join(srv.dir, 'backups');
  assert.ok(fs.existsSync(backups) && fs.readdirSync(backups).length >= 2, 'cada reinicio archiva el estado previo');
  const ledger = (await get('/api/state')).data.ledger;
  const genesis = ledger[0].evidenceData.previousChain;
  assert.ok(genesis && genesis.height > 0 && /^[a-f0-9]{64}$/.test(genesis.headHash), 'el génesis referencia la cabeza anterior');
  assert.equal(genesis.anchor.payload.kind, 'ledger-anchor');
  assert.equal((await post('/api/ledger/verify')).data.valid, true);
});

// ───────────────────────── Órdenes: concurrencia, evidencia y cierre sellado ─────────────────────────

test('REQ-RES-04: 4 casillas y 5 reasignaciones en paralelo no pierden actualizaciones y ledger y orden coinciden', async () => {
  const state = (await get('/api/state')).data;
  const diag = state.diagnoses[0];
  assert.equal((await post(`/api/diagnoses/${diag.id}/decision`, { decision: 'accepted', assignee: ' ' })).status, 400, 'responsable inválido');
  const dec = await post(`/api/diagnoses/${diag.id}/decision`, { decision: 'accepted', assignee: 'Cuadrilla Norte' });
  assert.equal(dec.status, 200);
  assert.equal((await post(`/api/diagnoses/${diag.id}/decision`, { decision: 'rejected' })).status, 409, 'no se decide dos veces');
  const order = dec.data.createdOrder;
  S.orderId = order.id;
  assert.ok(order.checklist.length >= 3);

  const toggles = await Promise.all(order.checklist.map((c: any) => patch(`/api/work-orders/${order.id}/checklist/${c.id}`, { done: true })));
  assert.ok(toggles.every((r) => r.status === 200));
  const names = ['Ana', 'Beto', 'Carla', 'Diego', 'Elena'];
  await Promise.all(names.map((n) => patch(`/api/work-orders/${order.id}/assignee`, { assignee: n })));

  const after = (await get('/api/state')).data;
  const o = after.workOrders.find((w: any) => w.id === order.id);
  assert.equal(o.checklist.filter((c: any) => c.done).length, order.checklist.length, 'ninguna casilla se perdió');
  const completed = after.ledger.filter((e: any) => e.action === 'CHECKLIST_ITEM_COMPLETED' && e.evidenceData.workOrderId === order.id).length;
  assert.equal(completed, order.checklist.length);
  const lastAssigned = [...after.ledger].reverse().find((e: any) => e.action === 'WORK_ORDER_ASSIGNED');
  assert.equal(o.assignee, lastAssigned.evidenceData.to, 'el responsable de la orden es el último registrado en el ledger');
  const consistency = (await get('/api/state/consistency')).data;
  assert.deepEqual(consistency.issues.filter((i: any) => i.severity === 'error'), []);
});

test('REQ-WO-03: la foto de cierre se valida por firma real; el cierre se bloquea sin ella', async () => {
  const id = S.orderId;
  assert.equal((await post(`/api/work-orders/${id}/evidence`, { fileName: 'x.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 415);
  const fake = `data:image/png;base64,${Buffer.from('esto no es un png').toString('base64')}`;
  assert.equal((await post(`/api/work-orders/${id}/evidence`, { fileName: 'falsa.png', dataUrl: fake })).status, 400, 'extensión PNG con bytes de texto');
  const blocked = await patch(`/api/work-orders/${id}`, { status: 'Cerrada', closureNotes: 'x' });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.data.blockers.some((b: string) => /fotográfica/.test(b)));
  const ok = await post(`/api/work-orders/${id}/evidence`, { fileName: '..\\cierre.png', dataUrl: PNG_1X1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.workOrder.closureEvidence.fileName, 'cierre.png');
  S.sha = ok.data.workOrder.closureEvidence.sha256;
  const img = await authedFetch(srv.base, `/api/evidence/${S.sha}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await get('/api/evidence/' + '0'.repeat(64))).status, 404);
  assert.equal((await get('/api/evidence/..%2F..%2Fpackage.json')).status, 404);
});

test('REQ-LED-03/05: el cierre sella el expediente COMPLETO; verificado con la clave fijada, y cada alteración se detecta', async () => {
  const closed = await patch(`/api/work-orders/${S.orderId}`, { status: 'Cerrada', closureNotes: 'Brida reemplazada' });
  assert.equal(closed.status, 200);
  const order = closed.data.workOrder;
  assert.match(order.seal.dossierDigest, /^[a-f0-9]{64}$/);
  assert.equal(order.seal.receipt.payload.keyId, S.keyId);
  assert.equal((await patch(`/api/work-orders/${S.orderId}`, { status: 'En Progreso' })).status, 409, 'una orden cerrada no se reabre');
  // F2 corregido: cerrar no fabrica una lectura ni declara el punto estable; queda pendiente de verificación.
  const closedNode = closed.data.nodes.find((n: any) => n.id === 'N-TRON-04');
  assert.notEqual(closedNode.status, 'nominal', 'sin medición posterior no se declara recuperado');
  assert.equal(closedNode.pendingVerification.workOrderId, S.orderId);
  assert.ok(!closed.data.seriesByNode['N-TRON-04'].some((r: any) => r.source === 'restored'), 'ninguna lectura "restaurada"');

  const res = await get(`/api/work-orders/${S.orderId}/dossier`);
  assert.equal(res.status, 200);
  const dossier = res.data as DecisionDossier;
  assert.equal(dossier.format, 'aqua-sentinel-dossier/2');
  assert.ok(dossier.sealed.hydraulic && dossier.sealed.anomaly && dossier.sealed.diagnosis && dossier.sealed.telemetry, 'contiene todo lo sellado');
  assert.equal((dossier.sealed.hydraulic as any).level, 'localized_leak', 'la forense se calculó ANTES de restaurar el nodo');
  assert.ok(dossier.anchor && dossier.issuer);

  const good = await verifyDossierFull(dossier, { trustedPublicKeyPem: S.keyPem });
  assert.equal(good.overall, 'verified', JSON.stringify([...good.integrity.checks, ...good.authenticity.checks].filter((c) => !c.ok)));
  assert.equal((await verifyDossierFull(dossier)).overall, 'integrity-only', 'sin clave fijada solo hay integridad');

  const tampers: Array<[string, (d: DecisionDossier) => void]> = [
    ['responsable', (d) => { d.sealed.order.assignee = 'Otra persona'; }],
    ['prioridad', (d) => { d.sealed.order.priority = 'Baja'; }],
    ['telemetría de la anomalía', (d) => { d.sealed.anomaly!.telemetrySnapshot.pressureBar = 99; }],
    ['diagnóstico', (d) => { d.sealed.diagnosis!.primaryHypothesis = 'Falsa'; }],
    ['análisis hidráulico', (d) => { (d.sealed.hydraulic as any).level = 'no_anomaly'; }],
    ['foto', (d) => { d.evidencePhoto!.base64 = Buffer.from('otra').toString('base64'); }],
    ['truncar el ledger', (d) => { d.ledger = d.ledger.slice(0, -1); }],
    ['syntheticData', (d) => { d.syntheticData = false; }],
  ];
  for (const [label, fn] of tampers) {
    const d = clone(dossier);
    fn(d);
    assert.equal((await verifyDossierFull(d, { trustedPublicKeyPem: S.keyPem })).overall, 'invalid', `no se detectó: ${label}`);
  }
  const viaApi = await post('/api/dossier/verify', { dossier, trustedKeyId: S.keyId });
  assert.equal(viaApi.data.verification.overall, 'verified');
  assert.equal((await post('/api/dossier/verify', { dossier, trustedKeyId: 'f'.repeat(64) })).data.verification.overall, 'invalid');
});

// ───────────────────────── Entradas inválidas y deduplicación ─────────────────────────

test('REQ-RES-01/02: lecturas malformadas se rechazan, no corrompen el estado y la interfaz no queda en blanco', async () => {
  const bad = await post('/api/telemetry/ingest', { readings: [{ nodeId: 'N-TOMA-01' }] });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.ingestedCount, 0);
  assert.equal(bad.data.rejected.length, 1);
  const fields = ['pressureBar', 'flowLs', 'levelPct', 'turbidityNtu', 'chlorineMgL', 'ph'];
  const state = (await get('/api/state')).data;
  for (const n of state.nodes) for (const k of fields) assert.ok(Number.isFinite(n.current[k]), `${n.id}.${k}`);
  const now = new Date().toISOString();
  const worse = await post('/api/telemetry/ingest', { readings: [{ nodeId: 'N-TOMA-01', timestamp: now, pressureBar: 'abc', flowLs: null, levelPct: -500, turbidityNtu: 1e9, chlorineMgL: 'x', ph: 99 }] });
  assert.equal(worse.data.ingestedCount, 0);
  assert.equal((await post('/api/telemetry/ingest', { readings: 'no es una lista' })).status, 400);
  assert.equal((await post('/api/telemetry/ingest', {})).status, 400);
  const badJson = await authedFetch(srv.base, `/api/telemetry/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{roto' });
  assert.equal(badJson.status, 400);
  assert.ok(srv.isAlive());
});

test('REQ-RES-07: lecturas duplicadas se deduplican por nodo y marca temporal; 4 filas idénticas ya no son un "sensor congelado"', async () => {
  const ts = new Date(Date.now() - 30_000).toISOString();
  const row = { nodeId: 'N-DIST-07', timestamp: ts, pressureBar: 3.7, flowLs: 11.6, levelPct: 0, turbidityNtu: 0.6, chlorineMgL: 0.8, ph: 7.3 };
  const first = await post('/api/telemetry/ingest', { readings: [row] });
  assert.equal(first.data.ingestedCount, 1);
  const again = await post('/api/telemetry/ingest', { readings: [row, row, row, row] });
  assert.equal(again.data.ingestedCount, 0);
  assert.equal(again.data.duplicates, 4);
  assert.ok(!again.data.detectedAnomalies.some((a: any) => a.category === 'sensor_fault'));
  const conflict = await post('/api/telemetry/ingest', { readings: [{ ...row, flowLs: 12.5 }] });
  assert.ok(conflict.data.errors.some((e: string) => /ya existe/.test(e)));
});

test('REQ-RES-01: un cliente no puede hacerse pasar por dato real (synthetic:false se ignora)', async () => {
  const r = await post('/api/telemetry/ingest', {
    readings: [{ nodeId: 'N-DIST-06', timestamp: new Date().toISOString(), pressureBar: 3.9, flowLs: 14.2, levelPct: 0, turbidityNtu: 9, chlorineMgL: 0.82, ph: 7.2, synthetic: false }],
  });
  assert.equal(r.data.detectedAnomalies[0].synthetic, true);
  const node = r.data.nodes.find((n: any) => n.id === 'N-DIST-06');
  assert.equal(node.current.synthetic, true);
});

// ───────────────────────── Offline, visión y evidencia obsoleta ─────────────────────────

test('REQ-RES-03: un reporte offline POSTERIOR al cierre es una incidencia nueva; uno ANTERIOR se marca para revisión', async () => {
  const newer = { id: 'OFF-NEW', idempotencyKey: 'k-new', createdAt: new Date().toISOString(), nodeId: 'N-TRON-04', category: 'leak', reporterName: 'Vecino', description: 'NUEVA fuga visible en la calle' };
  const older = { id: 'OFF-OLD', idempotencyKey: 'k-old', createdAt: '2020-01-01T00:00:00.000Z', nodeId: 'N-TRON-04', category: 'leak', reporterName: 'Vecino', description: 'Fuga que ya se reparó' };
  const r = await post('/api/sync/offline', { reports: [newer, older, newer, { ...newer, id: 'X', idempotencyKey: 'k-x', category: 'nominal' }] });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.results.slice().reverse().map((x: any) => [x.id, x]));
  assert.equal(r.data.results[2].status, 'duplicate', 'reenvío en el mismo lote es idempotente');
  assert.equal(byId['OFF-NEW'].status, 'synced');
  assert.equal(byId['OFF-OLD'].status, 'conflict');
  assert.match(byId['OFF-OLD'].note, /anterior al cierre/);
  assert.equal(byId['X'].status, 'conflict', 'categoría inválida');
  const anomalies = r.data.anomalies;
  assert.equal(anomalies.find((a: any) => a.id === 'ANOM-OFF-OFF-NEW').status, 'active');
  assert.equal(anomalies.find((a: any) => a.id === 'ANOM-OFF-OFF-OLD').status, 'resolved');
  assert.equal(r.data.nodes.find((n: any) => n.id === 'N-TRON-04').status, 'critical', 'la nueva incidencia sí actualiza el nodo');
  const dup = await post('/api/sync/offline', { reports: [newer] });
  assert.equal(dup.data.results[0].status, 'duplicate');
});

test('REQ-SEC-02/REQ-AI-04: visión sin proveedor deja la imagen "no analizada"; un traversal o una imagen falsa no se procesan', async () => {
  const traversal = await post('/api/ai/vision-analyze', { nodeId: 'N-TOMA-01', imageUrl: '/src/assets/images/../../package.json', imageTitle: 'fuga' });
  assert.equal(traversal.status, 200);
  assert.equal(traversal.data.analysis.analysisStatus, 'not_analyzed');
  assert.equal(traversal.data.analysis.fallbackReason, 'no_image');
  const fake = await post('/api/ai/vision-analyze', { nodeId: 'N-TOMA-01', imageBase64: Buffer.from('<svg/>').toString('base64'), imageMimeType: 'image/png' });
  assert.equal(fake.status, 400);
  const real = await post('/api/ai/vision-analyze', { nodeId: 'N-DIST-06', imageBase64: PNG_1X1.split(',')[1], imageMimeType: 'image/png', imageTitle: 'FUGA ENORME EN LA CALLE' });
  assert.equal(real.status, 200);
  assert.equal(real.data.analysis.analysisStatus, 'not_analyzed');
  assert.equal(real.data.analysis.visualCategory, undefined, 'el título "fuga" no clasifica la imagen');
  assert.match(real.data.analysis.imageUrl, /^\/api\/evidence\/[a-f0-9]{64}$/, 'no se guarda el data URL dentro del estado');
  assert.equal(real.data.linked, true, 'vinculada al incidente activo del nodo');
  assert.equal((await post('/api/ai/vision-analyze', { nodeId: 'N-NOEXISTE' })).status, 404);
});

test('REQ-AI-05: la foto de un incidente anterior no se reutiliza como evidencia de uno nuevo', async () => {
  const again = await post('/api/scenarios/leak/trigger');
  assert.equal(again.status, 200);
  const a2 = again.data.anomaly;
  assert.notEqual(a2.id, S.anomalyId, 'es un incidente nuevo');
  assert.equal(again.data.visionAnalysis.anomalyId, a2.id);
  const f = (await get(`/api/anomalies/${a2.id}/forensics`)).data;
  assert.equal(f.vision.anomalyId, a2.id);
  const stale = await post('/api/ai/diagnose', { anomalyId: a2.id, visionAnalysisId: S.visionId });
  assert.equal(stale.status, 409, 'una foto de otro incidente se rechaza explícitamente');
  const ok = await post('/api/ai/diagnose', { anomalyId: a2.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.diagnosis.visionAnalysisId, again.data.visionAnalysis.id);
});

// ───────────────────────── Resiliencia ─────────────────────────

test('REQ-RES-05: si el disco falla el servidor NO cae, informa "solo memoria" y se recupera solo', async () => {
  const file = srv.statePath;
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file); // el destino de la escritura atómica deja de poder reemplazarse
  try {
    const during = await post('/api/telemetry/ingest', {
      readings: [{ nodeId: 'N-DIST-07', timestamp: new Date().toISOString(), pressureBar: 3.69, flowLs: 11.7, levelPct: 0, turbidityNtu: 0.6, chlorineMgL: 0.8, ph: 7.3 }],
    });
    assert.equal(during.status, 200, 'la operación se completa en memoria');
    assert.equal(during.data.persistence.mode, 'memory-only');
    assert.ok(during.data.persistence.lastError);
    assert.ok(srv.isAlive(), 'el proceso sigue vivo');
    const h = (await get('/api/health')).data;
    assert.equal(h.persistence.mode, 'memory-only');
    assert.equal((await get('/api/state')).status, 200);
  } finally {
    fs.rmSync(file, { recursive: true, force: true });
  }
  const recovered = await post('/api/telemetry/ingest', {
    readings: [{ nodeId: 'N-DIST-07', timestamp: new Date(Date.now() + 1000).toISOString(), pressureBar: 3.7, flowLs: 11.6, levelPct: 0, turbidityNtu: 0.6, chlorineMgL: 0.8, ph: 7.3 }],
  });
  assert.equal(recovered.data.persistence.mode, 'disk');
  assert.ok(fs.existsSync(file));
});

test('REQ-RES-06: rutas inexistentes y errores no tumban el servidor; el estado persiste tras reiniciar y la clave de sellado se conserva', async () => {
  const nf = await get('/api/no-existe');
  assert.equal(nf.status, 404);
  assert.equal((await get('/api/work-orders/OT-999/dossier')).status, 404);
  assert.equal((await get('/api/work-orders/' + S.orderId + '/dossier/verify')).data.verification.overall, 'verified');

  const before = (await get('/api/state')).data;
  await srv.restart();
  const after = (await get('/api/state')).data;
  assert.equal(after.ledger.length, before.ledger.length);
  assert.equal(after.workOrders.find((w: any) => w.id === S.orderId).status, 'Cerrada');
  assert.equal((await get('/api/seal/public-key')).data.keyId, S.keyId, 'la clave de sellado persiste');
  const dossier = (await get(`/api/work-orders/${S.orderId}/dossier`)).data as DecisionDossier;
  assert.equal((await verifyDossierFull(dossier, { trustedPublicKeyPem: S.keyPem })).overall, 'verified', 'el expediente sigue verificándose tras reiniciar');
  assert.equal((await get('/api/health')).data.integrity.status, 'ok');
});

test('REQ-LED-07: snapshot: se rechaza si las órdenes no coinciden con el ledger o la cadena está alterada; el íntegro restaura todo', async () => {
  const snap = (await get('/api/state/export')).data;
  assert.equal(snap.format, 'aqua-sentinel-snapshot/2');
  assert.ok(Object.keys(snap.evidence).includes(S.sha));
  S.snapshot = snap;

  const badOrder = clone(snap);
  badOrder.state.workOrders.find((w: any) => w.id === S.orderId).assignee = 'Alterado en snapshot';
  const r1 = await post('/api/state/import', badOrder, await admin('import'));
  assert.equal(r1.status, 422);
  assert.ok(r1.data.errors.some((e: string) => /assignee_mismatch/.test(e)));

  const badSeal = clone(snap);
  (badSeal.state.sealedDossiers[S.orderId].order as any).priority = 'Baja';
  assert.equal((await post('/api/state/import', badSeal, await admin('import'))).status, 422, 'un expediente sellado alterado en el snapshot');

  const badChain = clone(snap);
  badChain.state.ledger[1].evidenceSummary = 'manipulado';
  assert.equal((await post('/api/state/import', badChain, await admin('import'))).status, 422);
  assert.equal((await post('/api/state/import', snap)).status, 400, 'sin cabecera de confirmación');
});

test('REQ-RES-09/REQ-LED-07: tras un reset (archivado) el snapshot íntegro se restaura con su orden, su foto y su expediente verificables', async () => {
  const reset = await post('/api/reset', {}, await admin('reset'));
  assert.equal(reset.status, 200);
  assert.ok(reset.data.archivedTo);
  assert.equal(reset.data.ledger.length, 1);
  assert.equal((await get(`/api/work-orders/${S.orderId}/dossier`)).status, 404);

  const restored = await post('/api/state/import', S.snapshot, await admin('import'));
  assert.equal(restored.status, 200, JSON.stringify(restored.data).slice(0, 400));
  const state = (await get('/api/state')).data;
  assert.equal(state.workOrders.find((w: any) => w.id === S.orderId).status, 'Cerrada');
  assert.equal(state.ledger[state.ledger.length - 1].action, 'STATE_RESTORED_FROM_SNAPSHOT');
  assert.equal((await post('/api/ledger/verify')).data.valid, true);
  assert.equal((await authedFetch(srv.base, `/api/evidence/${S.sha}`)).status, 200);
  const dossier = (await get(`/api/work-orders/${S.orderId}/dossier`)).data as DecisionDossier;
  assert.equal((await verifyDossierFull(dossier, { trustedPublicKeyPem: S.keyPem })).overall, 'verified');
  assert.ok((await get('/api/state/consistency')).data.issues.every((i: any) => i.severity !== 'error'));
});

test('REQ-AI-03: sin clave de Gemini la sonda es honesta y el estado no afirma "en vivo"', async () => {
  const probe = await post('/api/ai/probe');
  assert.equal(probe.data.configured, false);
  assert.equal(probe.data.ok, false);
  const h = (await get('/api/health')).data;
  assert.equal(h.aiMode, 'fallback-adapter');
  assert.match(h.visionProvider, /no analizadas/i);
  assert.match(h.awsAdapters.s3, /SIMULADO/);
  assert.equal(h.persistence.kind, 'local-file');
});

test('REQ-HYD-03: una única muestra con exceso NO crea incidente; la segunda consecutiva sí (persistencia exigida)', async () => {
  assert.equal((await post('/api/reset', {}, await admin('reset'))).status, 200);
  const base = Date.now() - 20 * 60_000;
  const frames = buildScenarioFrames('leak', base);
  const last = frames[frames.length - 1];
  const shift = (ms: number) => last.readings.map((r: any) => ({ ...r, timestamp: new Date(new Date(r.timestamp).getTime() + ms).toISOString() }));
  // Historia sin fuga: los primeros fotogramas del generador son nominales.
  for (const f of frames.slice(0, 3)) assert.equal((await post('/api/telemetry/ingest', { readings: f.readings })).status, 200);
  const nominal = (await get('/api/state')).data.anomalies.filter((a: any) => a.status === 'active').length;
  assert.equal(nominal, 0, 'sin fuga no hay incidentes');
  assert.equal((await post('/api/telemetry/ingest', { readings: shift(5 * 60_000) })).status, 200);
  const one = (await get('/api/state')).data.anomalies.filter((a: any) => a.status === 'active' && a.origin === 'network-balance');
  assert.equal(one.length, 0, 'una sola muestra con exceso no basta');
  assert.equal((await post('/api/telemetry/ingest', { readings: shift(6 * 60_000) })).status, 200);
  const two = (await get('/api/state')).data.anomalies.filter((a: any) => a.status === 'active' && a.origin === 'network-balance');
  assert.ok(two.length >= 1, 'la segunda muestra consecutiva confirma el incidente');
});
