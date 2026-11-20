import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  SmartWorkOrder,
  TrustLedgerEntry,
} from './types';

/**
 * REQ-LED-06: consistencia entre órdenes, diagnósticos y ledger.
 * El ledger puede ser íntegro y aun así contar una historia distinta de la que muestra la orden
 * (la auditoría reprodujo 4 entradas CHECKLIST_ITEM_COMPLETED frente a 2/4 casillas marcadas).
 */

export interface ConsistencyIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  ref?: string;
}

type Data = Record<string, unknown>;
const dataOf = (e: TrustLedgerEntry): Data =>
  e.evidenceData && typeof e.evidenceData === 'object' ? (e.evidenceData as Data) : {};

function entriesFor(ledger: TrustLedgerEntry[], orderId: string): TrustLedgerEntry[] {
  return ledger.filter((e) => dataOf(e).workOrderId === orderId);
}

export function auditOrderAgainstLedger(order: SmartWorkOrder, ledger: TrustLedgerEntry[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, severity: 'error', message, ref: order.id });
  const warn = (code: string, message: string) => issues.push({ code, severity: 'warning', message, ref: order.id });
  const events = entriesFor(ledger, order.id);

  const issued = events.find((e) => e.action === 'WORK_ORDER_ISSUED');
  if (!issued) err('order_not_issued', `${order.id}: no existe WORK_ORDER_ISSUED en el ledger.`);

  // Responsable: último WORK_ORDER_ASSIGNED, o el asignado al emitir.
  const assignments = events.filter((e) => e.action === 'WORK_ORDER_ASSIGNED');
  const expectedAssignee =
    assignments.length > 0
      ? (dataOf(assignments[assignments.length - 1]).to as string | undefined)
      : (dataOf(issued ?? ({} as TrustLedgerEntry)).assignee as string | undefined);
  if (expectedAssignee === undefined) {
    warn('assignee_unverifiable', `${order.id}: el ledger no registra el responsable inicial (orden anterior a REQ-LED-06).`);
  } else if (expectedAssignee !== order.assignee) {
    err('assignee_mismatch', `${order.id}: la orden dice "${order.assignee}" pero el ledger registra "${expectedAssignee}".`);
  }

  // Checklist: el estado neto de cada ítem según el ledger debe coincidir con la orden.
  const netState = new Map<string, boolean>();
  for (const e of events) {
    if (e.action === 'CHECKLIST_ITEM_COMPLETED' || e.action === 'CHECKLIST_ITEM_REOPENED') {
      netState.set(String(dataOf(e).itemId), e.action === 'CHECKLIST_ITEM_COMPLETED');
    }
  }
  for (const item of order.checklist ?? []) {
    const ledgerSays = netState.get(item.id) ?? false;
    if (ledgerSays !== item.done) {
      err(
        'checklist_mismatch',
        `${order.id}/${item.id}: la orden dice ${item.done ? 'completado' : 'pendiente'} y el ledger ${ledgerSays ? 'completado' : 'pendiente'}.`
      );
    }
  }
  for (const id of netState.keys()) {
    if (!(order.checklist ?? []).some((c) => c.id === id)) {
      err('checklist_unknown_item', `${order.id}: el ledger menciona el ítem ${id}, que no existe en la orden.`);
    }
  }

  // Evidencia fotográfica.
  const attached = events.filter((e) => e.action === 'CLOSURE_EVIDENCE_ATTACHED');
  const lastSha = attached.length ? (dataOf(attached[attached.length - 1]).sha256 as string) : undefined;
  if ((order.closureEvidence?.sha256 ?? undefined) !== lastSha) {
    err(
      'evidence_mismatch',
      `${order.id}: la foto de la orden (${order.closureEvidence?.sha256?.slice(0, 12) ?? 'ninguna'}) no coincide con el último sello del ledger (${lastSha?.slice(0, 12) ?? 'ninguno'}).`
    );
  }

  // Cierre.
  const closedEntries = events.filter((e) => e.action === 'WORK_ORDER_CLOSED');
  if (order.status === 'Cerrada') {
    if (closedEntries.length !== 1) err('closure_entries', `${order.id}: está cerrada y el ledger tiene ${closedEntries.length} entradas de cierre.`);
    if ((order.checklist ?? []).some((c) => !c.done)) err('closed_with_pending', `${order.id}: cerrada con pasos del checklist pendientes.`);
    if (!order.closureEvidence) err('closed_without_photo', `${order.id}: cerrada sin foto de cierre.`);
    if (!order.seal) {
      warn('closed_unsealed', `${order.id}: cerrada sin sello de expediente completo (cierre anterior a REQ-LED-03).`);
    } else {
      const closed = closedEntries[0];
      const data = closed ? dataOf(closed) : {};
      if (closed && data.dossierDigest !== order.seal.dossierDigest) {
        err('seal_digest_mismatch', `${order.id}: el digest del sello no coincide con el del ledger.`);
      }
      if (closed && closed.index !== order.seal.closedLedgerIndex) {
        err('seal_index_mismatch', `${order.id}: el índice de cierre del sello no coincide con el ledger.`);
      }
    }
  } else if (closedEntries.length > 0) {
    err('closure_without_status', `${order.id}: el ledger registra un cierre pero la orden está "${order.status}".`);
  }
  return issues;
}

export interface ConsistencyInput {
  workOrders: SmartWorkOrder[];
  diagnoses: AquaBrainDiagnosis[];
  anomalies: AnomalyEvent[];
  ledger: TrustLedgerEntry[];
}

export function auditStateConsistency(state: ConsistencyInput): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  state.ledger.forEach((e, i) => {
    if (e.index !== i) {
      issues.push({ code: 'ledger_index', severity: 'error', message: `El bloque en posición ${i} declara índice ${e.index}.`, ref: e.id });
    }
    if (e.id !== `LED-${String(i + 1).padStart(4, '0')}`) {
      issues.push({ code: 'ledger_id', severity: 'error', message: `El bloque en posición ${i} tiene id inesperado ${e.id}.`, ref: e.id });
    }
  });

  for (const order of state.workOrders) {
    issues.push(...auditOrderAgainstLedger(order, state.ledger));
    if (!state.diagnoses.some((d) => d.id === order.diagnosisId)) {
      issues.push({ code: 'order_orphan_diagnosis', severity: 'warning', message: `${order.id}: referencia el diagnóstico ${order.diagnosisId}, que ya no existe.`, ref: order.id });
    }
    const anomaly = state.anomalies.find((a) => a.id === order.anomalyId);
    if (order.status === 'Cerrada' && anomaly && anomaly.status !== 'resolved') {
      issues.push({ code: 'closed_order_active_anomaly', severity: 'error', message: `${order.id}: cerrada pero su anomalía sigue activa.`, ref: order.id });
    }
  }

  for (const d of state.diagnoses) {
    const hasOrder = state.workOrders.some((o) => o.diagnosisId === d.id);
    if ((d.operatorDecision === 'accepted' || d.operatorDecision === 'modified') && !hasOrder) {
      issues.push({ code: 'accepted_without_order', severity: 'error', message: `${d.id}: aceptado sin orden de trabajo.`, ref: d.id });
    }
    if (d.operatorDecision === 'rejected' && hasOrder) {
      issues.push({ code: 'rejected_with_order', severity: 'error', message: `${d.id}: rechazado pero tiene una orden.`, ref: d.id });
    }
    if (d.operatorDecision === 'rejected' && !state.ledger.some((e) => e.action === 'DIAGNOSIS_REJECTED' && dataOf(e).diagnosisId === d.id)) {
      issues.push({ code: 'rejection_unrecorded', severity: 'error', message: `${d.id}: rechazo sin entrada DIAGNOSIS_REJECTED.`, ref: d.id });
    }
  }
  return issues;
}
