import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anonApi, defaultSession, RunningServer, Session, startServer, TEST_USERS } from './testing/harness';
import { AuditLog } from './auditLog';

/**
 * REQ-AUTH-03, REQ-RES-10 con el servidor REAL (server.ts como proceso): configuración inicial, CLI, arranque seguro,
 * persistencia de sesiones y ausencia de secretos en archivos y logs.
 */
const CODE_RE = /[A-Z2-9]{4}(?:-[A-Z2-9]{4}){7}/;
const STRONG = 'Primer-Admin-Clave-Larga-2026!';

function runCli(statePath: string, args: string[], stdin?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/authAdmin.ts', ...args], { cwd: process.cwd(), env: { ...process.env, AQUA_STATE_PATH: statePath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    if (stdin !== undefined) p.stdin.write(stdin);
    p.stdin.end();
  });
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-sec-e2e-'));

test('REQ-AUTH-03: configuración inicial (desarrollo): código aleatorio de un solo uso, no se guarda en claro y el endpoint muere para siempre', async () => {
  const srv = await startServer({ production: false, noUsers: true, noDefaultLogin: true });
  try {
    const code = srv.logs().match(CODE_RE)?.[0];
    assert.ok(code, 'el código se imprime en la consola del servidor');
    const s = new Session(srv.base);
    const st = await s.status();
    assert.equal(st.setupAvailable, true);
    assert.equal(st.needsAdmin, true);
    assert.equal((await new Session(srv.base).login('nadie', 'Cualquier-Clave-12345!')).status, 401, 'sin usuarios nadie entra');

    const post = (body: unknown, extra: Record<string, string> = {}) => s.request('POST', '/api/auth/setup', body, extra);
    assert.equal((await post({ code, username: 'root', password: STRONG }, { 'x-csrf-token': 'falso' })).status, 403, 'sin CSRF previo');
    const wrong = await post({ code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', username: 'root', password: STRONG });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.code, 'bad_code');
    const weak = await post({ code, username: 'root', password: '12345' });
    assert.equal(weak.status, 400, 'contraseña débil');
    assert.equal((await post({ code, username: 'a b', password: STRONG })).status, 400, 'usuario inválido');
    const ok = await post({ code, username: 'root', displayName: 'Raíz', password: STRONG });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.user.role, 'ADMIN');
    s.csrf = ok.data.csrfToken;
    assert.equal((await s.request('GET', '/api/users')).status, 200, 'queda con sesión de administrador');

    // un solo uso y cierre definitivo
    const again = new Session(srv.base);
    await again.status();
    assert.equal((await again.request('POST', '/api/auth/setup', { code, username: 'otro', password: STRONG })).status, 404);
    assert.equal((await again.status()).setupAvailable, false);

    const authRaw = fs.readFileSync(srv.authPath, 'utf8');
    assert.ok(!authRaw.includes(code) && !authRaw.includes(code.replace(/-/g, '')), 'el código no está en auth.json');
    assert.ok(!authRaw.includes(STRONG), 'ni la contraseña');

    // tras reiniciar tampoco se vuelve a ofrecer
    await srv.restart();
    const logsAfter = srv.logs().split('listening')[srv.logs().split('listening').length - 1];
    assert.ok(!CODE_RE.test(logsAfter), 'el reinicio no imprime otro código');
    const s2 = new Session(srv.base);
    assert.equal((await s2.status()).setupAvailable, false);
    assert.equal((await s2.request('POST', '/api/auth/setup', { code, username: 'otro', password: STRONG })).status, 404);
    assert.equal((await new Session(srv.base).login('root', STRONG)).status, 200, 'el administrador creado sigue existiendo');
  } finally {
    await srv.stop();
  }
});

test('REQ-AUTH-03: en producción el asistente web está deshabilitado por defecto y el primer administrador se crea con el CLI', async () => {
  const srv = await startServer({ noUsers: true, noDefaultLogin: true });
  try {
    assert.ok(!CODE_RE.test(srv.logs()), 'no se imprime ningún código de configuración');
    assert.match(srv.logs(), /create-admin/);
    const s = new Session(srv.base);
    const st = await s.status();
    assert.equal(st.setupAvailable, false);
    assert.equal(st.needsAdmin, true);
    assert.equal((await s.request('POST', '/api/auth/setup', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', username: 'root', password: STRONG })).status, 404);

    // CLI: contraseña por stdin; rechaza débiles y duplicados
    const weak = await runCli(srv.statePath, ['create-admin', 'root', '--password-stdin'], '123\n');
    assert.equal(weak.code, 1);
    assert.match(weak.err, /al menos 12/);
    const created = await runCli(srv.statePath, ['create-admin', 'root', '--name', 'Raíz', '--password-stdin'], `${STRONG}\n`);
    assert.equal(created.code, 0, created.err);
    assert.equal((await runCli(srv.statePath, ['create-admin', 'root', '--password-stdin'], `${STRONG}\n`)).code, 1, 'duplicado');
    assert.equal((await runCli(srv.statePath, ['create-user', 'lector', '--role', 'SUPERMAN', '--password-stdin'], `${STRONG}\n`)).code, 2, 'rol inválido');
    assert.equal((await runCli(srv.statePath, ['create-user', 'lector', '--role', 'VIEWER', '--password-stdin'], 'Visitante-Clave-Larga-2026!\n')).code, 0);
    const list = await runCli(srv.statePath, ['list']);
    assert.match(list.out, /root\s+ADMIN\s+activo/);
    assert.match(list.out, /lector\s+VIEWER/);
    assert.ok(!/scrypt|hash|salt/i.test(list.out + list.err), 'el listado no muestra datos de contraseñas');
    assert.ok(!(created.out + created.err).includes(STRONG), 'el CLI no repite la contraseña');

    // el servidor en marcha ve al usuario nuevo sin reiniciar y el asistente web sigue cerrado
    await new Promise((r) => setTimeout(r, 700));
    const adm = new Session(srv.base);
    assert.equal((await adm.login('root', STRONG)).status, 200);
    assert.equal((await adm.status()).needsAdmin, false);
    const viewer = new Session(srv.base);
    assert.equal((await viewer.login('lector', 'Visitante-Clave-Larga-2026!')).status, 200);

    // el CLI actúa sobre sesiones vivas: restablecer, cambiar rol y desactivar las cierran
    assert.equal((await viewer.request('GET', '/api/state')).status, 200);
    assert.equal((await runCli(srv.statePath, ['reset-password', 'lector', '--password-stdin'], 'Otra-Clave-Larga-2026!!\n')).code, 0);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal((await viewer.request('GET', '/api/state')).status, 401, 'restablecer la contraseña cerró la sesión viva');
    assert.equal((await new Session(srv.base).login('lector', 'Visitante-Clave-Larga-2026!')).status, 401, 'la anterior ya no sirve');
    const v2 = new Session(srv.base);
    assert.equal((await v2.login('lector', 'Otra-Clave-Larga-2026!!')).status, 200);
    assert.equal((await runCli(srv.statePath, ['disable', 'lector'])).code, 0);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal((await v2.request('GET', '/api/state')).status, 401, 'desactivar cerró la sesión viva');
    assert.equal((await runCli(srv.statePath, ['disable', 'root'])).code, 1, 'no se puede desactivar al último administrador');

    // todo queda en la auditoría y la cadena sigue válida aunque escriban dos procesos
    const log = AuditLog.open(srv.auditPath, {});
    const entries = (await log.read(200)).entries;
    assert.ok(entries.some((e) => e.action === 'cli.create-user' && e.actor.kind === 'cli'));
    assert.ok(entries.some((e) => e.action === 'cli.disable'));
    assert.notEqual(log.verify().status, 'compromised', 'la cadena se mantiene con el servidor y el CLI escribiendo');
  } finally {
    await srv.stop();
  }
});

test('REQ-SEC-04: el servidor se niega a arrancar en producción sin hosts/orígenes explícitos, y con un auth.json corrupto no abre la configuración inicial', async () => {
  await assert.rejects(startServer({ noUsers: true, noDefaultLogin: true, env: { AQUA_ALLOWED_HOSTS: '' } }), /AQUA_ALLOWED_HOSTS/);
  await assert.rejects(startServer({ noUsers: true, noDefaultLogin: true, env: { AQUA_ALLOWED_ORIGINS: '' } }), /AQUA_ALLOWED_ORIGINS/);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"version":1,"users":[{"id":');
  await assert.rejects(startServer({ dir, noUsers: true, noDefaultLogin: true }), (err: Error) => /no arranca/.test(err.message) && !CODE_RE.test(err.message));
  assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), '{"version":1,"users":[{"id":', 'el archivo corrupto no se toca ni se sobrescribe');
});

test('REQ-AUTH-02/REQ-RES-10: las sesiones y las revocaciones sobreviven al reinicio; el token CSRF se deriva de la sesión; los tokens de operación no', async () => {
  const srv = await startServer();
  try {
    const live = await new Session(srv.base).as('operator');
    const dead = await new Session(srv.base).as('operator');
    await dead.request('POST', '/api/auth/logout', {});
    const admin = defaultSession(srv.base);
    const opTok = await admin.opHeaders('reset', TEST_USERS.admin.password);
    const adminSid = admin.sid;
    const adminCsrf = admin.csrf;
    await srv.restart();
    const after = new Session(srv.base);
    after.cookies = new Map(live.cookies);
    after.csrf = live.csrf;
    assert.equal((await after.request('GET', '/api/state')).status, 200, 'la sesión vigente sigue valiendo (auth.json persistido)');
    assert.equal((await after.request('POST', '/api/scenarios/leak/trigger', {})).status, 200, 'y su token CSRF también (derivado de la sesión)');
    const gone = new Session(srv.base);
    gone.cookies = new Map(dead.cookies);
    gone.csrf = dead.csrf;
    assert.equal((await gone.request('GET', '/api/state')).status, 401, 'la sesión cerrada sigue cerrada');
    const adm2 = new Session(srv.base);
    adm2.cookies.set([...admin.cookies.keys()].find((k) => /aqua_sid$/.test(k))!, adminSid);
    adm2.csrf = adminCsrf;
    assert.equal((await adm2.request('POST', '/api/reset', {}, opTok)).status, 401, 'el token de operación pendiente no sobrevive al reinicio');
  } finally {
    await srv.stop();
  }
});

test('REQ-AUD-02: ni los archivos de datos, ni los logs, ni las respuestas contienen contraseñas, la clave de Gemini ni la clave privada de sellado', async () => {
  const srv = await startServer({ fakeGemini: true });
  try {
    const admin = defaultSession(srv.base);
    const URLS = ['/api/state', '/api/health', '/api/users', '/api/audit?limit=500', '/api/audit/head', '/api/auth/status', '/api/seal/public-key', '/api/kiro/files', '/api/state/export', '/api/ledger/anchor', '/api/state/consistency'];
    const bodies: string[] = [];
    for (const u of URLS) bodies.push(JSON.stringify((await admin.request('GET', u)).data));
    bodies.push(JSON.stringify((await admin.request('POST', '/api/ai/probe', {})).data));
    bodies.push(JSON.stringify((await admin.request('POST', '/api/scenarios/leak/trigger', {})).data));
    bodies.push(JSON.stringify((await admin.request('GET', '/api/ruta-que-no-existe')).data));
    bodies.push(JSON.stringify((await admin.request('POST', '/api/telemetry/ingest', { csvText: 'esto,no,es,csv' })).data));
    bodies.push(JSON.stringify((await anonApi(srv.base, 'POST', '/api/auth/login', '{no json', { 'content-type': 'application/json' })).data));
    await new Session(srv.base).login(TEST_USERS.viewer.username, 'Clave-Incorrecta-9999!');
    const responses = bodies.join('\n');
    const logs = srv.logs();
    // El servidor escribe de forma atómica (archivo .tmp + renombrado): un temporal puede desaparecer entre listar y leer.
    // Un archivo que ya no existe no puede contener secretos; cualquier otro error de lectura sí debe fallar la prueba.
    const readPersisted = (f: string): string | null => {
      try {
        const full = path.join(srv.dir, f);
        if (!fs.statSync(full).isFile() || /seal-key\.pem$|\.bak$/.test(f)) return null;
        return fs.readFileSync(full, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    };
    const files = fs.readdirSync(srv.dir).map(readPersisted).filter((c): c is string => c !== null);
    const privatePem = fs.readFileSync(path.join(srv.dir, 'seal-key.pem'), 'utf8');
    const secrets = ['AIzaSyTEST_FAKE_KEY_0000000000000000', ...Object.values(TEST_USERS).map((u) => u.password), 'Clave-Incorrecta-9999!', 'BEGIN PRIVATE KEY'];
    for (const secret of secrets) {
      assert.ok(!responses.includes(secret), `respuesta con secreto: ${secret.slice(0, 8)}`);
      assert.ok(!logs.includes(secret), `log con secreto: ${secret.slice(0, 8)}`);
      for (const f of files) assert.ok(!f.includes(secret), `archivo de datos con secreto: ${secret.slice(0, 8)}`);
    }
    assert.ok(!responses.includes(privatePem.split('\n')[1]), 'ni el cuerpo de la clave privada');
    assert.ok(!logs.includes(admin.sid) && !responses.includes(admin.sid), 'ni el token de sesión');
    assert.match(logs, /listening/);
  } finally {
    await srv.stop();
  }
});
