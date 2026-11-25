import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../core/permissions';
import { isPublicRoute, PERMISSION_TAG } from './authz';
import { loadSecurityConfig } from './netSecurity';
import { assertPublicStateIsSynthetic, isPublicModeEnabled, isPublicReadRoute, PUBLIC_READ_ROUTES, PublicModeError, redactForVisitor } from './publicMode';
import { refreshStalePublicState, SEED_USERNAME, seedPublicDemo } from './publicDemo';
import { Session, TEST_USERS } from './testing/harness';
import { InProc, startInProc } from './testing/inproc';

/**
 * REQ-PUB-01/02: MODO PÚBLICO, con peticiones HTTP reales. Un visitante anónimo puede LEER la demostración y nada más;
 * con la variable apagada el servidor vuelve a exigir sesión en todo.
 */
const PUBLIC = { AQUA_PUBLIC_MODE: '1' };
const cfgFor = (srv: InProc) => loadSecurityConfig({ NODE_ENV: 'production', AQUA_ALLOWED_HOSTS: `127.0.0.1:${srv.port}`, AQUA_ALLOWED_ORIGINS: `http://127.0.0.1:${srv.port}` });
const get = (srv: InProc, url: string, headers: Record<string, string> = {}) => fetch(`${srv.base}${url}`, { headers });

interface RouteInfo {
  method: string;
  path: string;
}
function registeredRoutes(srv: InProc): RouteInfo[] {
  const stack = (srv.handle.app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Record<string, unknown> }> } }> } })._router.stack;
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (!layer.route || !layer.route.path.startsWith('/api/')) continue;
    for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: layer.route.path });
  }
  return out;
}
const concrete = (p: string) => p.replace(':sha256', '0'.repeat(64)).replace(/:\w+/g, 'x');

/** Petición anónima; los flujos SSE se cortan en cuanto llegan las cabeceras. */
async function anonymous(srv: InProc, r: RouteInfo): Promise<number> {
  const ac = new AbortController();
  const res = await fetch(`${srv.base}${concrete(r.path)}`, {
    method: r.method,
    signal: ac.signal,
    headers: { 'content-type': 'application/json', 'x-aqua-confirm': 'reset', 'x-actor': 'admin', 'x-forwarded-user': 'admin', authorization: 'Bearer admin' },
    body: r.method === 'GET' ? undefined : '{}',
  });
  const status = res.status;
  ac.abort();
  await res.body?.cancel().catch(() => undefined);
  return status;
}

test('REQ-PUB-01: AQUA_PUBLIC_MODE se interpreta de forma estricta (solo 1 o true) y está apagado por defecto', () => {
  assert.equal(isPublicModeEnabled({}), false);
  for (const v of ['1', 'true', 'TRUE', ' true ']) assert.equal(isPublicModeEnabled({ AQUA_PUBLIC_MODE: v }), true, v);
  for (const v of ['0', 'false', 'yes', 'si', '', 'on', 'público']) assert.equal(isPublicModeEnabled({ AQUA_PUBLIC_MODE: v }), false, v);
});

test('REQ-PUB-01: el rol VISITOR solo puede leer el estado y las fotos; ningún permiso de escritura, IA, administración ni expedientes', () => {
  assert.deepEqual([...ROLE_PERMISSIONS.VISITOR].sort(), ['evidence:read', 'state:read']);
  const forbidden = PERMISSIONS.filter((p) => !['state:read', 'evidence:read'].includes(p));
  for (const p of forbidden) assert.equal(ROLE_PERMISSIONS.VISITOR.has(p), false, p);
  // la lista cerrada de rutas coincide con esos dos permisos y son todas lecturas
  assert.deepEqual(PUBLIC_READ_ROUTES.map((r) => r.doc), ['/api/state', '/api/events', '/api/evidence/:sha256', '/api/preview/leak']);
  assert.ok(PUBLIC_READ_ROUTES.every((r) => r.method === 'GET'));
});

test('REQ-PUB-01: la lista cerrada de rutas no se deja engañar por variantes de ruta, método o mayúsculas', () => {
  assert.equal(isPublicReadRoute('GET', '/api/state'), true);
  assert.equal(isPublicReadRoute('HEAD', '/api/state'), true);
  assert.equal(isPublicReadRoute('GET', `/api/evidence/${'a'.repeat(64)}`), true);
  for (const [m, p] of [
    ['POST', '/api/state'], ['PATCH', '/api/state'], ['DELETE', '/api/state'], ['PUT', '/api/state'], ['OPTIONS', '/api/state'],
    ['GET', '/api/state/'], ['GET', '/api/state/export'], ['GET', '/api/state/consistency'], ['GET', '/API/STATE'], ['GET', '/api/%73tate'],
    ['GET', '/api/events/x'], ['GET', '/api/evidence/..%2f..%2fpackage.json'], ['GET', `/api/evidence/${'A'.repeat(64)}`], ['GET', `/api/evidence/${'a'.repeat(63)}`], ['GET', `/api/evidence/${'a'.repeat(65)}`],
    ['GET', '/api/kiro/files'], ['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/ledger/anchor'], ['GET', '/api/work-orders/OT-1/dossier'],
  ] as const) {
    assert.equal(isPublicReadRoute(m, p), false, `${m} ${p}`);
  }
});

test('REQ-PUB-01: con el modo público un visitante lee el estado SIN sesión, y /api/auth/status y /api/health lo declaran', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const res = await get(srv, '/api/state');
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.ok(Array.isArray(state.nodes) && state.nodes.length > 0);
    assert.ok(state.nodes.every((n: { current: { synthetic: boolean } }) => n.current.synthetic === true), 'todo dato de la instancia pública es sintético');
    const status = await (await get(srv, '/api/auth/status')).json();
    assert.equal(status.publicMode, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.setupAvailable, false, 'quien explora nunca ve pedir un código de administrador');
    assert.deepEqual(await (await get(srv, '/api/health')).json(), { ok: true, authRequired: false, publicMode: true });
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-01: sin la variable (reversible) el servidor vuelve a exigir sesión también para leer', async () => {
  const srv = await startInProc();
  try {
    assert.equal((await get(srv, '/api/state')).status, 401);
    assert.equal((await get(srv, `/api/evidence/${'0'.repeat(64)}`)).status, 401);
    const status = await (await get(srv, '/api/auth/status')).json();
    assert.equal(status.publicMode, false);
    assert.deepEqual(await (await get(srv, '/api/health')).json(), { ok: true, authRequired: true }, 'el contrato público de /api/health no cambia fuera del modo público');
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-01: TODA otra ruta sigue protegida. Un visitante solo supera las rutas públicas y las tres lecturas acotadas', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const admin = await srv.session('admin');
    const before = (await admin.request('GET', '/api/state')).data.ledger.length;
    const routes = registeredRoutes(srv);
    assert.ok(routes.length >= 35, `hay ${routes.length} rutas`);
    const open: string[] = [];
    for (const r of routes) {
      const status = await anonymous(srv, r);
      if (status !== 401) open.push(`${r.method} ${r.path}`);
      // ninguna ruta de escritura puede responder con éxito a un visitante
      if (r.method !== 'GET') assert.ok(status === 401 || status === 403 || status === 404, `${r.method} ${r.path} respondió ${status} a un visitante`);
    }
    const expected = [
      'GET /api/auth/csrf', 'GET /api/auth/status', 'GET /api/events', 'GET /api/evidence/:sha256', 'GET /api/health', 'GET /api/preview/leak', 'GET /api/seal/public-key', 'GET /api/state',
      'POST /api/auth/login', 'POST /api/auth/setup',
    ];
    assert.deepEqual(open.sort(), expected, 'las únicas rutas que no responden 401 a un visitante');
    // y las que no responden 401 son exactamente las públicas de siempre más las de la lista cerrada
    for (const o of open) {
      const [m, p] = o.split(' ');
      assert.ok(isPublicRoute(m, p) || PUBLIC_READ_ROUTES.some((x) => x.method === m && x.doc === p), o);
    }
    assert.equal((await admin.request('GET', '/api/state')).data.ledger.length, before, 'ningún intento del visitante modificó el estado');
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-01: un visitante no alcanza lo sensible por rutas parecidas, ni con cabeceras de identidad falsas', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    for (const url of ['/api/state/', '/api/state/export', '/api/state/consistency', '/api/kiro/files', '/api/users', '/api/audit', '/api/audit/head', '/api/ledger/anchor', '/API/STATE', '/api/%73tate', '/api/work-orders/OT-1/dossier', '/api/anomalies/x/forensics']) {
      const res = await get(srv, url, { 'x-actor': 'admin', 'x-user': 'admin', authorization: 'Bearer admin', 'x-forwarded-for': '10.0.0.1' });
      assert.ok([401, 404].includes(res.status), `${url} → ${res.status}`);
      assert.notEqual(res.status, 200, url);
    }
    // una cookie de sesión inventada no mejora ni empeora el trato del visitante
    const forged = await get(srv, '/api/state', { cookie: '__Host-aqua_sid=' + 'A'.repeat(43) });
    assert.equal(forged.status, 200);
    const forgedWrite = await fetch(`${srv.base}/api/scenarios/leak/trigger`, { method: 'POST', headers: { cookie: '__Host-aqua_sid=' + 'A'.repeat(43), 'x-csrf-token': 'x', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forgedWrite.status, 401);
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-02: el visitante recibe el estado redactado: sin rutas de disco, sin mensajes internos y sin secretos', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const visitorRaw = await (await get(srv, '/api/state')).text();
    const visitor = JSON.parse(visitorRaw);
    assert.deepEqual(Object.keys(visitor.persistence).sort(), ['lastError', 'mode']);
    assert.deepEqual(visitor.integrity.issues, []);
    const admin = await srv.session('admin');
    const full = (await admin.request('GET', '/api/state')).data;
    assert.ok('lastWriteAt' in full.persistence, 'el usuario con sesión recibe el estado completo');
    for (const forbidden of [srv.dir, 'auth.json', 'seal-key', 'BEGIN PRIVATE', 'idHash', TEST_USERS.admin.password, 'scrypt']) assert.ok(!visitorRaw.includes(forbidden), `el estado público contiene ${forbidden}`);
    const r = redactForVisitor({ persistence: { mode: 'memory-only', lastError: 'ENOSPC C:\\datos\\x', statePath: 'C:\\datos' }, integrity: { status: 'degraded', issues: ['detalle interno'], checkedAt: 't' }, ledger: [1] });
    assert.deepEqual(r.persistence, { mode: 'memory-only', lastError: null });
    assert.deepEqual(r.integrity, { status: 'degraded', issues: [], checkedAt: 't' });
    assert.deepEqual(r.ledger, [1], 'el ledger se entrega íntegro: si se redactara, su cadena de hashes no se podría verificar');
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-02: el flujo de eventos (SSE) funciona para visitantes y solo les entrega la versión redactada', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const ac = new AbortController();
    const res = await get(srv, '/api/events', {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    await reader.read(); // connected
    const op = await srv.session('operator');
    const sync = await op.request('POST', '/api/sync/offline', { reports: [{ id: 'OFF-P', idempotencyKey: 'k-pub', createdAt: new Date().toISOString(), nodeId: 'N-DIST-06', category: 'leak', reporterName: 'x', description: 'fuga visible' }] });
    assert.equal(sync.status, 200);
    let buf = '';
    const deadline = Date.now() + 8000;
    while (!buf.includes('state_update') && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((x) => setTimeout(() => x({ done: true }), 3000))]);
      if (r.done) break;
      buf += new TextDecoder().decode(r.value);
    }
    assert.ok(buf.includes('state_update'), 'el visitante recibió la actualización');
    const json = JSON.parse(buf.slice(buf.indexOf('state_update')).split('data: ')[1].split('\n\n')[0]);
    assert.ok(json.anomalies.length >= 1);
    assert.ok(!('lastWriteAt' in json.persistence), 'el visitante no recibe el estado completo por el flujo de eventos');
    assert.ok(!buf.includes(srv.dir));
    ac.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-01: la autenticación completa sigue funcionando en modo público (login, CSRF, permisos y escritura de los usuarios)', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const viewer = await srv.session('viewer');
    assert.equal((await viewer.request('POST', '/api/scenarios/leak/trigger', {})).status, 403, 'el rol Lector sigue sin poder escribir');
    const op = await srv.session('operator');
    assert.equal((await op.request('POST', '/api/scenarios/leak/trigger', {})).status, 200);
    assert.equal((await op.request('GET', '/api/users')).status, 403);
    const anonWrite = await fetch(`${srv.base}/api/diagnoses/x/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonWrite.status, 401);
    const noCsrf = await fetch(`${srv.base}/api/scenarios/leak/trigger`, { method: 'POST', headers: { cookie: op.cookieHeader(), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403, 'el CSRF sigue exigiéndose');
    // el visitante ve lo que hizo el operador, pero no puede hacer lo mismo
    const seen = await (await get(srv, '/api/state')).json();
    assert.equal(seen.anomalies.filter((a: { status: string }) => a.status === 'active').length >= 1, true);
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-02: en modo público toda lectura externa se marca como sintética aunque se declare de campo (AQUA_FIELD_DATA se ignora)', async () => {
  const srv = await startInProc({ env: { ...PUBLIC, AQUA_FIELD_DATA: '1' } });
  try {
    const op = await srv.session('operator');
    const node = (await op.request('GET', '/api/state')).data.nodes.find((n: { id: string }) => n.id === 'N-DIST-06');
    const b = node.baseline;
    const r = await op.request('POST', '/api/telemetry/ingest', { readings: [{ id: 'CAMPO-1', nodeId: 'N-DIST-06', timestamp: new Date().toISOString(), pressureBar: b.pressureBar, flowLs: b.flowLs, levelPct: b.levelPct, turbidityNtu: b.turbidityNtu, chlorineMgL: b.chlorineMgL, ph: b.ph, synthetic: false }] });
    assert.equal(r.status, 200);
    const after = (await op.request('GET', '/api/state')).data.nodes.find((n: { id: string }) => n.id === 'N-DIST-06');
    assert.equal(after.current.synthetic, true);
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-02: el modo público no ofrece el asistente de administrador y se niega a arrancar con lecturas de campo', async () => {
  const empty = await startInProc({ env: PUBLIC, noUsers: true });
  try {
    assert.equal(empty.handle.setupCode, null, 'no se genera ningún código de configuración');
    const s = new Session(empty.base);
    const st = await s.status();
    assert.equal(st.setupAvailable, false);
    assert.equal(st.publicMode, true);
    assert.equal((await s.request('POST', '/api/auth/setup', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', username: 'root', password: 'Clave-Larga-Segura-2026!' })).status, 404);
    assert.equal((await get(empty, '/api/state')).status, 200, 'sin usuarios la demostración se puede explorar igualmente');
  } finally {
    await empty.close();
  }

  // un estado operativo con lecturas de campo no puede servirse en público
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pub-guard-'));
  const field = await startInProc({ dir, env: { AQUA_FIELD_DATA: '1' } });
  const op = await field.session('operator');
  const node = (await op.request('GET', '/api/state')).data.nodes.find((n: { id: string }) => n.id === 'N-DIST-06');
  const b = node.baseline;
  await op.request('POST', '/api/telemetry/ingest', { readings: [{ id: 'REAL-1', nodeId: 'N-DIST-06', timestamp: new Date().toISOString(), pressureBar: b.pressureBar, flowLs: b.flowLs, levelPct: b.levelPct, turbidityNtu: b.turbidityNtu, chlorineMgL: b.chlorineMgL, ph: b.ph, synthetic: false }] });
  assert.equal((await op.request('GET', '/api/state')).data.nodes.find((n: { id: string }) => n.id === 'N-DIST-06').current.synthetic, false, 'preparación: hay una lectura de campo');
  await field.close();
  await assert.rejects(startInProc({ dir, env: PUBLIC }), (e: Error) => e instanceof PublicModeError && /NO sintéticas/.test(e.message));
  assert.throws(() => assertPublicStateIsSynthetic([{ id: 'N1', current: { synthetic: false } as never }]), PublicModeError);
  assert.doesNotThrow(() => assertPublicStateIsSynthetic([{ id: 'N1', current: { synthetic: true } as never }]));
});

test('REQ-PUB-02: la instancia pública se siembra con un incidente, su foto y una orden en curso usando la API real, y queda de solo lectura', async () => {
  const srv = await startInProc({ env: PUBLIC });
  try {
    const seed = await seedPublicDemo({ authStore: srv.handle.authStore, cfg: cfgFor(srv), port: srv.port });
    assert.equal(seed.seeded, true, JSON.stringify(seed));

    const state = await (await get(srv, '/api/state')).json();
    const active = state.anomalies.filter((a: { status: string }) => a.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].category, 'leak');
    assert.equal(active[0].synthetic, true, 'el incidente de la demostración es sintético');
    assert.equal(state.diagnoses.length, 1);
    assert.equal(state.diagnoses[0].operatorDecision, 'accepted');
    assert.equal(state.workOrders.length, 1);
    const order = state.workOrders[0];
    assert.equal(order.status, 'En Progreso');
    assert.equal(order.checklist.filter((c: { done: boolean }) => c.done).length, 2);
    assert.ok(order.checklist.some((c: { done: boolean }) => !c.done), 'quedan tareas pendientes: la orden se puede explorar en curso');
    assert.ok(order.closureEvidence?.sha256);
    assert.equal(state.visionAnalyses.length, 1);
    assert.equal(state.visionAnalyses[0].anomalyId, active[0].id);
    assert.equal(state.visionAnalyses[0].analysisStatus, 'not_analyzed', 'sin proveedor de visión la foto se declara sin analizar');

    // quién lo hizo queda a la vista: una cuenta interna de operador, nunca un usuario real
    const actors = new Set(state.ledger.map((e: { actor: string }) => e.actor));
    assert.ok([...actors].some((a) => String(a).includes(`@${SEED_USERNAME}, OPERATOR`)));
    for (const u of Object.values(TEST_USERS)) assert.ok(![...actors].some((a) => String(a).includes(u.username)), `${u.username} no participó`);

    // la cuenta de sembrado queda desactivada y sin sesiones
    const user = srv.handle.authStore.findByUsername(SEED_USERNAME)!;
    assert.equal(user.active, false);
    assert.equal(user.role, 'OPERATOR');
    assert.equal(srv.handle.authStore.activeSessionCount(user.id), 0);

    // la foto es accesible para el visitante; lo demás, no
    const photo = await get(srv, `/api/evidence/${order.closureEvidence.sha256}`);
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('content-type') ?? '', /image\/jpeg/);
    assert.ok((await photo.arrayBuffer()).byteLength > 1000);
    assert.equal((await get(srv, `/api/evidence/${'0'.repeat(64)}`)).status, 404);

    // el visitante sigue sin poder modificar nada de esa orden
    for (const [m, u, b] of [['PATCH', `/api/work-orders/${order.id}`, { status: 'Cerrada' }], ['PATCH', `/api/work-orders/${order.id}/checklist/${order.checklist[2].id}`, { done: true }], ['POST', `/api/diagnoses/${state.diagnoses[0].id}/decision`, { decision: 'rejected' }], ['POST', '/api/reset', {}]] as const) {
      const res = await fetch(`${srv.base}${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-aqua-confirm': 'reset' }, body: JSON.stringify(b) });
      assert.equal(res.status, 401, `${m} ${u}`);
    }
    const unchanged = await (await get(srv, '/api/state')).json();
    assert.equal(unchanged.workOrders[0].status, 'En Progreso');
    assert.equal(unchanged.ledger.length, state.ledger.length);

    // idempotente
    const again = await seedPublicDemo({ authStore: srv.handle.authStore, cfg: cfgFor(srv), port: srv.port });
    assert.equal(again.seeded, false);
    assert.equal((await (await get(srv, '/api/state')).json()).workOrders.length, 1);

    // los usuarios reales siguen pudiendo operar sobre la demostración
    const op = await srv.session('operator');
    assert.equal((await op.request('PATCH', `/api/work-orders/${order.id}/checklist/${order.checklist[2].id}`, { done: true })).status, 200);
  } finally {
    await srv.close();
  }
});

test('REQ-PUB-02: una demostración con más de 12 h se descarta (solo su archivo de estado) para sembrarla con datos frescos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pub-stale-'));
  const state = path.join(dir, 'aqua-sentinel-state.json');
  const users = path.join(dir, 'auth.json');
  fs.writeFileSync(state, '{}');
  fs.writeFileSync(users, '{"version":1}');
  assert.equal(refreshStalePublicState(state), false, 'reciente: se conserva');
  assert.ok(fs.existsSync(state));
  const old = new Date(Date.now() - 13 * 3_600_000);
  fs.utimesSync(state, old, old);
  assert.equal(refreshStalePublicState(state), true);
  assert.equal(fs.existsSync(state), false);
  assert.ok(fs.existsSync(users), 'usuarios, auditoría y clave de sellado no se tocan');
  assert.equal(refreshStalePublicState(state), false, 'si no existe, no hace nada');
});

test('REQ-PUB-01: el README documenta qué rutas son públicas y que todo lo demás sigue protegido', () => {
  const readme = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /## Public mode/);
  for (const r of PUBLIC_READ_ROUTES) assert.ok(readme.includes(r.doc), `el README no documenta ${r.doc}`);
  assert.match(readme, /AQUA_PUBLIC_MODE/);
  assert.match(readme, /data\/public-demo/);
});
