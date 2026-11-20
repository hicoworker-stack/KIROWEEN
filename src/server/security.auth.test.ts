import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PNG_1X1, Session, TEST_USERS } from './testing/harness';
import { InProc, rawRequest, startInProc } from './testing/inproc';

/**
 * REQ-AUTH-02, REQ-SEC-03, REQ-SEC-04: sesiones, CSRF, fuerza bruta, fijación de sesión, DNS rebinding, cabeceras,
 * límites de tasa y fugas de secretos, probados con HTTP real y reloj inyectado.
 */
let srv: InProc;
before(async () => {
  srv = await startInProc();
});
after(async () => {
  await srv?.close();
});

const MIN = 60_000;
const SESSION_COOKIE = '__Host-aqua_sid';

test('REQ-AUTH-02: cookie de sesión HttpOnly, SameSite=Strict, Secure, sin Domain, con prefijo __Host- y el token jamás viaja en el cuerpo', async () => {
  const s = new Session(srv.base);
  await s.status();
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookieHeader(), 'x-csrf-token': s.csrf },
    body: JSON.stringify({ username: TEST_USERS.admin.username, password: TEST_USERS.admin.password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.ok(cookie, 'se emite la cookie de sesión');
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; Max-Age=\d+/);
  assert.ok(!/Domain=/i.test(cookie), 'sin Domain: __Host- lo prohíbe');
  const token = cookie.split(';')[0].split('=')[1];
  assert.ok(token.length >= 40, 'token de 256 bits');
  const body = await res.text();
  assert.ok(!body.includes(token), 'el token no aparece en el cuerpo de la respuesta');
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['csrfToken', 'user']);
  assert.notEqual(JSON.parse(body).csrfToken, token, 'el token CSRF no es el token de sesión');
});

test('REQ-AUTH-02: en desarrollo (HTTP local) la cookie sigue siendo HttpOnly y SameSite=Strict pero sin Secure ni prefijo', async () => {
  const dev = await startInProc({ production: false });
  try {
    const s = new Session(dev.base);
    await s.status();
    const res = await fetch(`${dev.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookieHeader(), 'x-csrf-token': s.csrf }, body: JSON.stringify({ username: TEST_USERS.admin.username, password: TEST_USERS.admin.password }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('aqua_sid='))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!/Secure/.test(cookie));
  } finally {
    await dev.close();
  }
});

test('REQ-AUTH-02: caducidad por inactividad (30 min, renovable) y absoluta (12 h, no renovable); la caducada limpia la cookie', async () => {
  const s = await srv.session('operator');
  srv.clock.advance(29 * MIN);
  assert.equal((await s.request('GET', '/api/state')).status, 200, 'dentro de la ventana');
  srv.clock.advance(29 * MIN);
  assert.equal((await s.request('GET', '/api/state')).status, 200, 'la actividad renovó la inactividad');
  srv.clock.advance(31 * MIN);
  const expired = await s.request('GET', '/api/state');
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('set-cookie') ?? '', /Max-Age=0/, 'se ordena borrar la cookie');

  const long = await srv.session('viewer');
  for (let i = 0; i < 28; i++) {
    srv.clock.advance(25 * MIN);
    assert.equal((await long.request('GET', '/api/state')).status, 200, `con actividad constante sigue viva a las ${((i + 1) * 25) / 60} h`);
  }
  srv.clock.advance(25 * MIN); // 12 h 05 min desde el inicio de sesión
  assert.equal((await long.request('GET', '/api/state')).status, 401, 'pasadas 12 h la sesión caducó aunque hubiera actividad constante');
});

test('REQ-AUTH-02: cerrar sesión revoca el token (repetirlo no sirve) y revoca los tokens de operación pendientes', async () => {
  const s = await srv.session('admin');
  const tok = await s.opHeaders('reset', TEST_USERS.admin.password);
  const stolen = s.sid;
  const csrf = s.csrf;
  assert.equal((await s.request('POST', '/api/auth/logout', {})).status, 200);
  // el atacante que robó la cookie y el CSRF intenta reutilizarlos
  const replay = await fetch(`${srv.base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${stolen}` } });
  assert.equal(replay.status, 401);
  const replay2 = await fetch(`${srv.base}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${stolen}`, 'x-csrf-token': csrf, ...tok }, body: '{}' });
  assert.equal(replay2.status, 401);
  assert.equal((await srv.session('admin')).sid === stolen, false, 'un nuevo login emite otro token');
});

test('REQ-AUTH-02: desactivar al usuario, cambiar o restablecer su contraseña, o cambiarle el rol, invalida sus sesiones al instante', async () => {
  const admin = await srv.session('admin');
  const created = await admin.request('POST', '/api/users', { username: 'temporal.uno', displayName: 'Temporal', role: 'OPERATOR', password: 'Temporal-Clave-2026!' });
  assert.equal(created.status, 201);
  const id = created.data.user.id;
  const mk = async () => {
    const s = new Session(srv.base);
    assert.equal((await s.login('temporal.uno', 'Temporal-Clave-2026!')).status, 200);
    return s;
  };
  // desactivar
  let s = await mk();
  assert.equal((await s.request('GET', '/api/state')).status, 200);
  await admin.request('PATCH', `/api/users/${id}`, { active: false });
  assert.equal((await s.request('GET', '/api/state')).status, 401, 'desactivado');
  await admin.request('PATCH', `/api/users/${id}`, { active: true });
  // cambio de rol
  s = await mk();
  await admin.request('PATCH', `/api/users/${id}`, { role: 'VIEWER' });
  assert.equal((await s.request('GET', '/api/state')).status, 401, 'cambio de rol');
  // restablecimiento por un administrador
  s = await mk();
  assert.equal((await admin.request('POST', `/api/users/${id}/password`, { newPassword: 'Clave-Nueva-Del-Admin-77!' })).status, 200);
  assert.equal((await s.request('GET', '/api/state')).status, 401, 'restablecimiento por administrador');
  assert.equal((await new Session(srv.base).login('temporal.uno', 'Temporal-Clave-2026!')).status, 401);
  // cambio propio: las demás sesiones mueren y la actual se renueva
  const a = new Session(srv.base);
  const b = new Session(srv.base);
  assert.equal((await a.login('temporal.uno', 'Clave-Nueva-Del-Admin-77!')).status, 200);
  assert.equal((await b.login('temporal.uno', 'Clave-Nueva-Del-Admin-77!')).status, 200);
  const oldSid = a.sid;
  const wrong = await a.request('POST', '/api/auth/password', { currentPassword: 'incorrecta', newPassword: 'Otra-Clave-Aun-Mas-Larga-88!' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.code, 'bad_password');
  const ok = await a.request('POST', '/api/auth/password', { currentPassword: 'Clave-Nueva-Del-Admin-77!', newPassword: 'Otra-Clave-Aun-Mas-Larga-88!' });
  assert.equal(ok.status, 200);
  assert.equal((await b.request('GET', '/api/state')).status, 401, 'la otra sesión murió');
  assert.notEqual(a.sid, oldSid, 'la sesión actual se rotó');
  assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${oldSid}` } })).status, 401, 'el token anterior ya no vale');
  assert.equal((await a.request('GET', '/api/state')).status, 200);
});

test('REQ-AUTH-02: la revocación cierra el flujo de eventos (SSE) ya abierto', async () => {
  const admin = await srv.session('admin');
  const created = await admin.request('POST', '/api/users', { username: 'flujo.sse', role: 'VIEWER', password: 'Flujo-Eventos-2026!' });
  const id = created.data.user.id;
  const s = new Session(srv.base);
  await s.login('flujo.sse', 'Flujo-Eventos-2026!');
  const ac = new AbortController();
  const res = await fetch(`${srv.base}/api/events`, { headers: { cookie: s.cookieHeader() }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /connected/);
  await admin.request('PATCH', `/api/users/${id}`, { active: false });
  const next = await Promise.race([reader.read(), new Promise<{ done: true; timeout: true }>((r) => setTimeout(() => r({ done: true, timeout: true }), 5000))]);
  assert.equal(next.done, true, 'el flujo terminó al revocarse la sesión');
  assert.ok(!('timeout' in next), 'sin esperar al siguiente latido');
  ac.abort();
});

test('REQ-AUTH-02: fijación de sesión. Un identificador impuesto antes del login no se acepta ni se conserva', async () => {
  const attackerKnown = 'F'.repeat(43);
  const victim = new Session(srv.base);
  await victim.status();
  victim.cookies.set(SESSION_COOKIE, attackerKnown); // el atacante planta su valor
  const login = await victim.login(TEST_USERS.operator.username, TEST_USERS.operator.password);
  assert.equal(login.status, 200);
  assert.notEqual(victim.sid, attackerKnown, 'el servidor emitió un identificador nuevo');
  assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${attackerKnown}` } })).status, 401, 'el identificador impuesto no da acceso');
  // Iniciar sesión de nuevo con una sesión viva revoca la anterior
  const first = victim.sid;
  const again = await victim.login(TEST_USERS.operator.username, TEST_USERS.operator.password);
  assert.equal(again.status, 200);
  assert.notEqual(victim.sid, first);
  assert.equal((await fetch(`${srv.base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${first}` } })).status, 401, 'la sesión previa quedó revocada');
});

test('REQ-AUTH-04: CSRF. Escrituras sin token, con token ajeno o con Origin/Sec-Fetch-Site hostil se rechazan; el login exige token previo', async () => {
  const op = await srv.session('operator');
  const v = await srv.session('viewer');
  const url = '/api/scenarios/leak/trigger';
  const ledgerBefore = (await op.request('GET', '/api/state')).data.ledger.length;
  const noToken = await fetch(`${srv.base}${url}`, { method: 'POST', headers: { cookie: op.cookieHeader(), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noToken.status, 403, 'sin cabecera CSRF');
  assert.equal((await op.request('POST', url, {}, { 'x-csrf-token': 'inventado' })).status, 403);
  assert.equal((await op.request('POST', url, {}, { 'x-csrf-token': v.csrf })).status, 403, 'token de otra sesión');
  const cross = await rawRequest(srv.base, { method: 'POST', path: url, headers: { host: new URL(srv.base).host, cookie: op.cookieHeader(), 'x-csrf-token': op.csrf, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403, 'Origin hostil aunque el token sea válido');
  const sfs = await rawRequest(srv.base, { method: 'POST', path: url, headers: { host: new URL(srv.base).host, cookie: op.cookieHeader(), 'x-csrf-token': op.csrf, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(sfs.status, 403, 'Sec-Fetch-Site: cross-site');
  const textPlain = await fetch(`${srv.base}${url}`, { method: 'POST', headers: { cookie: op.cookieHeader(), 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(textPlain.status, 403, 'el "formulario simple" entre sitios no pasa');
  assert.equal((await op.request('GET', '/api/state')).data.ledger.length, ledgerBefore, 'ninguno de esos intentos tocó el estado');
  // login: CSRF previo a la sesión
  const anon = new Session(srv.base);
  await anon.status();
  const body = JSON.stringify({ username: TEST_USERS.admin.username, password: TEST_USERS.admin.password });
  const H = (extra: Record<string, string>) => ({ 'content-type': 'application/json', ...extra });
  assert.equal((await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H({ cookie: anon.cookieHeader() }), body })).status, 403, 'sin token');
  assert.equal((await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H({ cookie: anon.cookieHeader(), 'x-csrf-token': 'x' }), body })).status, 403, 'token falso');
  const other = new Session(srv.base);
  await other.status();
  assert.equal((await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H({ cookie: anon.cookieHeader(), 'x-csrf-token': other.csrf }), body })).status, 403, 'token de otro navegador');
  assert.equal((await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H({ 'x-csrf-token': anon.csrf }), body })).status, 403, 'sin la cookie previa (login CSRF desde otro sitio)');
  assert.equal((await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H({ cookie: anon.cookieHeader(), 'x-csrf-token': anon.csrf }), body })).status, 200, 'con el par correcto sí');
});

test('REQ-SEC-04: DNS rebinding. Un Host no permitido se rechaza (421), aunque X-Forwarded-Host diga lo contrario', async () => {
  const host = new URL(srv.base).host;
  const ok = await rawRequest(srv.base, { path: '/api/health', headers: { host } });
  assert.equal(ok.status, 200);
  for (const evil of ['evil.example', 'attacker.com:80', `127.0.0.1:${srv.port + 1}`, 'localhost', `${host}.evil.example`]) {
    const r = await rawRequest(srv.base, { path: '/api/health', headers: { host: evil } });
    assert.equal(r.status, 421, `Host ${evil}`);
  }
  const spoof = await rawRequest(srv.base, { path: '/api/health', headers: { host: 'evil.example', 'x-forwarded-host': host, forwarded: `host=${host}` } });
  assert.equal(spoof.status, 421, 'X-Forwarded-Host no se usa jamás');
  const noHost = await rawRequest(srv.base, { path: '/api/health', headers: {} });
  assert.ok(noHost.status === 421 || noHost.status === 400, `sin Host: ${noHost.status}`);
});

test('REQ-SEC-04: CORS cerrado. Ninguna respuesta lleva Access-Control-*; el preflight desde otro origen se rechaza', async () => {
  const host = new URL(srv.base).host;
  const pre = await rawRequest(srv.base, { method: 'OPTIONS', path: '/api/state', headers: { host, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  const read = await rawRequest(srv.base, { path: '/api/auth/status', headers: { host, origin: 'https://evil.example' } });
  assert.equal(read.status, 403, 'lectura entre orígenes rechazada');
  const same = await rawRequest(srv.base, { path: '/api/auth/status', headers: { host, origin: srv.base } });
  assert.equal(same.status, 200);
  for (const h of Object.keys(same.headers)) assert.ok(!h.startsWith('access-control-'), h);
});

test('REQ-SEC-04: cabeceras de seguridad en toda respuesta', async () => {
  const res = await fetch(`${srv.base}/api/auth/status`);
  const h = res.headers;
  assert.match(h.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(h.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe/.test(h.get('content-security-policy') ?? ''), 'sin script en línea en producción');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('cache-control'), 'no-store');
  assert.equal(h.get('x-powered-by'), null);
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.ok(h.get('x-request-id'));
  const nf = await fetch(`${srv.base}/no-existe`);
  assert.match(nf.headers.get('content-security-policy') ?? '', /default-src '(self|none)'/, 'también en respuestas que no son de la API (la página de error de Express usa la política más estricta)');
  const s = await srv.session('viewer');
  const nonJson = await s.request('GET', '/api/no-existe');
  assert.equal(nonJson.status, 404);
});

test('REQ-SEC-03: fuerza bruta. El bloqueo por cuenta e IP frena los intentos, incluso con la contraseña correcta, y no afecta a otras cuentas', async () => {
  const bf = await startInProc({ rateLimits: { 'login-user': { max: 4, windowMs: 15 * MIN }, 'login-ip': { max: 14, windowMs: 15 * MIN } } });
  try {
    const victim = TEST_USERS.viewer;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await new Session(bf.base).login(victim.username, `incorrecta-${i}`)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    const locked = await new Session(bf.base).login(victim.username, victim.password);
    assert.equal(locked.status, 429, 'bloqueada aun con la contraseña correcta');
    assert.ok(locked.data.retryAfterSec > 0);
    assert.equal((await new Session(bf.base).login(TEST_USERS.operator.username, TEST_USERS.operator.password)).status, 200, 'otra cuenta no se ve afectada');
    bf.clock.advance(16 * MIN);
    assert.equal((await new Session(bf.base).login(victim.username, victim.password)).status, 200, 'pasada la ventana vuelve a funcionar');

    // Respuesta idéntica para usuario inexistente y para contraseña errónea (no revela qué cuentas existen)
    const a = await new Session(bf.base).login('no.existe.nadie', 'cualquiera-1234567');
    const b = await new Session(bf.base).login(TEST_USERS.admin.username, 'cualquiera-1234567');
    assert.equal(a.status, b.status);
    assert.deepEqual(a.data, b.data);

    // Rociado de contraseñas desde una IP con X-Forwarded-For rotatorio: sigue contando por la IP real
    let blocked = 0;
    for (let i = 0; i < 30; i++) {
      const s = new Session(bf.base);
      await s.status();
      const r = await fetch(`${bf.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookieHeader(), 'x-csrf-token': s.csrf, 'x-forwarded-for': `203.0.113.${i + 1}` }, body: JSON.stringify({ username: `usuario${i}`, password: 'x'.repeat(12) }) });
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked >= 10, `el rociado con IP declarada falsa debe bloquearse por la IP real (bloqueados: ${blocked})`);
    const adminTry = await new Session(bf.base).login(TEST_USERS.admin.username, TEST_USERS.admin.password);
    assert.equal(adminTry.status, 429, 'limitación declarada: quien comparte IP con el atacante también queda bloqueado hasta que venza la ventana');  } finally {
    await bf.close();
  }
});

test('REQ-SEC-03: X-Forwarded-For solo se respeta si el socket pertenece a un proxy configurado', async () => {
  const behind = await startInProc({ trustedProxies: '127.0.0.1', rateLimits: { 'login-ip': { max: 3, windowMs: 15 * MIN } } });
  try {
    const attempt = async (xff: string) => {
      const s = new Session(behind.base);
      await s.status();
      return (await fetch(`${behind.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookieHeader(), 'x-csrf-token': s.csrf, 'x-forwarded-for': xff }, body: JSON.stringify({ username: 'nadie', password: 'x'.repeat(12) }) })).status;
    };
    for (let i = 0; i < 3; i++) assert.equal(await attempt('198.51.100.9'), 401);
    assert.equal(await attempt('198.51.100.9'), 429, 'el cliente declarado por el proxy llegó a su tope');
    assert.equal(await attempt('198.51.100.10'), 401, 'otro cliente real detrás del proxy no está bloqueado');
    const adm = await behind.session('admin').catch(() => null);
    assert.ok(adm, 'el administrador (otra IP lógica) puede entrar');
  } finally {
    await behind.close();
  }
});

test('REQ-SEC-03: límites diferenciados por usuario para IA, fotografías, administración y tráfico general (429 con Retry-After)', async () => {
  const lim = await startInProc({ rateLimits: { ai: { max: 3, windowMs: MIN }, upload: { max: 2, windowMs: 10 * MIN }, admin: { max: 4, windowMs: 10 * MIN }, 'ai-probe': { max: 1, windowMs: 10 * MIN }, 'api-user': { max: 60, windowMs: MIN } } });
  try {
    const op = await lim.session('operator');
    const op2 = await new Session(lim.base).as('admin');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await op.request('POST', '/api/ai/diagnose', {})).status);
    assert.deepEqual(codes, [400, 400, 400, 429, 429], 'IA: 3 por minuto');
    const limited = await op.request('POST', '/api/ai/diagnose', {});
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await op2.request('POST', '/api/ai/diagnose', {})).status, 400, 'el cupo es por usuario');
    lim.clock.advance(61_000);
    assert.equal((await op.request('POST', '/api/ai/diagnose', {})).status, 400, 'la ventana se renueva');
    // fotografías
    const up = [];
    for (let i = 0; i < 3; i++) up.push((await op.request('POST', '/api/work-orders/OT-X/evidence', { dataUrl: PNG_1X1 })).status);
    assert.deepEqual(up, [404, 404, 429], 'fotografías: 2 por 10 min');
    // administración
    const adm = [];
    for (let i = 0; i < 5; i++) adm.push((await op2.request('GET', '/api/users')).status);
    assert.deepEqual(adm, [200, 200, 200, 200, 429], 'administración: 4 por 10 min');
    // sonda de IA (cubeta propia)
    assert.equal((await op2.request('POST', '/api/ai/probe', {})).status, 200);
    assert.equal((await op2.request('POST', '/api/ai/probe', {})).status, 429, 'sonda de IA: 1 por 10 min');    // tráfico general
    const general = [];
    for (let i = 0; i < 70; i++) general.push((await op.request('GET', '/api/state')).status);
    assert.ok(general.includes(429), 'tráfico general limitado por usuario');
  } finally {
    await lim.close();
  }
});

test('REQ-SEC-03: tamaños. El cuerpo se limita por ruta, las rutas grandes lo leen DESPUÉS de comprobar sesión y permiso', async () => {
  const op = await srv.session('operator');
  const v = await srv.session('viewer');
  const big = (n: number) => ({ x: 'a'.repeat(n) });
  assert.equal((await op.request('POST', '/api/ai/diagnose', big(200_000))).status, 413, 'ruta normal: 100 kB');
  assert.equal((await op.request('POST', '/api/diagnoses/x/decision', big(200_000))).status, 413);
  assert.equal((await op.request('POST', '/api/work-orders/OT-X/evidence', big(10 * 1024 * 1024))).status, 413, 'foto: tope de ~9 MB de JSON');
  assert.equal((await v.request('POST', '/api/state/import', big(5 * 1024 * 1024))).status, 403, 'un VIEWER recibe 403 sin que se lea el cuerpo grande');
  assert.equal((await op.request('POST', '/api/sync/offline', big(13 * 1024 * 1024))).status, 413);
  const anon = await fetch(`${srv.base}/api/state/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(big(3 * 1024 * 1024)) });
  assert.equal(anon.status, 401);
  const login = new Session(srv.base);
  await login.status();
  const hugeLogin = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: login.cookieHeader(), 'x-csrf-token': login.csrf }, body: JSON.stringify({ username: 'a', password: 'p'.repeat(30_000) }) });
  assert.equal(hugeLogin.status, 413, 'el login admite solo 16 kB');
});

test('REQ-AUD-02: ningún log del servidor contiene contraseñas, tokens de sesión, CSRF ni tokens de operación', async () => {
  const captured: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void captured.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, Object.getOwnPropertyNames(x as object)))).join(' '));
  let sid = '';
  let csrf = '';
  let opToken = '';
  const secretPw = 'Contrasena-Muy-Secreta-9876!';
  try {
    const s = new Session(srv.base);
    await s.login(TEST_USERS.admin.username, secretPw);
    await new Session(srv.base).login('no.existe', secretPw);
    const ok = await srv.session('admin');
    sid = ok.sid;
    csrf = ok.csrf;
    opToken = (await ok.opHeaders('demo', TEST_USERS.admin.password))['x-operation-token'];
    await ok.request('POST', '/api/admin/operation-token', { operation: 'reset', password: secretPw });
    await fetch(`${srv.base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${sid}x` } });
    await ok.request('POST', '/api/users', { username: 'x', password: secretPw, role: 'VIEWER' });
    await ok.request('POST', '/api/auth/password', { currentPassword: secretPw, newPassword: secretPw + '1' });
  } finally {
    Object.assign(console, orig);
  }
  const all = captured.join('\n');
  for (const secret of [secretPw, sid, csrf, opToken, TEST_USERS.admin.password]) assert.ok(secret && !all.includes(secret), `un secreto apareció en los logs: ${secret.slice(0, 6)}…`);
  const auditRaw = (await srv.handle.audit.read(500)).entries.map((e) => JSON.stringify(e)).join('\n');
  for (const secret of [secretPw, sid, csrf, opToken, TEST_USERS.admin.password]) assert.ok(!auditRaw.includes(secret), 'tampoco en la auditoría');
});
