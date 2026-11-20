import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLedgerEntry } from '../core/cryptoLedger';
import { TrustLedgerEntry } from '../core/types';
import {
  checkAnchorAgainstLedger,
  issueAnchor,
  issueReceipt,
  keyIdFromPublicPem,
  loadOrCreateSealKeys,
  verifyAnchorSignature,
  verifyJson,
  verifyReceiptSignature,
  signJson,
} from './sealing';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-key-'));

async function ledgerOf(n: number): Promise<TrustLedgerEntry[]> {
  let l: TrustLedgerEntry[] = [];
  for (let i = 0; i < n; i++) {
    l = await appendLedgerEntry(l, { action: `A${i}`, actor: 'x', assetId: 'n', evidenceSummary: 's', previousState: 'a', newState: 'b' });
  }
  return l;
}

test('la clave de sellado se persiste y se recarga idéntica (REQ-LED-05)', () => {
  const dir = tmp();
  const a = loadOrCreateSealKeys({ dir });
  assert.equal(a.persistence, 'file');
  const b = loadOrCreateSealKeys({ dir });
  assert.equal(a.keyId, b.keyId);
  assert.equal(keyIdFromPublicPem(a.publicKeyPem), a.keyId);
  assert.match(a.keyId, /^[a-f0-9]{64}$/);
});

test('si la clave no se puede persistir se declara efímera, no se finge persistencia (REQ-LED-05)', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'archivo');
  fs.writeFileSync(blocker, 'x');
  const k = loadOrCreateSealKeys({ dir: path.join(blocker, 'sub') });
  assert.equal(k.persistence, 'ephemeral');
});

test('una clave inyectada por entorno se usa tal cual (REQ-LED-05)', () => {
  const generated = loadOrCreateSealKeys({ dir: tmp() });
  const dir = tmp();
  const first = loadOrCreateSealKeys({ dir });
  const privatePem = fs.readFileSync(path.join(dir, 'seal-key.pem'), 'utf8');
  const fromEnv = loadOrCreateSealKeys({ dir: tmp(), envPem: privatePem.replace(/\n/g, '\\n') });
  assert.equal(fromEnv.persistence, 'env');
  assert.equal(fromEnv.keyId, first.keyId);
  assert.notEqual(fromEnv.keyId, generated.keyId);
});

test('firma y verificación: cualquier cambio del contenido invalida la firma (REQ-LED-05)', () => {
  const k = loadOrCreateSealKeys({ dir: tmp() });
  const payload = { a: 1, b: ['x'] };
  const sig = signJson(k, payload);
  assert.equal(verifyJson(k.publicKeyPem, payload, sig), true);
  assert.equal(verifyJson(k.publicKeyPem, { a: 2, b: ['x'] }, sig), false);
  assert.equal(verifyJson(k.publicKeyPem, { b: ['x'], a: 1 }, sig), true, 'el orden de claves no importa (JSON canónico)');
  assert.equal(verifyJson(k.publicKeyPem, payload, 'AAAA'), false);
  assert.equal(verifyJson('no es una clave', payload, sig), false);
  const other = loadOrCreateSealKeys({ dir: tmp() });
  assert.equal(verifyJson(other.publicKeyPem, payload, sig), false, 'otra clave no valida');
});

test('recibo y ancla: firmas válidas y alteración detectada (REQ-LED-05)', async () => {
  const k = loadOrCreateSealKeys({ dir: tmp() });
  const ledger = await ledgerOf(4);
  const receipt = issueReceipt(k, { orderId: 'OT-1', dossierDigest: 'd'.repeat(64), closedLedgerIndex: 3, closedLedgerHash: ledger[3].hash });
  assert.equal(verifyReceiptSignature(k.publicKeyPem, receipt), true);
  assert.equal(verifyReceiptSignature(k.publicKeyPem, { ...receipt, payload: { ...receipt.payload, orderId: 'OT-2' } }), false);
  const anchor = issueAnchor(k, ledger);
  assert.equal(anchor.payload.height, 4);
  assert.equal(verifyAnchorSignature(k.publicKeyPem, anchor), true);
  assert.equal(verifyAnchorSignature(k.publicKeyPem, { ...anchor, payload: { ...anchor.payload, height: 2 } }), false);
});

test('ancla vs ledger: detecta truncamiento y reescritura de historia (REQ-LED-05)', async () => {
  const k = loadOrCreateSealKeys({ dir: tmp() });
  const ledger = await ledgerOf(5);
  const anchor = issueAnchor(k, ledger);
  assert.deepEqual(checkAnchorAgainstLedger(anchor, ledger), { ok: true });
  const extended = await appendLedgerEntry(ledger, { action: 'MAS', actor: 'x', assetId: 'n', evidenceSummary: 's', previousState: 'a', newState: 'b' });
  assert.deepEqual(checkAnchorAgainstLedger(anchor, extended), { ok: true }, 'un ledger que crece sigue conteniendo la cabeza certificada');
  const truncated = checkAnchorAgainstLedger(anchor, ledger.slice(0, 3));
  assert.equal(truncated.ok, false);
  const rewritten = await ledgerOf(5); // misma longitud, otra historia
  assert.equal(checkAnchorAgainstLedger(anchor, rewritten).ok, false);
  const empty = issueAnchor(k, []);
  assert.deepEqual(checkAnchorAgainstLedger(empty, []), { ok: true });
});
