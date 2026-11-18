import { sha256Hex, verifyLedgerChain } from './cryptoLedger';
import { ConcordanceReport } from './evidenceConcordance';
import { LeakForensicsReport } from './leakForensics';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  ChainVerificationResult,
  SmartWorkOrder,
  TrustLedgerEntry,
  VisionAnalysisResult,
} from './types';

/**
 * REQ-LED-02: Expediente de decisión verificable y portable.
 * Un solo JSON que contiene la decisión completa (anomalía → diagnóstico → orden → evidencia) y la cadena
 * del Trust Ledger. Cualquiera puede verificarlo sin acceso al servidor (npm run verify:dossier <archivo>).
 * No es una firma digital: demuestra integridad interna (alteraciones detectables), no autoría.
 */

export interface DecisionDossier {
  format: 'aqua-sentinel-dossier/1';
  generatedAt: string;
  /** true si los datos de sensores provienen de escenarios sintéticos de demostración. */
  syntheticData: boolean;
  order: SmartWorkOrder;
  anomaly: AnomalyEvent | null;
  diagnosis: AquaBrainDiagnosis | null;
  vision: VisionAnalysisResult | null;
  forensics: LeakForensicsReport | null;
  concordance: ConcordanceReport | null;
  ledger: TrustLedgerEntry[];
  evidencePhoto: { sha256: string; mimeType: string; base64: string } | null;
}

export interface DossierCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DossierVerification {
  valid: boolean;
  checks: DossierCheck[];
  chain: ChainVerificationResult;
}

/** Huella de los campos operativos de la orden que el cierre sella en el ledger. */
export async function orderDigest(order: SmartWorkOrder): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      id: order.id,
      assignee: order.assignee,
      status: order.status,
      checklist: (order.checklist ?? []).map((c) => ({ id: c.id, done: c.done, doneBy: c.doneBy ?? null })),
      closureNotes: order.closureNotes ?? null,
      evidenceSha256: order.closureEvidence?.sha256 ?? null,
    })
  );
}

export function buildDossier(input: Omit<DecisionDossier, 'format' | 'generatedAt' | 'syntheticData'> & { generatedAt?: string }): DecisionDossier {
  return {
    format: 'aqua-sentinel-dossier/1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    syntheticData: Boolean(input.anomaly?.synthetic ?? true),
    order: input.order,
    anomaly: input.anomaly,
    diagnosis: input.diagnosis,
    vision: input.vision,
    forensics: input.forensics,
    concordance: input.concordance,
    ledger: input.ledger,
    evidencePhoto: input.evidencePhoto,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyDossier(d: DecisionDossier): Promise<DossierVerification> {
  const checks: DossierCheck[] = [];
  const chain = await verifyLedgerChain(d.ledger ?? []);
  checks.push({
    id: 'ledger-chain',
    label: 'Cadena SHA-256 del Trust Ledger',
    ok: chain.valid,
    detail: chain.valid ? `${chain.checkedCount} bloque(s) íntegros.` : chain.reason ?? `Roto en #${chain.brokenIndex}`,
  });

  const orderEntries = (d.ledger ?? []).filter(
    (e) => (e.evidenceData as { workOrderId?: string } | undefined)?.workOrderId === d.order.id
  );
  checks.push({
    id: 'order-in-ledger',
    label: 'La orden de trabajo está registrada en el ledger',
    ok: orderEntries.some((e) => e.action === 'WORK_ORDER_ISSUED'),
    detail: `${orderEntries.length} entrada(s) del ledger referencian ${d.order.id}.`,
  });

  if (d.order.closureEvidence) {
    const attached = orderEntries.find((e) => e.action === 'CLOSURE_EVIDENCE_ATTACHED');
    const committed = (attached?.evidenceData as { sha256?: string } | undefined)?.sha256;
    checks.push({
      id: 'evidence-committed',
      label: 'El hash de la foto de cierre fue sellado en el ledger',
      ok: Boolean(committed) && committed === d.order.closureEvidence.sha256,
      detail: committed ? `sha256 sellado: ${committed.slice(0, 16)}…` : 'No hay entrada CLOSURE_EVIDENCE_ATTACHED.',
    });

    if (d.evidencePhoto) {
      let actual = '';
      try {
        actual = await sha256Bytes(base64ToBytes(d.evidencePhoto.base64));
      } catch {
        actual = 'base64-inválido';
      }
      checks.push({
        id: 'evidence-bytes',
        label: 'Los bytes de la foto coinciden con el hash sellado',
        ok: actual === d.order.closureEvidence.sha256,
        detail: actual === d.order.closureEvidence.sha256 ? 'Coincide byte a byte.' : `Hash recalculado ${actual.slice(0, 16)}… ≠ sellado.`,
      });
    } else {
      checks.push({
        id: 'evidence-bytes',
        label: 'Los bytes de la foto coinciden con el hash sellado',
        ok: false,
        detail: 'El expediente no incluye la foto; solo se puede comprobar el hash sellado.',
      });
    }
  }

  if (d.order.status === 'Cerrada') {
    const closed = orderEntries.find((e) => e.action === 'WORK_ORDER_CLOSED');
    const sealedDigest = (closed?.evidenceData as { orderDigest?: string } | undefined)?.orderDigest;
    const actualDigest = await orderDigest(d.order);
    checks.push({
      id: 'order-digest',
      label: 'Responsable, checklist y notas de la orden coinciden con lo sellado al cierre',
      ok: Boolean(sealedDigest) && sealedDigest === actualDigest,
      detail: sealedDigest ? (sealedDigest === actualDigest ? 'Huella idéntica.' : 'La orden fue modificada tras el cierre.') : 'El cierre no selló una huella de la orden.',
    });
  }

  const sealed = d.order.ledgerHash;
  if (sealed) {
    checks.push({
      id: 'order-hash-anchor',
      label: 'El hash de anclaje de la orden existe en la cadena',
      ok: (d.ledger ?? []).some((e) => e.hash === sealed),
      detail: `ledgerHash ${sealed.slice(0, 16)}…`,
    });
  }

  // Huella del contenido del expediente (para comparar copias).
  const valid = checks.every((c) => c.ok);
  return { valid, checks, chain };
}

export async function dossierFingerprint(d: DecisionDossier): Promise<string> {
  return sha256Hex(JSON.stringify({ order: d.order, anomaly: d.anomaly, diagnosis: d.diagnosis, head: d.ledger[d.ledger.length - 1]?.hash }));
}


