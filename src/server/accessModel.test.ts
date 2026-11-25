import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from './authStore';
import { DEFAULT_JUDGE_USER, ensureJudgeAccount } from './judgeAccount';
import { FAST_SCRYPT } from './testing/harness';
import { InProc, startInProc } from './testing/inproc';

/**
 * REQ-ACC-01..03: modelo de acceso. Por defecto nadie escribe sin cuenta; el acceso libre es opt-in, solo para desarrollo
 * local, y se ignora en producción y en modo público; los jueces reciben una cuenta OPERATOR definida solo por entorno.
 */
const WRITE = '/api/scenarios/leak/trigger';

async function withServer(opts: Parameters<typeof startInProc>[0], run: (srv: InProc) => Promise<void>) {
  const srv = await startInProc(opts);
  try {
    await run(srv);
  } finally {
    await srv.close();
  }
}

test('REQ-ACC-01: por defecto no hay sesión automática: ni lectura ni escritura sin cuenta', async () => {
  await withServer({ production: false }, async (srv) => {
    const anon = srv.anon();
    const status = await anon.request('GET', '/api/auth/status');
    assert.equal(status.data.authenticated, false);
    assert.equal(status.data.openAccess, false);
    assert.equal((await anon.request('GET', '/api/state')).status, 401);
    assert.equal((await anon.request('POST', WRITE, {})).status, 401);
  });
});

test('REQ-ACC-01: el acceso libre explícito (solo desarrollo local) abre una sesión de invitado OPERATOR sin permisos de administración', async () => {
  await withServer({ production: false, env: { AQUA_OPEN_ACCESS: '1' } }, async (srv) => {
    const anon = srv.anon();
    const status = await anon.request('GET', '/api/auth/status');
    assert.equal(status.data.openAccess, true);
    assert.equal(status.data.authenticated, true);
    assert.equal(status.data.user.role, 'OPERATOR');
    assert.equal((await anon.request('GET', '/api/state')).status, 200);
    for (const adminOnly of ['/api/users', '/api/audit']) assert.equal((await anon.request('GET', adminOnly)).status, 403, adminOnly);
  });
});

test('REQ-ACC-01: el acceso libre se ignora en producción: el visitante no recibe sesión', async () => {
  await withServer({ production: true, env: { AQUA_OPEN_ACCESS: '1' } }, async (srv) => {
    const anon = srv.anon();
    const status = await anon.request('GET', '/api/auth/status');
    assert.equal(status.data.openAccess, false);
    assert.equal(status.data.authenticated, false);
    assert.equal((await anon.request('POST', WRITE, {})).status, 401);
  });
});

test('REQ-ACC-02: en modo público el visitante lee la demostración pero nunca escribe, aunque se pida el acceso libre', async () => {
  await withServer({ production: true, env: { AQUA_PUBLIC_MODE: '1', AQUA_OPEN_ACCESS: '1' } }, async (srv) => {
    const anon = srv.anon();
    const status = await anon.request('GET', '/api/auth/status');
    assert.equal(status.data.publicMode, true);
    assert.equal(status.data.openAccess, false);
    assert.equal(status.data.authenticated, false);
    assert.equal((await anon.request('GET', '/api/state')).status, 200, 'la lectura pública sigue disponible');
    for (const [method, url] of [['POST', WRITE], ['POST', '/api/telemetry/ingest'], ['PATCH', '/api/work-orders/x'], ['POST', '/api/sync/offline']] as const) {
      assert.equal((await anon.request(method, url, {})).status, 401, `${method} ${url}`);
    }
  });
});

test('REQ-ACC-03: la cuenta de juez es OPERATOR, nace solo desde el entorno, exige una contraseña robusta y es idempotente', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-judge-')), 'auth.json');
  const store = AuthStore.open(file, { scrypt: FAST_SCRYPT });
  assert.deepEqual(await ensureJudgeAccount(store, {}), { status: 'disabled' });
  const weak = await ensureJudgeAccount(store, { AQUA_JUDGE_PASSWORD: 'corta' });
  assert.equal(weak.status, 'rejected');
  assert.equal(store.hasUsers(), false, 'una contraseña débil no crea la cuenta');
  const password = 'Evaluador-Kiroween-2026!';
  assert.deepEqual(await ensureJudgeAccount(store, { AQUA_JUDGE_PASSWORD: password }), { status: 'created', username: DEFAULT_JUDGE_USER });
  const judge = store.findByUsername(DEFAULT_JUDGE_USER)!;
  assert.equal(judge.role, 'OPERATOR', 'sin administración de usuarios, auditoría ni operaciones destructivas');
  assert.deepEqual(await ensureJudgeAccount(store, { AQUA_JUDGE_PASSWORD: 'Otra-Clave-Distinta-9!' }), { status: 'exists', username: DEFAULT_JUDGE_USER });
  assert.ok(await store.verifyCredentials(DEFAULT_JUDGE_USER, password), 'la contraseña original no se reemplaza');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(password), 'la contraseña nunca se guarda en claro');
});
