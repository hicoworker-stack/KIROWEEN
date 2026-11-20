import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore, AuthStoreError, normalizeUsername } from './authStore';
import { burnPasswordTime, hashPassword, validatePasswordPolicy, verifyPassword } from './passwords';

const FAST = { N: 1024, r: 8, p: 1, keyLen: 32 };
const PW = 'Clave-Segura-2026!';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-auth-')), 'auth.json');
}
function clock(start = Date.parse('2026-06-01T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('contraseñas: scrypt con sal propia, verificación correcta y rechazo de la errónea (REQ-AUTH-01)', async () => {
  const a = await hashPassword(PW, FAST);
  const b = await hashPassword(PW, FAST);
  assert.equal(a.algo, 'scrypt');
  assert.notEqual(a.salt, b.salt, 'cada hash lleva una sal distinta');
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword(PW, a), true);
  assert.equal(await verifyPassword(PW + 'x', a), false);
  assert.equal(await verifyPassword('', a), false);
  assert.equal(await verifyPassword(undefined, a), false);
  assert.equal(await verifyPassword('x'.repeat(5000), a), false, 'una contraseña gigante no cuesta CPU: se rechaza antes');
  await burnPasswordTime('lo-que-sea', FAST);
});

test('política de contraseñas: longitud, repetición, nombre de usuario, comunes y variedad (REQ-AUTH-01)', () => {
  assert.ok(validatePasswordPolicy('corta1A!').length > 0);
  assert.ok(validatePasswordPolicy('aaaaaaaaaaaaaaaa').length > 0);
  assert.ok(validatePasswordPolicy('Marta-Lopez-2026!', 'marta-lopez').length > 0, 'contiene el usuario');
  assert.ok(validatePasswordPolicy('password1234').length > 0);
  assert.ok(validatePasswordPolicy('sololetrasabcd').length > 0, '14 caracteres de una sola clase no bastan');
  assert.deepEqual(validatePasswordPolicy(PW, 'ana'), []);
  assert.deepEqual(validatePasswordPolicy('una frase larga de dieciseis'), [], 'frases largas válidas');
  assert.ok(validatePasswordPolicy(12345 as unknown).length > 0);
  assert.ok(validatePasswordPolicy('x'.repeat(300) + 'A1!').length > 0, 'tope de longitud');
});

test('nombres de usuario normalizados y validados', () => {
  assert.equal(normalizeUsername('  Ana.Perez '), 'ana.perez');
  assert.equal(normalizeUsername('a'), null);
  assert.equal(normalizeUsername('con espacio'), null);
  assert.equal(normalizeUsername('<script>'), null);
  assert.equal(normalizeUsername(42), null);
});

test('el token de sesión nunca se guarda en claro: solo su SHA-256 (REQ-AUTH-02)', async () => {
  const file = tmpFile();
  const store = AuthStore.open(file, { scrypt: FAST });
  const u = await store.createUser({ username: 'ana', role: 'ADMIN', password: PW, createdBy: 'test' });
  const { token } = await store.createSession(u.id);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token), 'el token no aparece en auth.json');
  assert.ok(!raw.includes(PW), 'la contraseña no aparece en auth.json');
  assert.match(raw, /"algo":"scrypt"/);
  assert.ok(store.resolveSession(token));
});

test('sesión: caduca por inactividad y por tiempo absoluto; la actividad renueva la inactividad (REQ-AUTH-02)', async () => {
  const c = clock();
  const store = AuthStore.open(tmpFile(), { scrypt: FAST, now: c.now, idleMs: 10 * 60_000, absoluteMs: 60 * 60_000 });
  const u = await store.createUser({ username: 'ana', role: 'OPERATOR', password: PW, createdBy: 't' });
  const { token } = await store.createSession(u.id);
  c.advance(9 * 60_000);
  assert.ok(store.resolveSession(token), 'dentro de la ventana de inactividad');
  c.advance(9 * 60_000);
  assert.ok(store.resolveSession(token), 'la actividad anterior renovó la inactividad');
  c.advance(11 * 60_000);
  assert.equal(store.resolveSession(token), null, 'inactiva más de 10 min');

  const { token: t2 } = await store.createSession(u.id);
  for (let i = 0; i < 6; i++) {
    c.advance(9 * 60_000);
    assert.ok(store.resolveSession(t2) || i >= 6);
  }
  c.advance(9 * 60_000);
  assert.equal(store.resolveSession(t2), null, 'el límite absoluto de 60 min no se renueva con actividad');
});

test('revocar una sesión la invalida de inmediato y es persistente tras reabrir el archivo (REQ-AUTH-02)', async () => {
  const file = tmpFile();
  const store = AuthStore.open(file, { scrypt: FAST });
  const u = await store.createUser({ username: 'ana', role: 'VIEWER', password: PW, createdBy: 't' });
  const { token, session } = await store.createSession(u.id);
  assert.ok(store.resolveSession(token));
  await store.revokeSession(session.idHash, 'logout');
  assert.equal(store.resolveSession(token), null);
  const reopened = AuthStore.open(file, { scrypt: FAST });
  assert.equal(reopened.resolveSession(token), null);
});

test('desactivar al usuario, cambiar su contraseña o su rol invalida sus sesiones (REQ-AUTH-02)', async () => {
  const store = AuthStore.open(tmpFile(), { scrypt: FAST });
  const admin = await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const u = await store.createUser({ username: 'luis', role: 'OPERATOR', password: PW, createdBy: 't' });

  let s = await store.createSession(u.id);
  await store.setActive(u.id, false);
  assert.equal(store.resolveSession(s.token), null, 'desactivado');
  await assert.rejects(store.createSession(u.id), /inactivo/);
  assert.equal(await store.verifyCredentials('luis', PW), null, 'un usuario inactivo no puede iniciar sesión');
  await store.setActive(u.id, true);

  s = await store.createSession(u.id);
  const keep = await store.createSession(u.id);
  await store.setPassword(u.id, 'Otra-Clave-Muy-Larga-9!', { keepSessionHash: keep.session.idHash });
  assert.equal(store.resolveSession(s.token), null, 'cambio de contraseña');
  assert.ok(store.resolveSession(keep.token), 'la sesión desde la que se cambia puede conservarse');
  assert.ok(await store.verifyCredentials('luis', 'Otra-Clave-Muy-Larga-9!'));
  assert.equal(await store.verifyCredentials('luis', PW), null, 'la contraseña anterior ya no sirve');

  s = await store.createSession(u.id);
  await store.setRole(u.id, 'VIEWER');
  assert.equal(store.resolveSession(s.token), null, 'cambio de rol: la sesión emitida con el rol anterior no vale');
  assert.equal(store.getUser(u.id)?.role, 'VIEWER');
  assert.ok(admin.id);
});

test('un rol modificado directamente en el archivo tampoco se hereda en una sesión previa (permisos verificados en cada petición)', async () => {
  const file = tmpFile();
  const store = AuthStore.open(file, { scrypt: FAST });
  const u = await store.createUser({ username: 'luis', role: 'VIEWER', password: PW, createdBy: 't' });
  const { token } = await store.createSession(u.id);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.users[0].role = 'ADMIN';
  fs.writeFileSync(file, JSON.stringify(data));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(store.resolveSession(token), null, 'el rol de la sesión ya no coincide con el del usuario');
});

test('no se puede desactivar ni degradar al último administrador activo (REQ-AUTH-03)', async () => {
  const store = AuthStore.open(tmpFile(), { scrypt: FAST });
  const a = await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  await assert.rejects(store.setActive(a.id, false), (e: unknown) => e instanceof AuthStoreError && e.code === 'last_admin');
  await assert.rejects(store.setRole(a.id, 'VIEWER'), (e: unknown) => e instanceof AuthStoreError && e.code === 'last_admin');
  const b = await store.createUser({ username: 'otra', role: 'ADMIN', password: PW, createdBy: 't' });
  await store.setActive(a.id, false);
  assert.ok(b.id);
});

test('límite de sesiones simultáneas por usuario: la más antigua se revoca', async () => {
  const c = clock();
  const store = AuthStore.open(tmpFile(), { scrypt: FAST, now: c.now, maxSessionsPerUser: 3 });
  const u = await store.createUser({ username: 'ana', role: 'VIEWER', password: PW, createdBy: 't' });
  const tokens: string[] = [];
  for (let i = 0; i < 4; i++) {
    c.advance(1000);
    tokens.push((await store.createSession(u.id)).token);
  }
  assert.equal(store.resolveSession(tokens[0]), null);
  assert.ok(store.resolveSession(tokens[3]));
  assert.equal(store.activeSessionCount(u.id), 3);
});

test('tokens malformados o desconocidos no resuelven sesión', () => {
  const store = AuthStore.open(tmpFile(), { scrypt: FAST });
  for (const t of [undefined, null, '', 'abc', 'x'.repeat(500), 12345, {}, 'A'.repeat(43)]) assert.equal(store.resolveSession(t as unknown), null);
});

test('configuración inicial: el código es aleatorio, de un solo uso, no se guarda en claro y el asistente se cierra para siempre (REQ-AUTH-03)', async () => {
  const file = tmpFile();
  const store = AuthStore.open(file, { scrypt: FAST });
  const issued = (await store.issueSetupCode())!;
  assert.match(issued.code, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/, '160 bits en 32 símbolos');
  const other = (await AuthStore.open(tmpFile(), { scrypt: FAST }).issueSetupCode())!;
  assert.notEqual(issued.code, other.code);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(issued.code) && !raw.includes(issued.code.replace(/-/g, '')), 'el código no se almacena en claro');
  assert.equal(store.setupAvailable(), true);

  await assert.rejects(store.consumeSetup('AAAA-BBBB', { username: 'root', password: PW }), (e: unknown) => e instanceof AuthStoreError && e.code === 'bad_code');
  const admin = await store.consumeSetup(issued.code.toLowerCase(), { username: 'root', displayName: 'Raíz', password: PW });
  assert.equal(admin.role, 'ADMIN');
  assert.equal(store.setupAvailable(), false);
  await assert.rejects(store.consumeSetup(issued.code, { username: 'otro', password: PW }), (e: unknown) => e instanceof AuthStoreError && e.code === 'setup_disabled', 'el código no se puede reutilizar');
  assert.equal(await store.issueSetupCode(), null, 'no se emite otro código');

  const reopened = AuthStore.open(file, { scrypt: FAST });
  assert.equal(reopened.setupAvailable(), false);
  assert.equal(await reopened.issueSetupCode(), null);
  assert.equal(reopened.setupDisabledPermanently(), true);
});

test('configuración inicial: expira, se invalida tras 5 intentos fallidos y dos canjes simultáneos no crean dos administradores', async () => {
  const c = clock();
  const s1 = AuthStore.open(tmpFile(), { scrypt: FAST, now: c.now, setupTtlMs: 60_000 });
  const code = (await s1.issueSetupCode())!.code;
  c.advance(61_000);
  await assert.rejects(s1.consumeSetup(code, { username: 'root', password: PW }), (e: unknown) => e instanceof AuthStoreError && e.code === 'setup_expired');
  assert.equal(s1.hasUsers(), false);

  const s2 = AuthStore.open(tmpFile(), { scrypt: FAST });
  const good = (await s2.issueSetupCode())!.code;
  for (let i = 0; i < 5; i++) await s2.consumeSetup('ZZZZ-ZZZZ', { username: 'root', password: PW }).catch(() => undefined);
  await assert.rejects(s2.consumeSetup(good, { username: 'root', password: PW }), (e: unknown) => e instanceof AuthStoreError && e.code === 'setup_expired', 'tras 5 fallos ni el código correcto sirve');

  const s3 = AuthStore.open(tmpFile(), { scrypt: FAST });
  const c3 = (await s3.issueSetupCode())!.code;
  const results = await Promise.allSettled([
    s3.consumeSetup(c3, { username: 'uno', password: PW }),
    s3.consumeSetup(c3, { username: 'dos', password: PW }),
    s3.consumeSetup(c3, { username: 'tres', password: PW }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s3.listUsers().length, 1);
});

test('archivo de autenticación corrupto: el almacén no abre (no reabre la configuración inicial) y no usa la copia silenciosamente (REQ-RES-10)', async () => {
  const file = tmpFile();
  const store = AuthStore.open(file, { scrypt: FAST });
  await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  await store.createUser({ username: 'otra', role: 'VIEWER', password: PW, createdBy: 't' }); // genera .bak
  assert.ok(fs.existsSync(`${file}.bak`));
  fs.writeFileSync(file, '{"version":1,"users":[');
  assert.throws(() => AuthStore.open(file, { scrypt: FAST }), (e: unknown) => e instanceof AuthStoreError && e.code === 'corrupt' && /no arranca/.test(e.message));
});

test('fallo de disco al escribir: la operación se rechaza, no queda estado a medias y se recupera cuando el disco vuelve (REQ-RES-10)', async () => {
  const file = tmpFile();
  let fail = false;
  const real = (await import('./authStore')).atomicWriteFile;
  const store = AuthStore.open(file, {
    scrypt: FAST,
    writeAtomic: (f, d) => {
      if (fail) throw new Error('ENOSPC simulado');
      real(f, d);
    },
  });
  const admin = await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const { token } = await store.createSession(admin.id);
  fail = true;
  await assert.rejects(store.createUser({ username: 'nuevo', role: 'VIEWER', password: PW, createdBy: 't' }), (e: unknown) => e instanceof AuthStoreError && e.code === 'write_failed');
  assert.equal(store.findByUsername('nuevo'), undefined, 'el usuario no existe en memoria');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 1, 'ni en disco');
  await assert.rejects(store.createSession(admin.id), /no se pudo guardar/i);
  assert.ok(store.resolveSession(token), 'las sesiones ya emitidas siguen vigentes');
  await assert.rejects(store.setPassword(admin.id, 'Otra-Clave-Muy-Larga-9!'), /no se pudo guardar/i);
  assert.ok(await store.verifyCredentials('root', PW), 'la contraseña anterior sigue vigente');
  assert.ok(store.lastWriteError);
  fail = false;
  await store.createUser({ username: 'nuevo', role: 'VIEWER', password: PW, createdBy: 't' });
  assert.equal(store.lastWriteError, null);
});

test('si la revocación no se puede persistir, igualmente deja de valer en memoria (dirección segura)', async () => {
  const file = tmpFile();
  let fail = false;
  const real = (await import('./authStore')).atomicWriteFile;
  const store = AuthStore.open(file, { scrypt: FAST, writeAtomic: (f, d) => (fail ? (() => { throw new Error('disco'); })() : real(f, d)) });
  const u = await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const { token, session } = await store.createSession(u.id);
  fail = true;
  await assert.rejects(store.revokeSession(session.idHash, 'logout'));
  assert.equal(store.resolveSession(token), null);
});

test('concurrencia: escrituras simultáneas desde dos almacenes (proceso y CLI) sobre el mismo archivo no pierden usuarios', async () => {
  const file = tmpFile();
  const a = AuthStore.open(file, { scrypt: FAST });
  await a.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const b = AuthStore.open(file, { scrypt: FAST });
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 8; i++) {
    jobs.push((i % 2 ? a : b).createUser({ username: `user${i}`, role: 'VIEWER', password: PW, createdBy: 't' }));
  }
  await Promise.all(jobs);
  const final = AuthStore.open(file, { scrypt: FAST });
  assert.equal(final.listUsers().length, 9, 'ninguna alta se perdió');
  assert.equal(new Set(final.listUsers().map((u) => u.username)).size, 9);
});

test('cambios hechos por otro proceso (CLI de recuperación) son visibles para el servidor sin reiniciar', async () => {
  const file = tmpFile();
  const server = AuthStore.open(file, { scrypt: FAST });
  const u = await server.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const second = await server.createUser({ username: 'otra', role: 'ADMIN', password: PW, createdBy: 't' });
  const { token } = await server.createSession(second.id);
  const cli = AuthStore.open(file, { scrypt: FAST });
  await cli.setActive(second.id, false);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(server.resolveSession(token), null, 'la desactivación hecha por el CLI invalida la sesión viva');
  assert.ok(u.id);
});

test('usuario duplicado (sin distinguir mayúsculas) y contraseña débil se rechazan', async () => {
  const store = AuthStore.open(tmpFile(), { scrypt: FAST });
  await store.createUser({ username: 'ana', role: 'VIEWER', password: PW, createdBy: 't' });
  await assert.rejects(store.createUser({ username: 'ANA', role: 'VIEWER', password: PW, createdBy: 't' }), (e: unknown) => e instanceof AuthStoreError && e.code === 'duplicate');
  await assert.rejects(store.createUser({ username: 'beto', role: 'VIEWER', password: '123', createdBy: 't' }), (e: unknown) => e instanceof AuthStoreError && e.code === 'weak_password');
  await assert.rejects(store.createUser({ username: 'beto', role: 'SUPERUSER' as never, password: PW, createdBy: 't' }), (e: unknown) => e instanceof AuthStoreError && e.code === 'bad_role');
});

test('reactivar a un usuario NO resucita las sesiones que tenía al desactivarlo (la revocación es explícita, no solo el estado activo)', async () => {
  const store = AuthStore.open(tmpFile(), { scrypt: FAST });
  await store.createUser({ username: 'root', role: 'ADMIN', password: PW, createdBy: 't' });
  const u = await store.createUser({ username: 'luis', role: 'OPERATOR', password: PW, createdBy: 't' });
  const { token } = await store.createSession(u.id);
  await store.setActive(u.id, false);
  await store.setActive(u.id, true);
  assert.equal(store.resolveSession(token), null, 'la sesión previa a la desactivación no vuelve a valer');
  assert.ok(store.resolveSession((await store.createSession(u.id)).token), 'una sesión nueva sí');
});
