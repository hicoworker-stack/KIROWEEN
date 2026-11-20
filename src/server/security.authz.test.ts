import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { can, isPublicRoute, PERMISSION_TAG, Permission } from './authz';
import { PNG_1X1, Session, TEST_USERS, TestUserKey } from './testing/harness';
import { InProc, startInProc } from './testing/inproc';

/**
 * REQ-AUTH-01, REQ-AUTHZ-01, REQ-AUD-03: autenticación y autorización probadas con peticiones HTTP reales.
 */
let srv: InProc;
let admin: Session;
let operator: Session;
let viewer: Session;

before(async () => {
  srv = await startInProc();
  [admin, operator, viewer] = await Promise.all([srv.session('admin'), srv.session('operator'), srv.session('viewer')]);
});
after(async () => {
  await srv?.close();
});

interface RouteInfo {
  method: string;
  path: string;
  tags: unknown[];
}
function registeredRoutes(): RouteInfo[] {
  const stack = (srv.handle.app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Record<string, unknown> }> } }> } })._router.stack;
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path, tags: layer.route.stack.map((s) => s.handle[PERMISSION_TAG]).filter((x) => x !== undefined) });
    }
  }
  return out;
}
const concrete = (p: string) => p.replace(':sha256', '0'.repeat(64)).replace(/:\w+/g, 'x');

test('REQ-AUTHZ-01: toda ruta de /api declara el permiso que exige o está en la lista de rutas públicas', () => {
  const routes = registeredRoutes().filter((r) => r.path.startsWith('/api/'));
  assert.ok(routes.length >= 30, `se esperaban >= 30 rutas, hay ${routes.length}`);
  const missing = routes.filter((r) => r.tags.length === 0 && !isPublicRoute(r.method, r.path)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(missing, [], 'rutas sin permiso declarado (no deben existir)');
  const publicRoutes = routes.filter((r) => isPublicRoute(r.method, r.path)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(publicRoutes.sort(), ['GET /api/auth/csrf', 'GET /api/auth/status', 'GET /api/health', 'GET /api/seal/public-key', 'POST /api/auth/login', 'POST /api/auth/setup']);
});

test('REQ-AUTH-01: sin sesión TODA ruta protegida responde 401 y no cambia el estado; con cabeceras falsas tampoco', async () => {
  const before = (await admin.request('GET', '/api/state')).data.ledger.length;
  const routes = registeredRoutes().filter((r) => r.path.startsWith('/api/') && !isPublicRoute(r.method, r.path));
  for (const r of routes) {
    const res = await fetch(`${srv.base}${concrete(r.path)}`, {
      method: r.method,
      headers: { 'content-type': 'application/json', 'x-actor': 'admin', 'x-user': 'admin', 'x-forwarded-user': 'admin', authorization: 'Bearer admin', 'x-aqua-confirm': 'reset' },
      body: r.method === 'GET' ? undefined : '{}',
    });
    assert.equal(res.status, 401, `${r.method} ${r.path} debe exigir sesión`);
    const body = await res.json();
    assert.equal(body.code, 'unauthenticated');
  }
  assert.equal((await admin.request('GET', '/api/state')).data.ledger.length, before, 'ningún intento sin sesión modificó el estado');
});

test('REQ-AUTH-01: las rutas públicas son las mínimas y no filtran datos de la red', async () => {
  const health = await fetch(`${srv.base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, authRequired: true }, 'sin sesión solo "vivo"');
  assert.equal((await fetch(`${srv.base}/api/seal/public-key`)).status, 200);
  const status = await srv.anon().status();
  assert.equal(status.authenticated, false);
  assert.equal(status.user, null);
  assert.ok(status.csrfToken);
  // las rutas públicas de escritura exigen CSRF previo a la sesión
  const login = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: TEST_USERS.admin.username, password: TEST_USERS.admin.password }) });
  assert.equal(login.status, 403, 'login sin token CSRF previo');
  const setup = await fetch(`${srv.base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(setup.status, 403);
});

type Case = { perm: Permission; method: string; url: string; body?: unknown };
const CASES: Case[] = [
  { perm: 'state:read', method: 'GET', url: '/api/state' },
  { perm: 'state:read', method: 'GET', url: '/api/state/consistency' },
  { perm: 'state:read', method: 'GET', url: '/api/anomalies/x/forensics' },
  { perm: 'kiro:read', method: 'GET', url: '/api/kiro/files' },
  { perm: 'evidence:read', method: 'GET', url: `/api/evidence/${'0'.repeat(64)}` },
  { perm: 'dossier:verify', method: 'GET', url: '/api/work-orders/OT-X/dossier/verify' },
  { perm: 'dossier:verify', method: 'POST', url: '/api/ledger/verify', body: {} },
  { perm: 'dossier:verify', method: 'POST', url: '/api/dossier/verify', body: {} },
  { perm: 'telemetry:ingest', method: 'POST', url: '/api/telemetry/ingest', body: {} },
  { perm: 'scenario:trigger', method: 'POST', url: '/api/scenarios/inexistente/trigger', body: {} },
  { perm: 'ai:use', method: 'POST', url: '/api/ai/diagnose', body: {} },
  { perm: 'ai:use', method: 'POST', url: '/api/ai/vision-analyze', body: {} },
  { perm: 'diagnosis:decide', method: 'POST', url: '/api/diagnoses/x/decision', body: {} },
  { perm: 'order:write', method: 'PATCH', url: '/api/work-orders/OT-X', body: {} },
  { perm: 'order:write', method: 'PATCH', url: '/api/work-orders/OT-X/assignee', body: {} },
  { perm: 'order:write', method: 'PATCH', url: '/api/work-orders/OT-X/checklist/c1', body: {} },
  { perm: 'order:evidence', method: 'POST', url: '/api/work-orders/OT-X/evidence', body: {} },
  { perm: 'dossier:export', method: 'GET', url: '/api/work-orders/OT-X/dossier' },
  { perm: 'ledger:anchor', method: 'GET', url: '/api/ledger/anchor' },
  { perm: 'offline:sync', method: 'POST', url: '/api/sync/offline', body: {} },
  { perm: 'ai:probe', method: 'POST', url: '/api/ai/probe', body: {} },
  { perm: 'snapshot:export', method: 'GET', url: '/api/state/export' },
  { perm: 'users:manage', method: 'GET', url: '/api/users' },
  { perm: 'users:manage', method: 'POST', url: '/api/users', body: {} },
  { perm: 'audit:read', method: 'GET', url: '/api/audit' },
  { perm: 'audit:read', method: 'GET', url: '/api/audit/head' },
  { perm: 'destructive:token', method: 'POST', url: '/api/admin/operation-token', body: {} },
  { perm: 'destructive:reset', method: 'POST', url: '/api/reset', body: {} },
  { perm: 'destructive:demo', method: 'POST', url: '/api/demo/frankenstein', body: {} },
  { perm: 'destructive:import', method: 'POST', url: '/api/state/import', body: {} },
];

test('REQ-AUTHZ-01: la matriz de permisos se cumple en el servidor, ruta por ruta y rol por rol', async () => {
  const sessions: Record<string, Session> = { VIEWER: viewer, OPERATOR: operator, ADMIN: admin };
  const stateBefore = (await admin.request('GET', '/api/state')).data.ledger.length;
  for (const [role, s] of Object.entries(sessions)) {
    for (const c of CASES) {
      const r = await s.request(c.method, c.url, c.body);
      const allowed = can(role as 'ADMIN', c.perm);
      if (allowed) assert.ok(r.status !== 403 && r.status !== 401, `${role} debe poder ${c.method} ${c.url} (permiso ${c.perm}); recibió ${r.status}`);
      else {
        assert.equal(r.status, 403, `${role} NO debe poder ${c.method} ${c.url} (permiso ${c.perm}); recibió ${r.status}`);
        assert.equal(r.data.required, c.perm);
      }
    }
  }
  assert.equal((await admin.request('GET', '/api/state')).data.ledger.length >= stateBefore, true);
});

test('REQ-AUTHZ-01: un VIEWER no puede modificar nada aunque conozca las rutas y tenga CSRF válido', async () => {
  const before = JSON.stringify((await viewer.request('GET', '/api/state')).data.ledger.length);
  for (const c of CASES.filter((x) => x.method !== 'GET' && !['dossier:verify'].includes(x.perm))) {
    assert.equal((await viewer.request(c.method, c.url, c.body)).status, 403, `${c.method} ${c.url}`);
  }
  assert.equal(JSON.stringify((await viewer.request('GET', '/api/state')).data.ledger.length), before);
});

test('REQ-AUD-03: la identidad sale de la sesión; actor, asignado y nombres que envía el cliente no suplantan a nadie', async () => {
  const t = await operator.request('POST', '/api/scenarios/leak/trigger', { actor: 'Administrador Root', user: 'admin' }, { 'x-actor': 'root', 'x-user-id': 'usr_admin', 'x-forwarded-user': 'admin' });
  assert.equal(t.status, 200);
  const diagId = t.data.diagnosis.id as string;
  const dec = await operator.request(
    'POST',
    `/api/diagnoses/${diagId}/decision`,
    { decision: 'accepted', assignee: 'Brigada Sectorial A', actor: 'Administrador Root', operatorName: 'root', approvedBy: 'admin', userId: 'usr_admin', role: 'ADMIN' },
    { 'x-actor': 'root', 'x-user': 'admin' }
  );
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  const orderId = dec.data.createdOrder.id as string;
  assert.equal((await operator.request('PATCH', `/api/work-orders/${orderId}/assignee`, { assignee: 'Admin Root', actor: 'admin' })).status, 200);
  const itemId = dec.data.createdOrder.checklist[0].id as string;
  assert.equal((await operator.request('PATCH', `/api/work-orders/${orderId}/checklist/${itemId}`, { done: true, actor: 'admin', doneBy: 'admin' })).status, 200);
  assert.equal((await operator.request('POST', `/api/work-orders/${orderId}/evidence`, { dataUrl: PNG_1X1, fileName: 'foto.png', attachedBy: 'admin' })).status, 200);
  const sync = await operator.request('POST', '/api/sync/offline', {
    reports: [{ id: 'OFF-IMP', idempotencyKey: 'k-imp', createdAt: new Date().toISOString(), nodeId: 'N-TRON-04', category: 'leak', reporterName: 'Administrador Root', actor: 'admin', description: 'Fuga visible' }],
  });
  assert.equal(sync.status, 200);

  const ledger = (await operator.request('GET', '/api/state')).data.ledger as Array<{ action: string; actor: string; evidenceData: Record<string, unknown> }>;
  const mine = ledger.filter((e) => ['WORK_ORDER_ISSUED', 'WORK_ORDER_ASSIGNED', 'CHECKLIST_ITEM_COMPLETED', 'CLOSURE_EVIDENCE_ATTACHED', 'OFFLINE_REPORT_SYNCED'].includes(e.action));
  assert.equal(mine.length, 5);
  for (const e of mine) {
    assert.match(e.actor, /@operador\.test, OPERATOR\)$/, `${e.action}: ${e.actor}`);
    assert.ok(!/root|admin/i.test(e.actor.replace('@operador.test', '')), `${e.action} no debe mencionar el actor suplantado: ${e.actor}`);
    assert.equal(e.evidenceData.actorRole, 'OPERATOR');
    assert.equal(e.evidenceData.actorAuthenticated, true);
    assert.equal(e.evidenceData.actorId, operator.user!.id);
  }
  const offline = mine.find((e) => e.action === 'OFFLINE_REPORT_SYNCED')!;
  assert.equal(offline.evidenceData.declaredReporter, 'Administrador Root', 'el nombre declarado se guarda aparte, marcado como no verificado');
  assert.equal(offline.evidenceData.reporterDeclaredUnverified, true);
  const order = (await operator.request('GET', '/api/state')).data.workOrders.find((o: { id: string }) => o.id === orderId);
  assert.match(order.closureEvidence.attachedBy, /@operador\.test/);
  assert.equal(order.assignee, 'Admin Root', 'el responsable asignado es una etiqueta de la orden, no una identidad');
  const items = order.checklist.filter((i: { done: boolean }) => i.done);
  assert.match(items[0].doneBy ?? items[0].actor ?? JSON.stringify(items[0]), /@operador\.test/);
});

test('REQ-AUTH-02: una cookie inventada, el hash guardado en disco o la cookie de otro usuario no autentican', async () => {
  const forged = ['A'.repeat(43), 'x'.repeat(43), 'admin', ''];
  for (const token of forged) {
    const r = await fetch(`${srv.base}/api/state`, { headers: { cookie: `__Host-aqua_sid=${token}` } });
    assert.equal(r.status, 401, `token inventado: ${token.slice(0, 6)}`);
  }
  // El archivo guarda solo el SHA-256 del token; presentarlo como si fuera el token NO sirve.
  const data = JSON.parse(fs.readFileSync(path.join(srv.dir, 'auth.json'), 'utf8'));
  for (const s of data.sessions) assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: `__Host-aqua_sid=${s.idHash}` } })).status, 401, 'el hash no es una credencial');
  // Nombre de cookie sin el prefijo exigido en producción: se ignora.
  assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: `aqua_sid=${admin.sid}` } })).status, 401);
  // CSRF de otra sesión
  const r = await viewer.request('POST', '/api/scenarios/leak/trigger', {}, { 'x-csrf-token': admin.csrf });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'csrf');
});

test('REQ-AUTHZ-01: si el rol cambia en el almacén (otro proceso o CLI), la sesión previa deja de valer en la siguiente petición', async () => {
  const s = await srv.session('viewer');
  assert.equal((await s.request('GET', '/api/state')).status, 200);
  const file = path.join(srv.dir, 'auth.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.users.find((u: { username: string }) => u.username === TEST_USERS.viewer.username).role = 'ADMIN';
  fs.writeFileSync(file, JSON.stringify(data));
  await new Promise((r) => setTimeout(r, 650));
  assert.equal((await s.request('GET', '/api/users')).status, 401, 'la sesión del VIEWER no hereda el rol ADMIN escrito en disco');
  // restaura
  data.users.find((u: { username: string }) => u.username === TEST_USERS.viewer.username).role = 'VIEWER';
  fs.writeFileSync(file, JSON.stringify(data));
  await new Promise((r) => setTimeout(r, 650));
});

test('REQ-AUTHZ-01: gestión de usuarios: solo ADMIN, sin autoprivilegios y sin dejar el sistema sin administrador', async () => {
  const me = admin.user!;
  assert.equal((await operator.request('GET', '/api/users')).status, 403);
  const created = await admin.request('POST', '/api/users', { username: 'nuevo.usuario', displayName: 'Nuevo', role: 'VIEWER', password: 'Nuevo-Usuario-Clave-2026!' });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.data).includes('scrypt'), false, 'la respuesta no incluye datos de la contraseña');
  assert.equal((await admin.request('POST', '/api/users', { username: 'nuevo.usuario', role: 'VIEWER', password: 'Nuevo-Usuario-Clave-2026!' })).status, 409);
  assert.equal((await admin.request('POST', '/api/users', { username: 'debil.usuario', role: 'VIEWER', password: '123456' })).status, 400);
  assert.equal((await admin.request('POST', '/api/users', { username: 'rol.malo', role: 'SUPERADMIN', password: 'Nuevo-Usuario-Clave-2026!' })).status, 400);
  assert.equal((await admin.request('PATCH', `/api/users/${me.id}`, { role: 'VIEWER' })).status, 409, 'no puede degradarse a sí mismo');
  assert.equal((await admin.request('PATCH', `/api/users/${me.id}`, { active: false })).status, 409);
  const id = created.data.user.id;
  assert.equal((await admin.request('PATCH', `/api/users/${id}`, { role: 'OPERATOR' })).data.user.role, 'OPERATOR');
  // el nuevo usuario inicia sesión y sus permisos son los de su rol
  const s = await new Session(srv.base).login('nuevo.usuario', 'Nuevo-Usuario-Clave-2026!');
  assert.equal(s.status, 200);
  assert.equal((await admin.request('PATCH', `/api/users/${id}`, { active: false })).status, 200);
  assert.equal((await new Session(srv.base).login('nuevo.usuario', 'Nuevo-Usuario-Clave-2026!')).status, 401, 'desactivado: no inicia sesión');
});

test('REQ-AUTHZ-01: la API de usuarios nunca devuelve contraseñas, hashes, sales ni identificadores de sesión', async () => {
  const dump = JSON.stringify([
    (await admin.request('GET', '/api/users')).data,
    (await admin.request('GET', '/api/auth/status')).data,
    (await admin.request('GET', '/api/health')).data,
    (await admin.request('GET', '/api/audit?limit=500')).data,
    (await admin.request('GET', '/api/state')).data,
  ]);
  for (const marker of ['"salt"', '"algo":"scrypt"', 'scrypt', 'idHash', 'BEGIN PRIVATE KEY', 'passwordHash', TEST_USERS.admin.password]) {
    assert.ok(!dump.includes(marker), `la respuesta no debe contener ${marker}`);
  }
});

test('compatibilidad: cada rol ve la aplicación según su permiso y las sesiones son independientes', async () => {
  const keys: TestUserKey[] = ['admin', 'operator', 'viewer'];
  for (const k of keys) {
    const s = await srv.session(k);
    const st = await s.status();
    assert.equal(st.authenticated, true);
    assert.equal(st.user.role, TEST_USERS[k].role);
    assert.equal((await s.request('GET', '/api/state')).status, 200);
  }
});
