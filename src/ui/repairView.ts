import { assessRepair, DEFAULT_REPAIR_POLICY, RepairAssessmentSummary, RepairCode, RepairEvidenceData, RepairOutcome, repairOutcomeFromLedger } from '../core/repairVerification';
import { NetworkNode, SmartWorkOrder, TelemetryReading, TrustLedgerEntry } from '../core/types';
import { tr } from './engineText';
import { plural, t } from './i18n';

/**
 * REQ-REP-05: lo que la interfaz dice sobre si una orden cerrada realmente arregló el problema.
 *
 * Orden de autoridad: 1) el veredicto sellado en el Trust Ledger (verificable); 2) el veredicto provisional que el servidor guarda
 * en el punto mientras reúne mediciones; 3) el cálculo local con las mismas reglas (core/repairVerification). La interfaz nunca
 * inventa un resultado: sin veredicto sellado, la reparación no se presenta como lograda.
 */
export interface RepairView {
  outcome: RepairOutcome;
  /** Causa estructurada del resultado; la explicación en el idioma activo sale de explainRepair(). */
  code?: RepairCode;
  measuredAfter: number;
  required: number;
  anomalousInRow: number;
  reasons: string[];
  synthetic: boolean;
  closedAt: string;
  /** El veredicto está sellado en el ledger (solo VERIFIED y REOPENED lo están). */
  sealed: boolean;
  /** Bloque del ledger que contiene el veredicto. */
  block?: number;
}

type Explainable = Pick<RepairAssessmentSummary, 'outcome' | 'measuredAfter' | 'required' | 'anomalousInRow' | 'synthetic' | 'reasons'> & { code?: RepairCode };

/** Explicación en una frase, en el idioma activo, construida con las cifras del motor. Si el registro no trae código, se usa su texto. */
export function explainRepair(a: Explainable): string {
  const have = a.measuredAfter;
  const sim = a.synthetic && have > 0;
  switch (a.code) {
    case 'no_measurements':
      return t('Todavía no hay mediciones posteriores al cierre.', 'There are no measurements after the closing yet.');
    case 'only_unusable':
      return t('Las mediciones que llegaron indican un sensor defectuoso: no sirven como evidencia.', 'The measurements received point to a faulty sensor, so they cannot be used as evidence.');
    case 'hydraulic_leak':
      return t('El balance de agua sigue mostrando una fuga después del cierre.', 'The water balance still shows a leak after the closing.');
    case 'anomalous_streak':
      return t(`${a.anomalousInRow} mediciones seguidas posteriores al cierre siguen fuera de lo normal.`, `${a.anomalousInRow} consecutive measurements after the closing are still out of range.`);
    case 'hydraulic_excess':
      return t('Las mediciones del punto son normales, pero el balance de agua aún muestra un exceso de caudal. No se puede confirmar.', 'The point’s own measurements are normal, but the water balance still shows excess flow. It cannot be confirmed yet.');
    case 'not_enough':
      return t(
        `Hay ${have} ${plural(have, ['medición normal', 'mediciones normales'], ['normal measurement', 'normal measurements'])} y se necesitan ${a.required} seguidas.`,
        `${have} ${plural(have, ['medición normal', 'mediciones normales'], ['normal measurement', 'normal measurements'])} so far; ${a.required} in a row are needed.`
      );
    case 'verified':
      return t(
        `${have} mediciones seguidas posteriores al cierre dentro de lo normal${sim ? ' (datos simulados)' : ''}, y el balance de agua ya no muestra la fuga.`,
        `${have} consecutive measurements after the closing within range${sim ? ' (simulated data)' : ''}, and the water balance no longer shows the leak.`
      );
    default:
      return a.reasons.map((r) => tr(r)).join(' ');
  }
}

export function repairView(
  order: Pick<SmartWorkOrder, 'id' | 'status' | 'updatedAt' | 'seal'>,
  node: Pick<NetworkNode, 'id' | 'name' | 'sector' | 'populationServed' | 'baseline' | 'pendingVerification'> | undefined,
  series: TelemetryReading[] | undefined,
  ledger: TrustLedgerEntry[] = []
): RepairView | null {
  if (order.status !== 'Cerrada') return null;
  const closedAt = order.seal?.sealedAt ?? order.updatedAt;
  const sealed = repairOutcomeFromLedger(ledger, order.id);
  if (sealed) {
    const a = (sealed.entry.evidenceData as RepairEvidenceData).assessment;
    return { outcome: sealed.outcome, code: a.code, measuredAfter: a.measuredAfter, required: a.required, anomalousInRow: a.anomalousInRow, reasons: a.reasons, synthetic: a.synthetic, closedAt, sealed: true, block: sealed.entry.index };
  }
  const provisional = node?.pendingVerification?.workOrderId === order.id ? node.pendingVerification.assessment : undefined;
  if (provisional) return { ...provisional, closedAt, sealed: false };
  if (node) {
    const a = assessRepair({ node, closedAt, series: series ?? [] });
    return { outcome: a.outcome, code: a.code, measuredAfter: a.measuredAfter, required: a.required, anomalousInRow: a.anomalousInRow, reasons: a.reasons, synthetic: a.synthetic, closedAt, sealed: false };
  }
  const after = (series ?? []).filter((e) => Date.parse(e.timestamp) > Date.parse(closedAt));
  return {
    outcome: after.length === 0 ? 'PENDING' : 'INCONCLUSIVE',
    code: after.length === 0 ? 'no_measurements' : 'not_enough',
    measuredAfter: after.length,
    required: DEFAULT_REPAIR_POLICY.minReadings,
    anomalousInRow: 0,
    reasons: after.length === 0 ? ['Aún no hay mediciones posteriores al cierre de la orden.'] : [`Se necesitan ${DEFAULT_REPAIR_POLICY.minReadings} mediciones consecutivas dentro de lo normal.`],
    synthetic: after.every((e) => e.synthetic),
    closedAt,
    sealed: false,
  };
}

/** Etiqueta corta de cada resultado (listas y chips). */
export const repairPill = (o: RepairOutcome): { tone: 'ok' | 'critical' | 'verifying'; label: string } => {
  switch (o) {
    case 'VERIFIED':
      return { tone: 'ok', label: t('Reparación verificada', 'Repair verified') };
    case 'REOPENED':
      return { tone: 'critical', label: t('Reabierta', 'Reopened') };
    case 'INCONCLUSIVE':
      return { tone: 'verifying', label: t('En verificación', 'Being verified') };
    default:
      return { tone: 'verifying', label: t('Por verificar', 'To be verified') };
  }
};
