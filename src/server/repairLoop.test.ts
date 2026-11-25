import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, RunningServer, Session, startServer } from './testing/harness';
import { runLeakToClosedOrder } from './testing/flows';

/**
 * REQ-REP-02/03/04/06: el ciclo completo con los motores reales. La orden se cierra, llegan mediciones posteriores (simuladas por
 * el solver, rotuladas como tales) y el motor decide VERIFIED, REOPENED o INCONCLUSIVE. Solo los dos primeros se sellan en el
 * ledger, y el expediente exportado recomputa el veredicto sin confiar en el servidor.
 */
let srv: RunningServer;
const get = (url: string) => api(srv.base, 'GET', url);
const post = (url: string, body?: unknown) => api(srv.base, 'POST', url, body ?? {});
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
});
const verdicts = (ledger: any[], orderId: string) => ledger.filter((e) => /^REPAIR_/.test(e.action) && e.evidenceData.workOrderId === orderId);

test('REQ-REP-02/04, REQ-WO-01, REQ-ARCH-01: la reparación efectiva se verifica con tres mediciones simuladas y el expediente recomputa el veredicto', async () => {
  const { orderId, nodeId } = await runLeakToClosedOrder(srv.base);
  const r = await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'repaired' });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const s = (await get('/api/state')).data;
  const node = s.nodes.find((n: any) => n.id === nodeId);
  assert.equal(node.pendingVerification, undefined);
  assert.equal(node.status, 'nominal');
  const [verdict, ...rest] = verdicts(s.ledger, orderId);
  assert.equal(rest.length, 0, 'un único veredicto sellado');
  assert.equal(verdict.action, 'REPAIR_VERIFIED');
  assert.equal(verdict.evidenceData.assessment.synthetic, true, 'se declara que la verificación es sobre datos simulados');
  assert.equal(verdict.evidenceData.assessment.measuredAfter, 3);
  const injected = s.ledger.find((e: any) => e.action === 'SIMULATED_MEASUREMENTS_INJECTED' && e.evidenceData.workOrderId === orderId);
  assert.ok(injected && injected.evidenceData.synthetic === true, 'queda constancia de que las mediciones fueron simuladas y quién las pidió');
  assert.equal((await post('/api/ledger/verify')).data.valid, true);
  const v = (await get(`/api/work-orders/${orderId}/dossier/verify`)).data.verification;
  const check = v.integrity.checks.find((c: any) => c.id === 'repair-verification');
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.match(check.detail, /VERIFIED: 3 medición\(es\)/);
});

test('REQ-REP-03: si el problema persiste, el motor reabre el caso y nunca lo presenta como recuperado', async () => {
  const { orderId, nodeId } = await runLeakToClosedOrder(srv.base);
  const r = await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'unresolved' });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const s = (await get('/api/state')).data;
  const node = s.nodes.find((n: any) => n.id === nodeId);
  assert.notEqual(node.status, 'nominal');
  assert.equal(node.pendingVerification, undefined);
  const list = verdicts(s.ledger, orderId);
  assert.deepEqual(list.map((e: any) => e.action), ['REPAIR_REOPENED']);
  const v = (await get(`/api/work-orders/${orderId}/dossier/verify`)).data.verification;
  assert.equal(v.integrity.checks.find((c: any) => c.id === 'repair-verification').ok, true, 'el veredicto honesto de reapertura también se recomputa');
});

test('REQ-REP-02: una sola medición no concluye (INCONCLUSIVE): ningún veredicto sellado y el punto sigue pendiente', async () => {
  const { orderId, nodeId } = await runLeakToClosedOrder(srv.base);
  assert.equal((await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'sparse' })).status, 200);
  const s = (await get('/api/state')).data;
  const node = s.nodes.find((n: any) => n.id === nodeId);
  assert.equal(node.pendingVerification.assessment.outcome, 'INCONCLUSIVE');
  assert.equal(node.pendingVerification.assessment.measuredAfter, 1);
  assert.equal(verdicts(s.ledger, orderId).length, 0);
  // Completar la evidencia después sí concluye: mismo orden, mismas reglas.
  assert.equal((await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'repaired' })).status, 200);
  assert.deepEqual(verdicts((await get('/api/state')).data.ledger, orderId).map((e: any) => e.action), ['REPAIR_VERIFIED']);
});

test('REQ-REP-06: las mediciones simuladas exigen permiso, un modo válido y una orden cerrada pendiente de verificación', async () => {
  const viewer = await new Session(srv.base).as('viewer');
  const { orderId } = await runLeakToClosedOrder(srv.base);
  assert.equal((await viewer.request('POST', `/api/work-orders/${orderId}/simulated-measurements`, { mode: 'repaired' })).status, 403);
  assert.equal((await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'inventado' })).status, 400);
  assert.equal((await post('/api/work-orders/NO-EXISTE/simulated-measurements', { mode: 'repaired' })).status, 404);
  assert.equal((await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'repaired' })).status, 200);
  assert.equal((await post(`/api/work-orders/${orderId}/simulated-measurements`, { mode: 'repaired' })).status, 409, 'una orden ya verificada no admite más mediciones simuladas');
});
