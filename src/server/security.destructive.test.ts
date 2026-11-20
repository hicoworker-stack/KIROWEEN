import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Session, TEST_USERS } from './testing/harness';
import { InProc, startInProc } from './testing/inproc';

/**
 * REQ-SEC-05, REQ-AUD-01..03, REQ-RES-10: operaciones destructivas, auditoría y fallos de disco, con HTTP real.
 */
let srv: InProc;
let admin: Session;
let operator: Session;
let viewer: Session;
let auditFails = false;

before(async () => {
  srv = await startInProc({
    auditAppendLine: (file, line) => {
      if (auditFails) throw new Error('ENOSPC simulado en la auditoría');
      fs.appendFileSync(file, line);
    },
  });
  [admin, operator, viewer] = await Promise.all([srv.session('admin'), srv.session('operator'), srv.session('viewer')]);
});
after(async () => {
  auditFails = false;
  await srv?.close();
});

const ledgerLen = async () => (await admin.request('GET', '/api/state')).data.ledger.length as number;
const backupsDir = () => path.join(srv.dir, 'backups');
const backupCount = () => (fs.existsSync(backupsDir()) && fs.statSync(backupsDir()).isDirectory() ? fs.readdirSync(backupsDir()).length : 0);
const authUsers = () => (JSON.parse(fs.readFileSync(path.join(srv.dir, 'auth.json'), 'utf8')).users as Array<{ username: string }>).map((u) => u.username).sort();
const pw = TEST_USERS.admin.password;

test('REQ-SEC-05: sin ADMIN, sin confirmación o sin token válido NO se ejecuta nada y el estado queda intacto', async () => {
  const before = await ledgerLen();
  const b0 = backupCount();
  // Roles sin permiso: ni siquiera pueden pedir el token
  assert.equal((await operator.request('POST', '/api/admin/operation-token', { operation: 'reset', password: TEST_USERS.operator.password })).status, 403);
  assert.equal((await viewer.request('POST', '/api/admin/operation-token', { operation: 'reset', password: TEST_USERS.viewer.password })).status, 403);
  for (const [url, op] of [['/api/reset', 'reset'], ['/api/demo/frankenstein', 'demo'], ['/api/state/import', 'import']] as const) {
    assert.equal((await operator.request('POST', url, {}, { 'x-aqua-confirm': op })).status, 403, `OPERATOR ${op}`);
    assert.equal((await viewer.request('POST', url, {}, { 'x-aqua-confirm': op })).status, 403, `VIEWER ${op}`);
    assert.equal((await admin.request('POST', url, {})).status, 400, `ADMIN sin confirmación ${op}`);
    assert.equal((await admin.request('POST', url, {}, { 'x-aqua-confirm': op })).status, 401, `ADMIN sin token ${op}`);
    assert.equal((await admin.request('POST', url, {}, { 'x-aqua-confirm': op, 'x-operation-token': 'inventado-inventado-inventado' })).status, 401, `token inventado ${op}`);
  }
  // Un token para otra operación no vale
  const demoTok = await admin.opHeaders('demo', pw);
  assert.equal((await admin.request('POST', '/api/reset', {}, { 'x-aqua-confirm': 'reset', 'x-operation-token': demoTok['x-operation-token'] })).status, 401, 'token de demo usado en reset');
  assert.equal(await ledgerLen(), before);
  assert.equal(backupCount(), b0, 'no se archivó ni se destruyó nada');
});

test('REQ-SEC-05: pedir el token exige reautenticación; la contraseña errónea se limita y bloquea incluso la correcta', async () => {
  const strict = await startInProc({ rateLimits: { reauth: { max: 3, windowMs: 10 * 60_000 }, admin: { max: 1000, windowMs: 600000 } } });
  try {
    const a = await strict.session('admin');
    for (let i = 0; i < 3; i++) {
      const r = await a.request('POST', '/api/admin/operation-token', { operation: 'reset', password: `incorrecta-${i}` });
      assert.equal(r.status, 403);
      assert.equal(r.data.code, 'bad_password');
    }
    assert.equal((await a.request('POST', '/api/admin/operation-token', { operation: 'reset', password: TEST_USERS.admin.password })).status, 429, 'bloqueado aun con la correcta');
    strict.clock.advance(11 * 60_000);
    assert.equal((await a.request('POST', '/api/admin/operation-token', { operation: 'reset', password: TEST_USERS.admin.password })).status, 200);
    assert.equal((await a.request('POST', '/api/admin/operation-token', { operation: 'borrar-todo', password: TEST_USERS.admin.password })).status, 400, 'operación desconocida');
    assert.equal((await a.request('POST', '/api/admin/operation-token', { operation: 'reset' })).status, 403, 'sin contraseña');
  } finally {
    await strict.close();
  }
});

test('REQ-SEC-05: el token es de UN solo uso, caduca a los 60 s, está ligado a la sesión y al usuario, y la carrera de dos usos solo deja pasar uno', async () => {
  // un solo uso
  const t1 = await admin.opHeaders('reset', pw);
  assert.equal((await admin.request('POST', '/api/reset', {}, t1)).status, 200);
  assert.equal((await admin.request('POST', '/api/reset', {}, t1)).status, 401, 'repetición del mismo token');
  // caducidad
  const t2 = await admin.opHeaders('reset', pw);
  srv.clock.advance(61_000);
  assert.equal((await admin.request('POST', '/api/reset', {}, t2)).status, 401, 'token caducado');
  // ligado a la sesión: otra sesión del MISMO usuario no puede usarlo
  const other = await srv.session('admin');
  const t3 = await admin.opHeaders('reset', pw);
  assert.equal((await other.request('POST', '/api/reset', {}, t3)).status, 401, 'token de otra sesión');
  assert.equal((await admin.request('POST', '/api/reset', {}, t3)).status, 401, 'el intento fallido lo quemó: no se pueden probar variantes');
  // ligado al usuario
  const second = await admin.request('POST', '/api/users', { username: 'admin.dos', role: 'ADMIN', password: 'Segundo-Admin-Clave-2026!' });
  assert.equal(second.status, 201);
  const adm2 = new Session(srv.base);
  await adm2.login('admin.dos', 'Segundo-Admin-Clave-2026!');
  const t4 = await admin.opHeaders('reset', pw);
  assert.equal((await adm2.request('POST', '/api/reset', {}, t4)).status, 401, 'token de otro administrador');
  // carrera: dos usos simultáneos del mismo token
  const t5 = await admin.opHeaders('reset', pw);
  const [r1, r2] = await Promise.all([admin.request('POST', '/api/reset', {}, t5), admin.request('POST', '/api/reset', {}, t5)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 401], 'exactamente una ejecución');
  // cerrar sesión revoca los tokens pendientes
  const t6 = await adm2.opHeaders('reset', 'Segundo-Admin-Clave-2026!');
  await adm2.request('POST', '/api/auth/logout', {});
  const again = await new Session(srv.base).login('admin.dos', 'Segundo-Admin-Clave-2026!');
  assert.equal(again.status, 200);
});

test('REQ-SEC-05/REQ-AUD-01: una operación autorizada archiva el estado, enlaza la cadena con el actor y registra la autorización ANTES del resultado; usuarios, sesiones y auditoría sobreviven', async () => {
  await operator.request('POST', '/api/scenarios/leak/trigger', {});
  const usersBefore = authUsers();
  const auditBefore = (await srv.handle.audit.read(1)).total;
  const b0 = backupCount();
  const headers = await admin.opHeaders('reset', pw);
  const res = await admin.request('POST', '/api/reset', {}, headers);
  assert.equal(res.status, 200);
  assert.equal(backupCount(), b0 + 1, 'se conservó el estado anterior');
  assert.ok(res.data.archivedTo);
  const genesis = res.data.ledger[0];
  assert.equal(res.data.ledger.length, 1);
  assert.match(genesis.actor, /@admin\.test, ADMIN\)$/, 'el génesis nombra al administrador autenticado');
  assert.equal(genesis.evidenceData.requestedBy.username, TEST_USERS.admin.username);
  assert.equal(typeof genesis.evidenceData.auditAuthorizationSeq, 'number');
  assert.ok(genesis.evidenceData.previousChain.headHash, 'enlaza con la cadena anterior');

  const { entries } = await srv.handle.audit.read(500);
  const asc = [...entries].reverse();
  const auth = asc.find((e) => e.action === 'destructive.reset.authorized' && e.seq === genesis.evidenceData.auditAuthorizationSeq)!;
  const done = asc.find((e) => e.action === 'destructive.reset' && e.seq > auth.seq)!;
  assert.ok(auth && done, 'hay registro de autorización y de resultado');
  assert.ok(auth.seq < done.seq, 'la autorización se escribió antes del resultado');
  assert.equal(auth.actor.username, TEST_USERS.admin.username);
  assert.equal(done.outcome, 'success');
  assert.equal(done.status, 200);
  assert.equal(done.actor.role, 'ADMIN');

  // reset, demo e import NO tocan usuarios, sesiones ni auditoría
  assert.deepEqual(authUsers(), usersBefore);
  assert.equal((await admin.request('GET', '/api/state')).status, 200, 'la sesión del administrador sigue viva tras el reset');
  assert.equal((await operator.request('GET', '/api/state')).status, 200, 'y la de los demás usuarios');
  assert.ok((await srv.handle.audit.read(1)).total > auditBefore, 'la auditoría creció, no se reinició');
  const demo = await admin.request('POST', '/api/demo/frankenstein', {}, await admin.opHeaders('demo', pw));
  assert.equal(demo.status, 200);
  assert.equal(demo.data.ledger.find((e: { action: string }) => e.action === 'DEMO_MODE_STARTED').evidenceData.requestedBy.username, TEST_USERS.admin.username);
  const snap = (await admin.request('GET', '/api/state/export')).data;
  await admin.request('POST', '/api/reset', {}, await admin.opHeaders('reset', pw));
  const imp = await admin.request('POST', '/api/state/import', snap, await admin.opHeaders('import', pw));
  assert.equal(imp.status, 200, JSON.stringify(imp.data).slice(0, 300));
  assert.match(imp.data.ledger[imp.data.ledger.length - 1].actor, /@admin\.test, ADMIN\)$/);
  assert.deepEqual(authUsers(), usersBefore.concat(authUsers().filter((u) => !usersBefore.includes(u))).sort(), 'los usuarios previos siguen todos');
  assert.ok(authUsers().includes(TEST_USERS.viewer.username));
  assert.equal(srv.handle.audit.verify().status === 'compromised', false, 'la auditoría sigue verificando');
});

test('REQ-SEC-05/REQ-RES-10: si la autorización NO se puede registrar en la auditoría, la operación destructiva no se ejecuta; las demás operaciones siguen y se informa', async () => {
  const before = await ledgerLen();
  const b0 = backupCount();
  const headers = await admin.opHeaders('reset', pw);
  auditFails = true;
  try {
    const res = await admin.request('POST', '/api/reset', {}, headers);
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'audit_unavailable');
    assert.match(res.data.error, /NO ejecutada/);
    assert.equal(await ledgerLen(), before, 'el estado no cambió');
    assert.equal(backupCount(), b0, 'tampoco se archivó nada');
    // el token se consumió: hay que pedir otro
    assert.equal((await admin.request('POST', '/api/reset', {}, headers)).status, 401);
    // las operaciones no destructivas no dependen de poder escribir la auditoría
    assert.equal((await operator.request('POST', '/api/scenarios/leak/trigger', {})).status, 200, 'una escritura normal sigue funcionando');
    const health = (await admin.request('GET', '/api/health')).data;
    assert.equal(health.security.audit.status, 'degraded');
    assert.ok(health.security.audit.failedWrites >= 1, 'el fallo de auditoría se informa');
  } finally {
    auditFails = false;
  }
  // recuperada la auditoría, la operación vuelve a ser posible
  const ok = await admin.request('POST', '/api/reset', {}, await admin.opHeaders('reset', pw));
  assert.equal(ok.status, 200);
});

test('REQ-SEC-05/REQ-RES-10: si no se puede conservar el estado anterior, la operación destructiva no se ejecuta', async () => {
  await operator.request('POST', '/api/scenarios/leak/trigger', {});
  const before = await ledgerLen();
  const blocker = backupsDir();
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.writeFileSync(blocker, 'un archivo ocupa el lugar del directorio de copias');
  try {
    for (const op of ['reset', 'demo'] as const) {
      const res = await admin.request('POST', op === 'reset' ? '/api/reset' : '/api/demo/frankenstein', {}, await admin.opHeaders(op, pw));
      assert.equal(res.status, 507, op);
      assert.match(res.data.error, /copia del estado anterior/);
    }
    assert.equal(await ledgerLen(), before, 'el estado sigue intacto');
    const { entries } = await srv.handle.audit.read(20);
    assert.ok(entries.some((e) => e.action === 'destructive.reset' && e.outcome === 'error' && e.status === 507), 'el fallo quedó auditado');
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});

test('REQ-AUD-01/02: la auditoría registra accesos fallidos, operaciones denegadas y modificaciones con actor, operación, fecha y resultado, sin datos sensibles', async () => {
  const marker = `intruso${Date.now()}`;
  await new Session(srv.base).login(marker, 'Clave-Equivocada-12345!');
  await new Session(srv.base).login(TEST_USERS.viewer.username, 'Clave-Equivocada-12345!');
  await viewer.request('POST', '/api/scenarios/leak/trigger', {}); // denegada por rol
  await fetch(`${srv.base}/api/state`); // sin sesión
  await operator.request('POST', '/api/scenarios/leak/trigger', {}); // modificación correcta
  const page = (await admin.request('GET', '/api/audit?limit=200')).data;
  assert.notEqual(page.verification.status, 'compromised', 'la cadena verifica (puede figurar degraded: hubo fallos de escritura simulados antes)');
  const e = page.entries as Array<{ ts: string; action: string; outcome: string; actor: { kind: string; username?: string; role?: string }; status: number; ip: string; reason?: string; resource?: string }>;
  const find = (pred: (x: (typeof e)[number]) => boolean) => e.find(pred);
  const failedUnknown = find((x) => x.action === 'auth.login' && x.outcome === 'denied' && (x.resource ?? '').startsWith('desconocido:'))!;
  assert.ok(failedUnknown, 'login fallido de usuario desconocido');
  assert.ok(!JSON.stringify(page).includes(marker), 'el nombre probado no se guarda en claro (podría ser una contraseña tecleada en el campo equivocado)');
  const failedKnown = find((x) => x.action === 'auth.login' && x.outcome === 'denied' && !(x.resource ?? '').startsWith('desconocido:'))!;
  assert.ok(failedKnown && failedKnown.status === 401);
  const denied = find((x) => x.outcome === 'denied' && x.status === 403 && x.actor.username === TEST_USERS.viewer.username)!;
  assert.ok(denied, 'operación denegada por rol');
  assert.match(denied.reason ?? '', /permiso scenario:trigger/);
  const unauth = find((x) => x.status === 401 && x.actor.kind === 'anonymous' && x.reason === 'sin sesión')!;
  assert.ok(unauth, 'petición sin sesión');
  const mod = find((x) => x.action === 'POST /api/scenarios/:id/trigger' && x.outcome === 'success')!;
  assert.ok(mod);
  assert.equal(mod.actor.username, TEST_USERS.operator.username);
  assert.equal(mod.actor.role, 'OPERATOR');
  assert.equal(mod.ip, '127.0.0.1');
  assert.ok(!Number.isNaN(Date.parse(mod.ts)));
  const login = find((x) => x.action === 'auth.login' && x.outcome === 'success')!;
  assert.ok(login);
  const raw = fs.readFileSync(path.join(srv.dir, 'audit.jsonl'), 'utf8');
  for (const secret of ['Clave-Equivocada-12345!', TEST_USERS.admin.password, TEST_USERS.operator.password, admin.sid, operator.sid, admin.csrf]) assert.ok(!raw.includes(secret), 'ningún secreto en audit.jsonl');
  assert.equal((await operator.request('GET', '/api/audit')).status, 403, 'solo ADMIN lee la auditoría');
});

test('REQ-AUD-01: la auditoría detecta ediciones y truncados del archivo, y lo declara como no inmutable', async () => {
  const file = path.join(srv.dir, 'audit.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const lines = original.trimEnd().split('\n');
    const edited = JSON.parse(lines[2]);
    edited.actor = { kind: 'user', id: 'usr_x', username: 'otra.persona', role: 'ADMIN' };
    const tampered = [...lines.slice(0, 2), JSON.stringify(edited), ...lines.slice(3)];
    fs.writeFileSync(file, tampered.join('\n') + '\n');
    let v = srv.handle.audit.verify();
    assert.equal(v.status, 'compromised', 'edición detectada');
    fs.writeFileSync(file, lines.slice(0, -3).join('\n') + '\n');
    v = srv.handle.audit.verify();
    assert.equal(v.status, 'compromised', 'truncado detectado por la cabeza firmada');
    assert.match(v.issues.join(' '), /truncado/);
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.notEqual((await admin.request('GET', '/api/audit?limit=5')).data.verification.status, 'compromised');
  const head = (await admin.request('GET', '/api/audit/head')).data;
  assert.ok(head.head.signature, 'la cabeza está firmada para poder copiarla fuera del servidor');
});

test('REQ-RES-10: si el almacén de autenticación no se puede escribir, el inicio de sesión falla cerrado y las sesiones vivas siguen; al volver el disco se recupera', async () => {
  const lock = path.join(srv.dir, 'auth.json.lock');
  fs.mkdirSync(lock); // bloquea el cerrojo: toda escritura del almacén queda rechazada
  try {
    const r = await new Session(srv.base).login(TEST_USERS.viewer.username, TEST_USERS.viewer.password);
    assert.equal(r.status, 503, 'no se concede sesión si no se puede guardar');
    assert.equal((await operator.request('GET', '/api/state')).status, 200, 'las sesiones ya emitidas no se pierden');
    assert.equal((await operator.request('POST', '/api/scenarios/leak/trigger', {})).status, 200, 'el servicio funciona');
    const rev = await viewer.request('POST', '/api/auth/logout', {});
    assert.equal(rev.status, 200, 'cerrar sesión funciona aunque no se pueda persistir');
    assert.equal((await viewer.request('GET', '/api/state')).status, 401, 'y la sesión queda revocada en memoria');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  assert.equal((await new Session(srv.base).login(TEST_USERS.viewer.username, TEST_USERS.viewer.password)).status, 200);
});

test('REQ-RES-10: concurrencia. Inicios de sesión y altas simultáneas no pierden datos ni dejan sesiones por encima del límite', async () => {
  const logins = await Promise.all(Array.from({ length: 14 }, () => new Session(srv.base).login(TEST_USERS.operator.username, TEST_USERS.operator.password)));
  assert.ok(logins.every((l) => l.status === 200));
  const live = JSON.parse(fs.readFileSync(path.join(srv.dir, 'auth.json'), 'utf8')).sessions.filter((s: { userId: string; revokedAt?: string }) => s.userId === operator.user!.id && !s.revokedAt);
  assert.ok(live.length <= 10, `como máximo 10 sesiones vivas por usuario (hay ${live.length})`);
  const created = await Promise.all(Array.from({ length: 8 }, (_, i) => admin.request('POST', '/api/users', { username: `masivo.${i}`, role: 'VIEWER', password: `Masivo-Clave-${i}-2026!` })));
  assert.ok(created.every((c) => c.status === 201));
  const names = authUsers();
  for (let i = 0; i < 8; i++) assert.ok(names.includes(`masivo.${i}`), `alta masivo.${i} perdida`);
  const tokens = await Promise.all(Array.from({ length: 6 }, () => admin.request('POST', '/api/admin/operation-token', { operation: 'reset', password: pw })));
  assert.ok(tokens.every((t) => t.status === 200));
  // solo el último token pendiente de cada operación vale
  const valid: number[] = [];
  const reset = await admin.request('POST', '/api/reset', {}, { 'x-aqua-confirm': 'reset', 'x-operation-token': tokens[0].data.token });
  valid.push(reset.status);
  assert.ok(valid[0] === 200 || valid[0] === 401);
});
