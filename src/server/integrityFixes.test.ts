import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from './authStore';
import { api, FAST_SCRYPT, PNG_1X1, RunningServer, Session, startServer } from './testing/harness';

/**
 * Correcciones F1, F2 y F3 de la auditoría posterior a la Fase 2 (REQ-FIX-01..03, spec 11).
 *   F1: un reporte de campo declarado ya no se cuenta como respaldo de «sensores».
 *   F2: cerrar una orden ya no escribe una lectura «restaurada»; la recuperación solo la confirma una medición posterior.
 *   F3: el flujo de eventos (SSE) se cierra cuando la sesión caduca por inactividad.
 */

let srv: RunningServer;
const get = (url: string) => api(srv.base, 'GET', url);
const post = (url: string, body?: unknown) => api(srv.base, 'POST', url, body ?? {});
const patch = (url: string, body?: unknown) => api(srv.base, 'PATCH', url, body ?? {});

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
});

/** Lleva una fuga simulada hasta una orden cerrada con checklist completo y foto sellada. */
async function closeLeakOrder(): Promise<{ orderId: string; nodeId: string; closedAt: string }> {
  const trig = await post('/api/scenarios/leak/trigger');
  assert.equal(trig.status, 200, JSON.stringify(trig.data).slice(0, 300));
  const state = (await get('/api/state')).data;
  const anomaly = state.anomalies.find((a: any) => a.status === 'active');
  const diagnosis = state.diagnoses.find((d: any) => d.anomalyId === anomaly.id && d.operatorDecision === 'pending');
  const dec = await post(`/api/diagnoses/${diagnosis.id}/decision`, { decision: 'accepted', assignee: 'Cuadrilla Norte' });
  assert.equal(dec.status, 200);
  const order = dec.data.createdOrder;
  assert.equal((await patch(`/api/work-orders/${order.id}`, { status: 'En Progreso' })).status, 200);
  for (const c of order.checklist) assert.equal((await patch(`/api/work-orders/${order.id}/checklist/${c.id}`, { done: true })).status, 200);
  assert.equal((await post(`/api/work-orders/${order.id}/evidence`, { fileName: 'cierre.png', dataUrl: PNG_1X1 })).status, 200);
  const closed = await patch(`/api/work-orders/${order.id}`, { status: 'Cerrada', closureNotes: 'Brida reemplazada' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data).slice(0, 300));
  const node = closed.data.nodes.find((n: any) => n.id === order.nodeId);
  return { orderId: order.id, nodeId: order.nodeId, closedAt: node.pendingVerification?.closedAt };
}

test('REQ-FIX-02 (F2): cerrar una orden no fabrica lecturas ni declara el punto recuperado', async () => {
  const before = (await get('/api/state')).data;
  const { orderId, nodeId, closedAt } = await closeLeakOrder();
  const s = (await get('/api/state')).data;
  const node = s.nodes.find((n: any) => n.id === nodeId);
  assert.deepEqual(node.pendingVerification, { workOrderId: orderId, closedAt }, 'el punto queda pendiente de verificación');
  assert.notEqual(node.current.source, 'restored');
  assert.ok(!s.seriesByNode[nodeId].some((r: any) => r.source === 'restored' || /^RESTORED-/.test(r.id)), 'ninguna lectura escrita por el sistema al cerrar');
  assert.ok(Date.parse(node.current.timestamp) <= Date.parse(closedAt), 'la lectura actual es la última medición de antes del cierre');
  assert.equal(s.anomalies.find((a: any) => a.nodeId === nodeId && a.status === 'active' && a.origin === 'network-balance'), undefined);
  assert.ok(before.ledger.length < s.ledger.length);
  assert.equal(s.ledger.filter((e: any) => e.action === 'POST_CLOSURE_MEASUREMENT').length, 0, 'sin medición no hay verificación');
});

test('REQ-FIX-02 (F2): lecturas de otros puntos no reabren el incidente con los datos viejos del punto cerrado', async () => {
  const s0 = (await get('/api/state')).data;
  const nodeId = s0.nodes.find((n: any) => n.pendingVerification).id;
  for (let i = 0; i < 4; i++) {
    const other = s0.nodes.find((n: any) => n.id === 'N-DIST-06');
    const b = other.baseline;
    const r = await post('/api/telemetry/ingest', { readings: [{ id: `OTRO-${i}`, nodeId: 'N-DIST-06', timestamp: new Date(Date.now() + i).toISOString(), ...b }] });
    assert.equal(r.status, 200);
  }
  const s = (await get('/api/state')).data;
  assert.ok(s.nodes.find((n: any) => n.id === nodeId).pendingVerification, 'sigue pendiente');
  assert.equal(s.anomalies.filter((a: any) => a.nodeId === nodeId && a.status === 'active').length, 0, 'no se reabrió con lecturas anteriores al cierre');
});

test('REQ-FIX-02 (F2): la primera medición posterior al cierre decide y queda en el ledger', async () => {
  const s0 = (await get('/api/state')).data;
  const node = s0.nodes.find((n: any) => n.pendingVerification);
  const { workOrderId, closedAt } = node.pendingVerification;
  // Una lectura con marca temporal ANTERIOR al cierre (p. ej. un dato rezagado) no verifica nada.
  const late = await post('/api/telemetry/ingest', { readings: [{ id: 'REZAGADA', nodeId: node.id, timestamp: new Date(Date.parse(closedAt) - 1000).toISOString(), ...node.baseline }] });
  assert.equal(late.status, 200);
  assert.ok(late.data.nodes.find((n: any) => n.id === node.id).pendingVerification, 'un dato anterior al cierre no confirma la recuperación');

  const ts = new Date(Math.max(Date.now(), Date.parse(closedAt) + 1000)).toISOString();
  const r = await post('/api/telemetry/ingest', { readings: [{ id: 'POST-CIERRE-1', nodeId: node.id, timestamp: ts, ...node.baseline }] });
  assert.equal(r.status, 200);
  const after = r.data.nodes.find((n: any) => n.id === node.id);
  assert.equal(after.pendingVerification, undefined, 'la medición posterior resuelve la verificación');
  assert.equal(after.status, 'nominal', 'recuperación MEDIDA');
  assert.equal(after.current.id, 'POST-CIERRE-1');
  assert.equal(after.current.synthetic, true, 'en esta instancia de prueba la medición sigue rotulada como simulada');
  const entry = [...r.data.ledger].reverse().find((e: any) => e.action === 'POST_CLOSURE_MEASUREMENT');
  assert.ok(entry, 'la verificación queda en el Trust Ledger');
  assert.equal(entry.evidenceData.workOrderId, workOrderId);
  assert.equal(entry.evidenceData.recovered, true);
  assert.equal(entry.evidenceData.readingId, 'POST-CIERRE-1');
  assert.equal((await post('/api/ledger/verify')).data.valid, true, 'la cadena sigue íntegra');
});

test('REQ-FIX-02 (F2): si la medición posterior sigue fuera de lo normal, se registra que la anomalía persiste', async () => {
  const { nodeId, closedAt } = await closeLeakOrder();
  const node = (await get('/api/state')).data.nodes.find((n: any) => n.id === nodeId);
  const ts = new Date(Math.max(Date.now(), Date.parse(closedAt) + 1000)).toISOString();
  const r = await post('/api/telemetry/ingest', {
    readings: [{ id: 'POST-CIERRE-MAL', nodeId, timestamp: ts, ...node.baseline, pressureBar: node.baseline.pressureBar * 0.6, flowLs: node.baseline.flowLs * 1.6 }],
  });
  assert.equal(r.status, 200);
  const entry = [...r.data.ledger].reverse().find((e: any) => e.action === 'POST_CLOSURE_MEASUREMENT');
  assert.equal(entry.evidenceData.recovered, false);
  assert.equal(entry.newState, 'anomalía persiste');
  assert.notEqual(r.data.nodes.find((n: any) => n.id === nodeId).status, 'nominal');
});

test('REQ-FIX-01 (F1): un reporte de campo declarado se cuenta como «reporte», nunca como «sensores»', async () => {
  const report = { id: 'OFF-F1', idempotencyKey: 'k-f1', createdAt: new Date().toISOString(), nodeId: 'N-DIST-06', category: 'leak', reporterName: 'Vecina', description: 'Charco que no se seca junto a la válvula' };
  const r = await post('/api/sync/offline', { reports: [report] });
  assert.equal(r.status, 200);
  const res = r.data.results[0];
  assert.equal(res.status, 'synced');
  const s = (await get('/api/state')).data;
  const anomaly = s.anomalies.find((a: any) => a.id === res.anomalyId);
  const diag = s.diagnoses.find((d: any) => d.id === res.diagnosisId);
  assert.equal(anomaly.origin, 'offline-report');
  assert.deepEqual(anomaly.rulesTriggered.map((x: any) => x.ruleId), ['FIELD_REPORT_DECLARED'], 'no se disfraza de regla sobre sensores');
  assert.ok(diag.evidenceBasis.includes('reporte'));
  assert.ok(!diag.evidenceBasis.includes('sensores'), 'el respaldo no dice «sensores»');
  assert.equal(diag.evidenceLevel, 'baja');
});

test('REQ-FIX-03 (F3): la validación pasiva de la sesión respeta la caducidad por inactividad', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-f3-'));
  let t = Date.parse('2026-11-22T10:00:00.000Z');
  const store = AuthStore.open(path.join(dir, 'auth.json'), { scrypt: FAST_SCRYPT, idleMs: 60_000, now: () => t });
  const u = await store.createUser({ username: 'pasivo', role: 'VIEWER', password: 'Valida-Reloj-2026!', createdBy: 'test' });
  const { token, session } = await store.createSession(u.id);
  assert.equal(store.isSessionValid(session.idHash), true);
  t += 59_000;
  assert.equal(store.isSessionValid(session.idHash), true, 'dentro del margen');
  assert.equal(store.isSessionValid(session.idHash), true, 'consultar no renueva la sesión');
  t += 2_000;
  assert.equal(store.isSessionValid(session.idHash), false, 'pasado el tiempo de inactividad deja de ser válida');
  assert.equal(store.resolveSession(token), null, 'y tampoco sirve para una petición');
});

test('REQ-FIX-03 (F3): el flujo SSE se cierra cuando la sesión caduca por inactividad', async () => {
  const short = await startServer({ env: { AQUA_SESSION_IDLE_MS: '1500', AQUA_SSE_PING_MS: '300' } });
  try {
    const viewer = await new Session(short.base).as('viewer');
    const ac = new AbortController();
    const res = await fetch(`${short.base}/api/events`, { headers: { cookie: viewer.cookieHeader() }, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
    await new Promise((r) => setTimeout(r, 2200)); // la sesión del visor caduca por inactividad
    // Otra persona activa genera un cambio que se difunde por SSE.
    const op = new Session(short.base);
    await op.as('admin');
    await op.request('POST', '/api/scenarios/leak/trigger', {});
    let ended = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<{ done: false; value?: undefined; wait: true }>((r) => setTimeout(() => r({ done: false, wait: true }), 500))]);
      if (next.done) {
        ended = true;
        break;
      }
      if (next.value && /state_update/.test(new TextDecoder().decode(next.value))) assert.fail('una sesión caducada no debe recibir estado');
    }
    ac.abort();
    assert.ok(ended, 'el flujo terminó al caducar la sesión por inactividad');
  } finally {
    await short.stop();
  }
});
