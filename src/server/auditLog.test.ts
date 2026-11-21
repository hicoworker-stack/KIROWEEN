import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuditLog, AuditWriteError, sanitizeMeta } from './auditLog';
import { keyIdFromPublicPem, SealKeys } from './sealing';

function makeKeys(): SealKeys {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKeyPem, keyId: keyIdFromPublicPem(publicKeyPem), persistence: 'ephemeral' };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-audit-')), 'audit.jsonl');
const ev = (action: string, extra: Record<string, unknown> = {}) => ({
  actor: { kind: 'user' as const, id: 'usr_1', username: 'ana', role: 'ADMIN' },
  ip: '127.0.0.1',
  action,
  outcome: 'success' as const,
  ...extra,
});

test('auditoría: las entradas se encadenan por hash, sobreviven al reinicio y verifican (REQ-AUD-01)', async () => {
  const file = tmp();
  const keys = makeKeys();
  const log = AuditLog.open(file, { keys });
  const a = await log.record(ev('auth.login'));
  const b = await log.record(ev('work-order.close', { resource: 'OT-1' }));
  assert.equal(a.prevHash, '0'.repeat(64));
  assert.equal(b.prevHash, a.hash);
  assert.equal(log.verify().status, 'ok');
  const reopened = AuditLog.open(file, { keys });
  const c = await reopened.record(ev('auth.logout'));
  assert.equal(c.seq, 3);
  assert.equal(c.prevHash, b.hash);
  assert.equal(reopened.verify().status, 'ok');
  assert.equal(reopened.verify().count, 3);
});

test('auditoría: modificar, borrar o reordenar una entrada se detecta (REQ-AUD-01)', async () => {
  const keys = makeKeys();
  const build = async () => {
    const file = tmp();
    const log = AuditLog.open(file, { keys });
    for (const a of ['uno', 'dos', 'tres', 'cuatro']) await log.record(ev(a));
    return { file, lines: fs.readFileSync(file, 'utf8').trimEnd().split('\n') };
  };
  // modificación
  let { file, lines } = await build();
  const tampered = JSON.parse(lines[1]);
  tampered.actor.username = 'otra-persona';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(AuditLog.open(file, { keys }).verify().status, 'compromised');
  // borrado de una entrada intermedia
  ({ file, lines } = await build());
  lines.splice(1, 1);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(AuditLog.open(file, { keys }).verify().status, 'compromised');
  // reordenamiento
  ({ file, lines } = await build());
  [lines[1], lines[2]] = [lines[2], lines[1]];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(AuditLog.open(file, { keys }).verify().status, 'compromised');
  // truncado del final: la cadena sigue siendo válida, pero la cabeza firmada lo delata
  ({ file, lines } = await build());
  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');
  const v = AuditLog.open(file, { keys }).verify();
  assert.equal(v.status, 'compromised');
  assert.match(v.issues.join(' '), /truncado/);
});

test('auditoría: reescribir todo el archivo sin la clave no engaña a la cabeza firmada; con la clave sí (limitación declarada)', async () => {
  const keys = makeKeys();
  const file = tmp();
  const log = AuditLog.open(file, { keys });
  for (const a of ['uno', 'dos', 'tres']) await log.record(ev(a));
  // un atacante sin clave rehace la cadena entera con otros contenidos
  const forged = AuditLog.open(tmp(), {});
  for (const a of ['x', 'y', 'z']) await forged.record(ev(a));
  fs.copyFileSync(forged.file, file);
  assert.equal(AuditLog.open(file, { keys }).verify().status, 'compromised', 'la cabeza firmada original no coincide con la cadena reescrita');
  // quien controla el servidor SÍ puede rehacer cadena y firma: no es inmutabilidad.
  const insider = AuditLog.open(file + '.2.jsonl', { keys });
  for (const a of ['x', 'y', 'z']) await insider.record(ev(a));
  assert.equal(insider.verify().status, 'ok', 'una cadena reescrita CON la clave verifica: el registro no es inmutable frente al administrador del servidor');
});

test('auditoría: no registra contraseñas, tokens ni secretos aunque lleguen en los metadatos (REQ-AUD-02)', async () => {
  const file = tmp();
  const log = AuditLog.open(file, { keys: makeKeys() });
  await log.record(
    ev('auth.login', {
      meta: { password: 'Clave-Secreta-1!', newPassword: 'x', sessionToken: 'tok-secreto-zq9', apiKey: 'AIza...', csrfToken: 'c', operationToken: 't', authorization: 'Bearer z', cookie: 'sid=1', setupCode: 'setup-zq9-codigo', operation: 'reset', count: 3, ok: true, 'mala clave': 'x', nested: { a: 1 } },
      reason: 'fallo',
    })
  );
  const raw = fs.readFileSync(file, 'utf8');
  for (const secret of ['Clave-Secreta-1!', 'AIza', 'Bearer', 'sid=1', 'setup-zq9-codigo', 'tok-secreto-zq9']) assert.ok(!raw.includes(secret), `no debe aparecer ${secret}`);
  const meta = JSON.parse(raw.trim()).meta;
  assert.deepEqual(meta, { operation: 'reset', count: 3, ok: true });
  assert.equal(String(sanitizeMeta({ a: 'x'.repeat(500) })!.a).length, 200);
});

test('auditoría: los caracteres de control no pueden falsificar líneas ni columnas (inyección en el registro)', async () => {
  const file = tmp();
  const log = AuditLog.open(file, { keys: makeKeys() });
  await log.record(ev('x', { reason: 'linea1\n{"seq":99,"action":"falsa"}\r\nlinea2', resource: 'a\nb', actor: { kind: 'anonymous', id: null, username: 'adm\nin' } }));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1, 'una sola línea física');
  assert.equal(JSON.parse(lines[0]).seq, 1);
});

test('auditoría: fallo de disco → record lanza, la cadena no avanza, se informa y se recupera (REQ-RES-10)', async () => {
  const file = tmp();
  let fail = false;
  const log = AuditLog.open(file, {
    keys: makeKeys(),
    appendLine: (f, l) => {
      if (fail) {
        fs.appendFileSync(f, l.slice(0, 20)); // escritura parcial: el peor caso
        throw new Error('ENOSPC simulado');
      }
      fs.appendFileSync(f, l);
    },
  });
  await log.record(ev('uno'));
  fail = true;
  await assert.rejects(log.record(ev('dos')), AuditWriteError);
  assert.equal(await log.recordBestEffort(ev('tres')), null, 'recordBestEffort no lanza');
  assert.equal(log.status().count, 1);
  assert.equal(log.status().status, 'degraded');
  assert.equal(log.status().failedWrites, 2);
  fail = false;
  const ok = await log.record(ev('cuatro'));
  assert.equal(ok.seq, 2);
  const v = AuditLog.open(file, { keys: undefined }).verify();
  assert.equal(v.count, 2, 'la línea parcial no rompió la cadena posterior');
  assert.equal(v.status === 'compromised', false);
});

test('auditoría: una línea final cortada por un fallo de energía se tolera y la siguiente entrada se encadena bien', async () => {
  const keys = makeKeys();
  const file = tmp();
  const log = AuditLog.open(file, { keys });
  await log.record(ev('uno'));
  await log.record(ev('dos'));
  fs.appendFileSync(file, '{"seq":3,"ts":"2026');
  const reopened = AuditLog.open(file, { keys });
  assert.equal(reopened.status().count, 2);
  assert.match(reopened.status().issues.join(' '), /incompleta/);
  const e = await reopened.record(ev('tres'));
  assert.equal(e.seq, 3);
  assert.notEqual(AuditLog.open(file, { keys }).verify().status, 'compromised');
});

test('auditoría: escrituras concurrentes se serializan sin perder ni duplicar números de secuencia', async () => {
  const file = tmp();
  const log = AuditLog.open(file, { keys: makeKeys() });
  await Promise.all(Array.from({ length: 40 }, (_, i) => log.record(ev(`op-${i}`))));
  const v = log.verify();
  assert.equal(v.count, 40);
  assert.equal(v.status, 'ok');
  const { entries, total } = await log.read(500);
  assert.equal(total, 40);
  assert.equal(new Set(entries.map((e) => e.seq)).size, 40);
});

test('auditoría: lectura paginada, más recientes primero y con tope', async () => {
  const log = AuditLog.open(tmp(), {});
  for (let i = 0; i < 12; i++) await log.record(ev(`op-${i}`));
  const page = await log.read(5, 0);
  assert.equal(page.entries[0].action, 'op-11');
  assert.equal(page.entries.length, 5);
  assert.equal((await log.read(5, 10)).entries.length, 2);
  assert.equal((await log.read(100000, 0)).entries.length, 12);
});

test('auditoría: dos procesos (servidor y CLI) que escriben en el mismo archivo mantienen una sola cadena válida', async () => {
  const keys = makeKeys();
  const file = tmp();
  const server = AuditLog.open(file, { keys });
  await server.record(ev('servidor-1'));
  const cli = AuditLog.open(file, { keys });
  await cli.record(ev('cli-1'));
  await server.record(ev('servidor-2')); // el servidor retoma desde el final real del archivo
  await cli.record(ev('cli-2'));
  const v = AuditLog.open(file, {}).verify();
  assert.equal(v.count, 4);
  assert.equal(v.status, 'ok');
});
