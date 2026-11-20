import { sha256Canonical } from './canonical';
import { auditOrderAgainstLedger } from './consistency';
import { sha256Hex, verifyLedgerChain } from './cryptoLedger';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NodeBaseline,
  NetworkNode,
  OrderSeal,
  PipeSegment,
  SignedAnchor,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
} from './types';

/**
 * REQ-LED-03: expediente de decisión sellado.
 *
 * Al cerrar una orden se congela UNA copia del contenido completo (anomalía, telemetría, red, diagnóstico, visión,
 * análisis hidráulico, concordancia, orden y evidencia) y se sella su digest en el Trust Ledger. El expediente exportado
 * lleva esa copia congelada, no una recomputación del estado actual, y se verifica contra el ledger.
 *
 * Este módulo cubre INTEGRIDAD (puro, WebCrypto). La AUTENTICIDAD del emisor (firma Ed25519) se verifica en
 * src/server/dossierVerify.ts porque requiere criptografía de clave pública y una clave fijada por el verificador.
 */

export const DOSSIER_FORMAT = 'aqua-sentinel-dossier/2' as const;

export const SEAL_COMPONENT_KEYS = [
  'order',
  'anomaly',
  'telemetry',
  'networkSnapshot',
  'diagnosis',
  'vision',
  'hydraulic',
  'concordance',
  'evidence',
] as const;
export type SealComponentKey = (typeof SEAL_COMPONENT_KEYS)[number];

export interface SealedContent {
  version: 1;
  /** La orden en el instante del cierre, sin los campos que dependen del sello (seal, ledgerHash). */
  order: Omit<SmartWorkOrder, 'seal' | 'ledgerHash'>;
  anomaly: AnomalyEvent | null;
  /** Ventana de telemetría del nodo afectado ANTES de restaurar la línea base al cerrar. */
  telemetry: { nodeId: string; window: TelemetryReading[]; baseline: NodeBaseline } | null;
  networkSnapshot: {
    nodes: Array<Pick<NetworkNode, 'id' | 'kind' | 'status' | 'current' | 'baseline'>>;
    pipes: PipeSegment[];
  };
  diagnosis: AquaBrainDiagnosis | null;
  vision: VisionAnalysisResult | null;
  /** Resultado del diagnóstico hidráulico (HydraulicDiagnosis) tal como se vio al cerrar. */
  hydraulic: unknown | null;
  concordance: unknown | null;
  evidence: { sha256: string; mimeType: string; sizeBytes: number } | null;
}

export interface SealDigests {
  dossierDigest: string;
  componentDigests: Record<SealComponentKey, string>;
}

export async function computeSealDigests(content: SealedContent): Promise<SealDigests> {
  const componentDigests = {} as Record<SealComponentKey, string>;
  for (const key of SEAL_COMPONENT_KEYS) {
    componentDigests[key] = await sha256Canonical({ component: key, value: content[key] ?? null });
  }
  const dossierDigest = await sha256Canonical({ version: content.version, content });
  return { dossierDigest, componentDigests };
}

export interface DecisionDossier {
  format: typeof DOSSIER_FORMAT;
  generatedAt: string;
  /** Metadato derivado del contenido sellado; la verificación lo recalcula y lo compara. */
  syntheticData: boolean;
  sealed: SealedContent;
  seal: OrderSeal;
  /** Ancla firmada de la cabeza del ledger en el momento de exportar. Permite detectar truncamientos posteriores. */
  anchor: SignedAnchor | null;
  /** Clave pública del emisor. Informativa: el verificador debe fijarla por un canal independiente. */
  issuer: { keyId: string; publicKeyPem: string } | null;
  ledger: TrustLedgerEntry[];
  evidencePhoto: { sha256: string; mimeType: string; base64: string } | null;
}

export function deriveSyntheticFlag(content: SealedContent): boolean {
  return content.anomaly ? Boolean(content.anomaly.synthetic) : true;
}

export interface DossierCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Data = Record<string, unknown>;
const dataOf = (e: TrustLedgerEntry | undefined): Data =>
  e && e.evidenceData && typeof e.evidenceData === 'object' ? (e.evidenceData as Data) : {};

/** Verifica la integridad interna del expediente (sin firmas). */
export async function verifyDossierIntegrity(d: DecisionDossier): Promise<DossierCheck[]> {
  const checks: DossierCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

  if (d.format !== DOSSIER_FORMAT || !d.sealed || !d.seal || !Array.isArray(d.ledger)) {
    add('format', 'Formato del expediente', false, 'Formato no reconocido o incompleto (se espera aqua-sentinel-dossier/2 con sealed, seal y ledger).');
    return checks;
  }

  const chain = await verifyLedgerChain(d.ledger);
  add('ledger-chain', 'Cadena SHA-256 del Trust Ledger', chain.valid, chain.valid ? `${chain.checkedCount} bloque(s) íntegros.` : (chain.reason ?? `Roto en #${chain.brokenIndex}`));

  const orderId = d.sealed.order?.id;
  const closedEntry = d.ledger.find((e) => e.action === 'WORK_ORDER_CLOSED' && dataOf(e).workOrderId === orderId);
  add(
    'closure-entry',
    'El cierre de la orden está registrado en el ledger',
    Boolean(closedEntry) && closedEntry!.index === d.seal.closedLedgerIndex && closedEntry!.hash === d.seal.closedLedgerHash,
    closedEntry
      ? closedEntry.index === d.seal.closedLedgerIndex && closedEntry.hash === d.seal.closedLedgerHash
        ? `Bloque #${closedEntry.index} coincide con el sello.`
        : 'El bloque de cierre no coincide con el índice o hash declarados en el sello.'
      : `No hay WORK_ORDER_CLOSED para ${orderId}.`
  );

  const recomputed = await computeSealDigests(d.sealed);
  const ledgerData = dataOf(closedEntry);
  const ledgerDigest = ledgerData.dossierDigest as string | undefined;
  add(
    'seal-digest',
    'El digest del expediente completo coincide con el sellado en el ledger',
    Boolean(ledgerDigest) && ledgerDigest === recomputed.dossierDigest && d.seal.dossierDigest === recomputed.dossierDigest,
    !ledgerDigest
      ? 'El cierre no selló un digest de expediente.'
      : ledgerDigest === recomputed.dossierDigest
        ? `sha256:${recomputed.dossierDigest.slice(0, 16)}…`
        : 'El contenido del expediente fue modificado respecto a lo sellado al cierre.'
  );

  const sealedComponents = (ledgerData.componentDigests ?? {}) as Record<string, string>;
  const modified = SEAL_COMPONENT_KEYS.filter((k) => sealedComponents[k] !== recomputed.componentDigests[k]);
  add(
    'seal-components',
    'Cada componente coincide con su digest sellado',
    modified.length === 0,
    modified.length === 0 ? `${SEAL_COMPONENT_KEYS.length} componentes íntegros.` : `Componentes alterados u omitidos: ${modified.join(', ')}.`
  );

  const ledgerIssues = auditOrderAgainstLedger({ ...d.sealed.order, seal: d.seal } as SmartWorkOrder, d.ledger).filter((i) => i.severity === 'error');
  add(
    'order-consistency',
    'La orden es coherente con la historia del ledger (responsable, checklist, foto)',
    ledgerIssues.length === 0,
    ledgerIssues.length === 0 ? 'Coherente.' : ledgerIssues.map((i) => i.message).join(' ')
  );

  if (d.sealed.evidence) {
    const attached = d.ledger.filter((e) => e.action === 'CLOSURE_EVIDENCE_ATTACHED' && dataOf(e).workOrderId === orderId);
    const sealedByLedger = attached.length ? (dataOf(attached[attached.length - 1]).sha256 as string) : undefined;
    let actual = '';
    if (d.evidencePhoto) {
      try {
        actual = await sha256OfBytes(base64ToBytes(d.evidencePhoto.base64));
      } catch {
        actual = 'base64-inválido';
      }
    }
    add(
      'evidence-photo',
      'La foto de cierre coincide byte a byte con el hash sellado',
      actual === d.sealed.evidence.sha256 && sealedByLedger === d.sealed.evidence.sha256,
      !d.evidencePhoto
        ? 'El expediente no incluye la foto; solo se puede comprobar su hash.'
        : actual === d.sealed.evidence.sha256
          ? 'Coincide.'
          : `Hash recalculado ${actual.slice(0, 16)}… distinto del sellado.`
    );
  }

  add(
    'metadata',
    'Los metadatos (datos sintéticos) coinciden con el contenido sellado',
    d.syntheticData === deriveSyntheticFlag(d.sealed),
    d.syntheticData === deriveSyntheticFlag(d.sealed) ? 'Coinciden.' : 'El indicador syntheticData no corresponde al contenido sellado.'
  );
  return checks;
}

export { sha256Hex };
