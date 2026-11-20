import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware, HttpError, installAsyncSafety, safeEqual } from './http';

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

// REQ-SEC-01 (v1): las 5 pruebas de la política por entorno (AQUA_ADMIN_TOKEN / AQUA_ALLOW_DESTRUCTIVE) se retiraron al eliminar esas variables en la Fase 2.
// Su intención (sin confirmación se rechaza; producción sin autorización es denegada; el token incorrecto se rechaza; nada se ejecuta sin autorización explícita)
// está cubierta con peticiones HTTP reales en src/server/security.e2e.test.ts (REQ-SEC-01, REQ-SEC-05).

test('safeEqual compara en tiempo constante y distingue cadenas distintas o de distinta longitud', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
