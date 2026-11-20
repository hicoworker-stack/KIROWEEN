import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware, evaluateDestructivePolicy, HttpError, installAsyncSafety } from './http';

let server: Server;
let base = '';

before(async () => {
  const app = express();
  installAsyncSafety(app);
  app.use(express.json({ limit: '1kb' }));
  app.get('/ok', (_req, res) => {
    res.json({ ok: true });
  });
  // Reproducen la auditoría: un rechazo en una ruta async de Express 4 mataba el proceso.
  app.get('/boom-async', async () => {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error('fallo de disco simulado con detalle interno secreto');
  });
  app.get('/boom-sync', () => {
    throw new Error('fallo síncrono');
  });
  app.get('/http-error', async () => {
    throw new HttpError(409, 'conflicto de prueba', { blockers: ['a'] });
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('una ruta async que lanza devuelve 500 JSON sin filtrar detalles y el servidor sigue vivo (REQ-RES-06)', async () => {
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const res = await fetch(`${base}/boom-async`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes('secreto'), 'no se filtra el mensaje interno');
  assert.equal((await fetch(`${base}/ok`)).status, 200, 'sigue atendiendo');
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onRej);
  assert.equal(rejections.length, 0, 'no hay promesas rechazadas sin capturar');
});

test('errores síncronos y HttpError conservan su estado y datos extra (REQ-RES-06)', async () => {
  assert.equal((await fetch(`${base}/boom-sync`)).status, 500);
  const res = await fetch(`${base}/http-error`);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'conflicto de prueba', blockers: ['a'] });
});

test('JSON inválido y cuerpo excesivo devuelven 400 y 413, no 500 (REQ-RES-06)', async () => {
  const bad = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{no json' });
  assert.equal(bad.status, 400);
  const big = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 'a'.repeat(5000) }),
  });
  assert.equal(big.status, 413);
});

type Req = { header(name: string): string | undefined; loopback: boolean };
const mkReq = (headers: Record<string, string>, loopback = true): Req => ({
  header: (n) => headers[n.toLowerCase()],
  loopback,
});

test('operación destructiva sin cabecera de confirmación se rechaza siempre (REQ-SEC-01, anti-CSRF)', () => {
  const d = evaluateDestructivePolicy('reset', mkReq({}), { NODE_ENV: 'development' });
  assert.equal(d.allow, false);
  if (!d.allow) assert.equal(d.status, 400);
  const wrongOp = evaluateDestructivePolicy('reset', mkReq({ 'x-aqua-confirm': 'import' }), { NODE_ENV: 'development' });
  assert.equal(wrongOp.allow, false);
});

test('en producción sin token ni habilitación explícita todo es 403, incluso desde loopback (REQ-SEC-01)', () => {
  const d = evaluateDestructivePolicy('reset', mkReq({ 'x-aqua-confirm': 'reset' }), { NODE_ENV: 'production' });
  assert.deepEqual(d.allow ? null : d.status, 403);
});

test('en desarrollo se permite solo desde loopback (REQ-SEC-01)', () => {
  const ok = evaluateDestructivePolicy('demo', mkReq({ 'x-aqua-confirm': 'demo' }), { NODE_ENV: 'development' });
  assert.equal(ok.allow, true);
  const remote = evaluateDestructivePolicy('demo', mkReq({ 'x-aqua-confirm': 'demo' }, false), { NODE_ENV: 'development' });
  assert.equal(remote.allow, false);
});

test('con AQUA_ADMIN_TOKEN se exige el token, y el loopback no basta (REQ-SEC-01)', () => {
  const env = { AQUA_ADMIN_TOKEN: 'secreto-largo', NODE_ENV: 'development' };
  assert.equal(evaluateDestructivePolicy('import', mkReq({ 'x-aqua-confirm': 'import' }), env).allow, false);
  const wrong = evaluateDestructivePolicy('import', mkReq({ 'x-aqua-confirm': 'import', 'x-admin-token': 'otro' }), env);
  assert.deepEqual(wrong.allow ? null : wrong.status, 401);
  assert.equal(
    evaluateDestructivePolicy('import', mkReq({ 'x-aqua-confirm': 'import', 'x-admin-token': 'secreto-largo' }, false), env).allow,
    true
  );
});

test('AQUA_ALLOW_DESTRUCTIVE=1 habilita explícitamente una demo desplegada (REQ-SEC-01)', () => {
  const d = evaluateDestructivePolicy('reset', mkReq({ 'x-aqua-confirm': 'reset' }, false), {
    NODE_ENV: 'production',
    AQUA_ALLOW_DESTRUCTIVE: '1',
  });
  assert.equal(d.allow, true);
});
