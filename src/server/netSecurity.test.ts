import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIpOf, cspFor, hostAllowed, isSecureRequest, loadSecurityConfig, originAllowed, SecurityConfigError, useSecureCookie } from './netSecurity';
import { DEFAULT_LIMITS, parseRateLimitEnv, RateLimiter } from './rateLimit';
import { can, PERMISSIONS, ROLE_PERMISSIONS } from './authz';

const prod = (extra: Record<string, string> = {}) =>
  loadSecurityConfig({ NODE_ENV: 'production', AQUA_ALLOWED_HOSTS: 'aqua.example.org', AQUA_ALLOWED_ORIGINS: 'https://aqua.example.org', ...extra });
const dev = () => loadSecurityConfig({});
const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote } as never, headers });

test('producción exige hosts y orígenes explícitos (REQ-SEC-04)', () => {
  assert.throws(() => loadSecurityConfig({ NODE_ENV: 'production' }), SecurityConfigError);
  assert.throws(() => loadSecurityConfig({ NODE_ENV: 'production', AQUA_ALLOWED_HOSTS: 'a.org' }), /AQUA_ALLOWED_ORIGINS/);
  assert.throws(() => loadSecurityConfig({ NODE_ENV: 'production', AQUA_ALLOWED_ORIGINS: 'https://a.org' }), /AQUA_ALLOWED_HOSTS/);
  assert.throws(() => loadSecurityConfig({ NODE_ENV: 'production', AQUA_ALLOWED_HOSTS: '*.org', AQUA_ALLOWED_ORIGINS: 'https://a.org' }), SecurityConfigError);
  assert.throws(() => loadSecurityConfig({ AQUA_ALLOWED_ORIGINS: 'https://a.org/ruta' }), SecurityConfigError);
  assert.throws(() => loadSecurityConfig({ AQUA_TRUSTED_PROXIES: 'no-es-ip' }), SecurityConfigError);
  assert.ok(prod().production);
});

test('Host: solo los configurados; en desarrollo, loopback con cualquier puerto; DNS rebinding rechazado (REQ-SEC-04)', () => {
  const d = dev();
  for (const h of ['localhost:3000', '127.0.0.1:5173', '[::1]:3000', 'localhost']) assert.equal(hostAllowed(h, d), true, h);
  for (const h of ['evil.com', 'localhost.evil.com:3000', '127.0.0.1.nip.io', '192.168.1.5:3000', undefined, '', 'localhost:3000, evil.com', 'lo cal:1'] as Array<string | undefined>) {
    assert.equal(hostAllowed(h, d), false, String(h));
  }
  const p = prod();
  assert.equal(hostAllowed('aqua.example.org', p), true);
  assert.equal(hostAllowed('AQUA.EXAMPLE.ORG', p), true, 'sin distinguir mayúsculas');
  assert.equal(hostAllowed('aqua.example.org:8443', p), false, 'un puerto no listado no vale');
  assert.equal(hostAllowed('localhost:3000', p), false, 'en producción no se asume loopback');
  assert.equal(hostAllowed('x.aqua.example.org', p), false);
  assert.equal(hostAllowed('aqua.example.org:*', prod({ AQUA_ALLOWED_HOSTS: 'aqua.example.org:*' })), false, 'el comodín solo aplica a puertos');
  assert.equal(hostAllowed('aqua.example.org:9000', prod({ AQUA_ALLOWED_HOSTS: 'aqua.example.org:*' })), true);
});

test('Origin: lista explícita en producción; loopback en desarrollo; "null" y subdominios ajenos rechazados (REQ-SEC-04)', () => {
  const p = prod();
  assert.equal(originAllowed('https://aqua.example.org', p), true);
  assert.equal(originAllowed('http://aqua.example.org', p), false, 'esquema distinto');
  assert.equal(originAllowed('https://evil.com', p), false);
  assert.equal(originAllowed('https://aqua.example.org.evil.com', p), false);
  assert.equal(originAllowed('null', p), false);
  assert.equal(originAllowed('https://aqua.example.org/', p), false, 'un origen no lleva ruta');
  assert.equal(originAllowed(undefined, p), true, 'sin Origin: no es una petición entre sitios de un navegador');
  const d = dev();
  assert.equal(originAllowed('http://localhost:5173', d), true);
  assert.equal(originAllowed('http://127.0.0.1:3000', d), true);
  assert.equal(originAllowed('http://evil.com', d), false);
});

test('IP del cliente: sin proxys de confianza se ignora X-Forwarded-For; con ellos, solo desde el proxy (REQ-SEC-03)', () => {
  const spoof = { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-host': 'evil.com', 'x-forwarded-proto': 'https', forwarded: 'for=6.6.6.6' };
  const none = dev();
  assert.equal(clientIpOf(req('::ffff:203.0.113.9', spoof), none), '203.0.113.9');
  assert.equal(isSecureRequest(req('203.0.113.9', spoof), none), false, 'X-Forwarded-Proto no se cree sin proxy configurado');

  const trusted = loadSecurityConfig({ AQUA_TRUSTED_PROXIES: '10.0.0.1,10.0.0.2' });
  assert.equal(clientIpOf(req('10.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), trusted), '198.51.100.7');
  assert.equal(clientIpOf(req('10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), trusted), '198.51.100.7', 'se toma la entrada más a la derecha que no es proxy: lo que añadió el proxy, no lo que escribió el cliente');
  assert.equal(clientIpOf(req('10.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }), trusted), '198.51.100.7');
  assert.equal(clientIpOf(req('10.0.0.1', { 'x-forwarded-for': 'basura' }), trusted), '10.0.0.1', 'cadena ilegible: no se confía');
  assert.equal(clientIpOf(req('203.0.113.50', { 'x-forwarded-for': '198.51.100.7' }), trusted), '203.0.113.50', 'un cliente directo no puede declarar su IP');
  assert.equal(isSecureRequest(req('10.0.0.1', { 'x-forwarded-proto': 'https' }), trusted), true);
  assert.equal(isSecureRequest(req('203.0.113.50', { 'x-forwarded-proto': 'https' }), trusted), false);
});

test('cookie Secure: siempre en producción o sobre HTTPS; en desarrollo HTTP local no', () => {
  assert.equal(useSecureCookie(req('127.0.0.1'), dev()), false);
  assert.equal(useSecureCookie(req('127.0.0.1'), prod()), true);
  assert.equal(useSecureCookie(req('10.0.0.1', { 'x-forwarded-proto': 'https' }), loadSecurityConfig({ AQUA_TRUSTED_PROXIES: '10.0.0.1' })), true);
});

test('CSP: sin script en línea en producción, sin frames, sin objetos; Vite solo relaja en desarrollo', () => {
  const p = cspFor(prod());
  assert.match(p, /script-src 'self'(;|$)/);
  assert.ok(!/script-src[^;]*unsafe/.test(p));
  assert.match(p, /frame-ancestors 'none'/);
  assert.match(p, /object-src 'none'/);
  assert.match(p, /connect-src 'self'(;|$)/);
  assert.match(cspFor(dev()), /unsafe-inline/);
});

test('limitador: cuenta por clave y cubeta, expira la ventana y no se comparte entre claves', () => {
  let t = 1000;
  const rl = new RateLimiter({ ai: { max: 3, windowMs: 1000 } }, () => t);
  assert.equal(rl.hit('ai', 'u1').allowed, true);
  assert.equal(rl.hit('ai', 'u1').allowed, true);
  assert.equal(rl.hit('ai', 'u1').allowed, true);
  const blocked = rl.hit('ai', 'u1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(rl.hit('ai', 'u2').allowed, true, 'otra clave');
  assert.equal(rl.hit('upload', 'u1').allowed, true, 'otra cubeta');
  t += 1001;
  assert.equal(rl.hit('ai', 'u1').allowed, true, 'la ventana venció');
});

test('limitador de fallos: peek no cuenta, fail sí, reset borra; la memoria está acotada', () => {
  const rl = new RateLimiter({ 'login-user': { max: 2, windowMs: 1000 } });
  assert.equal(rl.peek('login-user', 'ana').allowed, true);
  rl.fail('login-user', 'ana');
  assert.equal(rl.peek('login-user', 'ana').allowed, true);
  rl.fail('login-user', 'ana');
  assert.equal(rl.peek('login-user', 'ana').allowed, false);
  rl.reset('login-user', 'ana');
  assert.equal(rl.peek('login-user', 'ana').allowed, true);
  let t = 0;
  const small = new RateLimiter({}, () => t);
  for (let i = 0; i < 60_000; i++) small.hit('api-anon', `ip-${i}`);
  assert.ok(small.size <= 50_001, `tamaño ${small.size}`);
});

test('límites configurables por entorno: se validan y los inválidos se ignoran', () => {
  const o = parseRateLimitEnv('{"ai":{"max":2,"windowMs":500},"nope":{"max":1},"admin":{"max":"x"}}');
  const rl = new RateLimiter(o);
  assert.deepEqual(rl.limits.ai, { max: 2, windowMs: 500 });
  assert.deepEqual(rl.limits.admin, DEFAULT_LIMITS.admin);
  assert.deepEqual(parseRateLimitEnv('{{no json'), {});
  assert.deepEqual(parseRateLimitEnv(undefined), {});
});

test('matriz de permisos: VIEWER solo consulta, OPERATOR opera, ADMIN administra (REQ-AUTHZ-01)', () => {
  const viewerOnly = ['state:read', 'evidence:read', 'dossier:verify', 'kiro:read'];
  for (const p of PERMISSIONS) assert.equal(can('VIEWER', p), viewerOnly.includes(p), `VIEWER ${p}`);
  for (const p of ['telemetry:ingest', 'scenario:trigger', 'ai:use', 'diagnosis:decide', 'order:write', 'order:evidence', 'dossier:export', 'offline:sync'] as const) {
    assert.equal(can('OPERATOR', p), true, `OPERATOR ${p}`);
  }
  for (const p of ['users:manage', 'audit:read', 'snapshot:export', 'destructive:reset', 'destructive:demo', 'destructive:import', 'ai:probe'] as const) {
    assert.equal(can('OPERATOR', p), false, `OPERATOR no debe tener ${p}`);
    assert.equal(can('ADMIN', p), true, `ADMIN ${p}`);
  }
  for (const p of PERMISSIONS) assert.equal(can('ADMIN', p), true, `ADMIN ${p}`);
  assert.equal(can(null, 'state:read'), false);
  assert.equal(can('ROOT' as never, 'state:read'), false);
  assert.ok(ROLE_PERMISSIONS.OPERATOR.size > ROLE_PERMISSIONS.VIEWER.size && ROLE_PERMISSIONS.ADMIN.size > ROLE_PERMISSIONS.OPERATOR.size);
});
