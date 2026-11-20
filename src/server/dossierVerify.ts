import {
  DecisionDossier,
  DossierCheck,
  verifyDossierIntegrity,
} from '../core/dossier';
import {
  checkAnchorAgainstLedger,
  keyIdFromPublicPem,
  verifyAnchorSignature,
  verifyReceiptSignature,
} from './sealing';

/**
 * REQ-LED-05: verificación completa de un expediente, separando tres propiedades que SHA-256 por sí solo no da:
 *  - INTEGRIDAD: el contenido no cambió desde el sellado (digests + cadena).
 *  - AUTENTICIDAD DEL EMISOR: el sello lo firmó la clave que el verificador conoce. Requiere una clave FIJADA
 *    (trustedPublicKeyPem o trustedKeyId) obtenida por un canal independiente del expediente.
 *  - INMUTABILIDAD: este sistema NO la garantiza; se declara explícitamente.
 */

export interface VerifyOptions {
  /** Clave pública PEM de confianza (por ejemplo la del servidor, o la que el jurado anotó durante la demo). */
  trustedPublicKeyPem?: string;
  /** Alternativa: solo la huella (keyId) de la clave de confianza. Permite pinning sin la clave completa. */
  trustedKeyId?: string;
}

export type AuthenticityStatus = 'verified' | 'partial' | 'unpinned' | 'absent' | 'invalid';

export interface DossierVerification {
  integrity: { valid: boolean; checks: DossierCheck[] };
  authenticity: { status: AuthenticityStatus; detail: string; checks: DossierCheck[] };
  immutability: { guaranteed: false; note: string };
  /**
   *  verified: integridad + sello firmado + clave fijada + ancla coherente.
   *  integrity-only: el contenido es coherente pero NO se puede afirmar quién lo emitió ni descartar truncamiento.
   *  invalid: se detectó una alteración.
   */
  overall: 'verified' | 'integrity-only' | 'invalid';
  valid: boolean;
}

const IMMUTABILITY_NOTE =
  'Ni el ledger ni las firmas hacen el sistema inmutable: quien controle el servidor puede reescribir su historia y firmar de nuevo. ' +
  'La protección real viene de conservar fuera del servidor los recibos, las anclas y la huella de la clave pública.';

export async function verifyDossierFull(d: DecisionDossier, options: VerifyOptions = {}): Promise<DossierVerification> {
  const integrityChecks = await verifyDossierIntegrity(d);
  const integrityValid = integrityChecks.every((c) => c.ok);

  const checks: DossierCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

  const receipt = d.seal?.receipt ?? null;
  let status: AuthenticityStatus;
  let detail: string;

  if (!receipt) {
    status = 'absent';
    detail = 'El expediente no trae recibo firmado: no se puede afirmar quién lo emitió.';
  } else {
    // Clave con la que se verifica: la fijada por el verificador, o (solo informativamente) la incluida en el expediente.
    const pinnedPem = options.trustedPublicKeyPem;
    const pinnedId = options.trustedKeyId ?? (pinnedPem ? safeKeyId(pinnedPem) : undefined);
    const embeddedPem = d.issuer?.publicKeyPem;
    const verifyPem = pinnedPem ?? embeddedPem;
    const pinned = Boolean(pinnedId);

    if (!verifyPem) {
      status = 'invalid';
      detail = 'No hay clave pública para verificar el recibo (ni fijada ni incluida).';
      add('receipt-key', 'Clave pública disponible', false, detail);
    } else {
      const usedKeyId = safeKeyId(verifyPem);
      add('receipt-key', 'La clave del emisor coincide con la del recibo', usedKeyId === receipt.payload.keyId, `keyId recibo ${receipt.payload.keyId.slice(0, 16)}… / clave ${usedKeyId?.slice(0, 16) ?? '?'}…`);
      add('receipt-pin', 'La clave del emisor es la fijada por el verificador', pinned ? usedKeyId === pinnedId : false, pinned ? (usedKeyId === pinnedId ? 'Coincide con la clave fijada.' : 'NO coincide con la clave fijada.') : 'No se fijó ninguna clave: la del expediente no es una referencia independiente.');
      add('receipt-signature', 'Firma Ed25519 del recibo', verifyReceiptSignature(verifyPem, receipt), 'Firma sobre {orden, digest, bloque de cierre}.');
      const closed = d.ledger?.find((e) => e.index === receipt.payload.closedLedgerIndex);
      add(
        'receipt-binding',
        'El recibo firmado corresponde a este contenido y a este bloque del ledger',
        receipt.payload.orderId === d.sealed?.order?.id &&
          receipt.payload.dossierDigest === d.seal.dossierDigest &&
          receipt.payload.closedLedgerIndex === d.seal.closedLedgerIndex &&
          receipt.payload.closedLedgerHash === d.seal.closedLedgerHash &&
          closed?.hash === receipt.payload.closedLedgerHash,
        'Orden, digest, índice y hash del bloque de cierre deben coincidir con lo firmado.'
      );

      const anchor = d.anchor;
      if (anchor) {
        add('anchor-key', 'El ancla fue firmada por la misma clave', anchor.payload.keyId === receipt.payload.keyId, 'keyId del ancla.');
        add('anchor-signature', 'Firma Ed25519 del ancla', verifyAnchorSignature(verifyPem, anchor), 'Firma sobre {altura, hash de cabeza}.');
        const consistent = checkAnchorAgainstLedger(anchor, d.ledger ?? []);
        add('anchor-ledger', 'El ledger contiene la cabeza certificada por el ancla (sin truncamiento)', consistent.ok, consistent.ok ? `Altura ${anchor.payload.height} verificada.` : consistent.reason);
        add('anchor-after-closure', 'El ancla es posterior al cierre', anchor.payload.height > receipt.payload.closedLedgerIndex, `altura ${anchor.payload.height} vs cierre #${receipt.payload.closedLedgerIndex}`);
      }

      const signaturesBad = checks.some((c) => !c.ok && c.id !== 'receipt-pin');
      if (signaturesBad) {
        status = 'invalid';
        detail = 'Una firma o vínculo del sello no es válido: ' + checks.filter((c) => !c.ok && c.id !== 'receipt-pin').map((c) => c.label).join('; ') + '.';
      } else if (!pinned) {
        status = 'unpinned';
        detail = 'Las firmas son válidas, pero no se fijó una clave de confianza: un falsificador podría haber firmado con su propia clave. Usa --pubkey o --keyid con la clave anotada durante la demo.';
      } else if (usedKeyId !== pinnedId) {
        status = 'invalid';
        detail = 'La clave del expediente no es la fijada por el verificador: el emisor no es el esperado.';
      } else if (!anchor) {
        status = 'partial';
        detail = 'Recibo firmado y clave fijada, pero el expediente no trae ancla: no se puede descartar un truncamiento posterior al cierre.';
      } else {
        status = 'verified';
        detail = 'Recibo y ancla firmados por la clave fijada, y el ledger contiene la cabeza certificada.';
      }
    }
  }

  let overall: DossierVerification['overall'];
  if (!integrityValid || status === 'invalid') overall = 'invalid';
  else if (status === 'verified') overall = 'verified';
  else overall = 'integrity-only';

  return {
    integrity: { valid: integrityValid, checks: integrityChecks },
    authenticity: { status, detail, checks },
    immutability: { guaranteed: false, note: IMMUTABILITY_NOTE },
    overall,
    valid: overall === 'verified',
  };
}

function safeKeyId(pem: string): string | undefined {
  try {
    return keyIdFromPublicPem(pem);
  } catch {
    return undefined;
  }
}
