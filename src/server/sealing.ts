import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../core/canonical';
import { GENESIS_HASH } from '../core/cryptoLedger';
import { SignedAnchor, SignedReceipt, TrustLedgerEntry } from '../core/types';

/**
 * REQ-LED-05: sellado con firma Ed25519.
 *
 * Qué aporta y qué NO:
 *  - Integridad: un SHA-256 encadenado detecta ediciones. Cualquiera con el código puede recalcular una cadena
 *    entera, así que el hash por sí solo no distingue un original de una falsificación bien hecha.
 *  - Autenticidad del EMISOR: la firma Ed25519 demuestra que un recibo o ancla los emitió quien posee la clave
 *    privada del servidor. Solo tiene valor si el verificador conoce la clave pública por un canal independiente
 *    del expediente (la "fija"). Una clave incluida dentro del propio expediente no prueba nada.
 *  - NO es autenticidad del AUTOR de los datos (quién midió, quién reparó): no hay autenticación de usuarios.
 *  - NO es inmutabilidad: quien controle el servidor puede firmar lo que quiera. Los recibos y anclas solo protegen
 *    a quien los conserva fuera del servidor.
 */

export interface SealKeys {
  privateKey: crypto.KeyObject;
  publicKeyPem: string;
  keyId: string;
  /** 'file': persistida junto al estado. 'env': inyectada. 'ephemeral': se perderá al reiniciar (los recibos antiguos dejarían de poder verificarse con ella). */
  persistence: 'file' | 'env' | 'ephemeral';
}

export function keyIdFromPublicPem(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function fromPrivatePem(pem: string, persistence: SealKeys['persistence']): SealKeys {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('La clave de sellado debe ser Ed25519.');
  }
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKeyPem, keyId: keyIdFromPublicPem(publicKeyPem), persistence };
}

export function loadOrCreateSealKeys(options: {
  dir: string;
  envPem?: string;
  fileName?: string;
}): SealKeys {
  if (options.envPem && options.envPem.trim().length > 0) {
    return fromPrivatePem(options.envPem.replace(/\\n/g, '\n'), 'env');
  }
  const file = path.join(options.dir, options.fileName ?? 'seal-key.pem');
  try {
    if (fs.existsSync(file)) return fromPrivatePem(fs.readFileSync(file, 'utf8'), 'file');
  } catch (err) {
    console.warn('[sellado] No se pudo leer la clave de sellado existente; se generará una efímera:', err);
    return generateEphemeral();
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  try {
    fs.mkdirSync(options.dir, { recursive: true });
    fs.writeFileSync(file, pem, { mode: 0o600 });
    return fromPrivatePem(pem, 'file');
  } catch (err) {
    console.warn('[sellado] No se pudo persistir la clave de sellado; será efímera:', err);
    return fromPrivatePem(pem, 'ephemeral');
  }
}

function generateEphemeral(): SealKeys {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return fromPrivatePem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'ephemeral');
}

export function signJson(keys: SealKeys, payload: unknown): string {
  return crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), keys.privateKey).toString('base64');
}

export function verifyJson(publicKeyPem: string, payload: unknown, signatureB64: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64')
    );
  } catch {
    return false;
  }
}

export function issueReceipt(
  keys: SealKeys,
  data: { orderId: string; dossierDigest: string; closedLedgerIndex: number; closedLedgerHash: string; now?: string }
): SignedReceipt {
  const payload = {
    v: 1 as const,
    kind: 'closure-receipt' as const,
    orderId: data.orderId,
    dossierDigest: data.dossierDigest,
    closedLedgerIndex: data.closedLedgerIndex,
    closedLedgerHash: data.closedLedgerHash,
    issuedAt: data.now ?? new Date().toISOString(),
    keyId: keys.keyId,
  };
  return { payload, signature: signJson(keys, payload) };
}

export function issueAnchor(keys: SealKeys, ledger: TrustLedgerEntry[], now?: string): SignedAnchor {
  const payload = {
    v: 1 as const,
    kind: 'ledger-anchor' as const,
    height: ledger.length,
    headHash: ledger.length === 0 ? GENESIS_HASH : ledger[ledger.length - 1].hash,
    issuedAt: now ?? new Date().toISOString(),
    keyId: keys.keyId,
  };
  return { payload, signature: signJson(keys, payload) };
}

export function verifyReceiptSignature(publicKeyPem: string, receipt: SignedReceipt): boolean {
  return verifyJson(publicKeyPem, receipt.payload, receipt.signature);
}

export function verifyAnchorSignature(publicKeyPem: string, anchor: SignedAnchor): boolean {
  return verifyJson(publicKeyPem, anchor.payload, anchor.signature);
}

/** ¿El ledger contiene la cabeza que el ancla certificó? Detecta truncamiento y reescritura de historia. */
export function checkAnchorAgainstLedger(
  anchor: SignedAnchor,
  ledger: TrustLedgerEntry[]
): { ok: true } | { ok: false; reason: string } {
  const { height, headHash } = anchor.payload;
  if (ledger.length < height) {
    return {
      ok: false,
      reason: `El ledger tiene ${ledger.length} bloque(s) pero el ancla firmada certifica ${height}: faltan ${height - ledger.length} (truncamiento u omisión).`,
    };
  }
  const expected = height === 0 ? GENESIS_HASH : ledger[height - 1].hash;
  if (expected !== headHash) {
    return { ok: false, reason: `El bloque #${height - 1} no coincide con la cabeza certificada por el ancla (historia reescrita).` };
  }
  return { ok: true };
}
