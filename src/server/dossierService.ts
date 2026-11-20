import {
  computeSealDigests,
  DecisionDossier,
  DOSSIER_FORMAT,
  deriveSyntheticFlag,
  SealDigests,
  SealedContent,
} from '../core/dossier';
import { OrderSeal, TrustLedgerEntry } from '../core/types';
import { issueAnchor, issueReceipt, SealKeys } from './sealing';

/**
 * REQ-LED-03/05: puente entre el estado del servidor y el expediente sellado.
 * Flujo al cerrar una orden:
 *   1. prepareSeal(contenido)        → digests (se escriben en la entrada WORK_ORDER_CLOSED del ledger)
 *   2. append WORK_ORDER_CLOSED      → el ledger ya compromete el digest
 *   3. finalizeSeal(...)             → sello de la orden + recibo firmado que referencia ese bloque
 */

export function prepareSeal(content: SealedContent): Promise<SealDigests> {
  return computeSealDigests(content);
}

export function finalizeSeal(
  keys: SealKeys | null,
  orderId: string,
  digests: SealDigests,
  closedEntry: TrustLedgerEntry,
  now: string = new Date().toISOString()
): OrderSeal {
  return {
    version: 1,
    dossierDigest: digests.dossierDigest,
    componentDigests: digests.componentDigests,
    sealedAt: now,
    closedLedgerIndex: closedEntry.index,
    closedLedgerHash: closedEntry.hash,
    receipt: keys
      ? issueReceipt(keys, {
          orderId,
          dossierDigest: digests.dossierDigest,
          closedLedgerIndex: closedEntry.index,
          closedLedgerHash: closedEntry.hash,
          now,
        })
      : null,
  };
}

export function exportDossier(input: {
  keys: SealKeys | null;
  sealed: SealedContent;
  seal: OrderSeal;
  ledger: TrustLedgerEntry[];
  evidencePhoto: DecisionDossier['evidencePhoto'];
  now?: string;
}): DecisionDossier {
  const now = input.now ?? new Date().toISOString();
  return {
    format: DOSSIER_FORMAT,
    generatedAt: now,
    syntheticData: deriveSyntheticFlag(input.sealed),
    sealed: input.sealed,
    seal: input.seal,
    anchor: input.keys ? issueAnchor(input.keys, input.ledger, now) : null,
    issuer: input.keys ? { keyId: input.keys.keyId, publicKeyPem: input.keys.publicKeyPem } : null,
    ledger: input.ledger,
    evidencePhoto: input.evidencePhoto,
  };
}
