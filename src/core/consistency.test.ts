import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLedgerEntry } from './cryptoLedger';
import { auditOrderAgainstLedger, auditStateConsistency } from './consistency';
import { SmartWorkOrder, TrustLedgerEntry } from './types';

const entry = (action: string, evidenceData: unknown) => ({
  action,
  actor: 'x',
  assetId: 'N-TRON-04',
  evidenceSummary: action,
  previousState: 'a',
  newState: 'b',
  evidenceData,
});

function order(over: Partial<SmartWorkOrder> = {}): SmartWorkOrder {
  return {
    id: 'OT-1', diagnosisId: 'D1', anomalyId: 'A1', createdAt: 't', updatedAt: 't', location: 'l', nodeId: 'N-TRON-04', assetName: 'a',
    evidenceSummary: [], probableCause: 'c', priority: 'Alta', requiredResources: [], interventionSteps: [], assignee: 'Ana', status: 'En Progreso',
    checklist: ['CK-1', 'CK-2', 'CK-3', 'CK-4'].map((id) => ({ id, label: id, done: false })),
    ...over,
  };
}

async function ledgerWith(items: Array<[string, unknown]>): Promise<TrustLedgerEntry[]> {
  let l: TrustLedgerEntry[] = [];
  for (const [a, d] of items) l = await appendLedgerEntry(l, entry(a, d));
  return l;
}

test('REGRESIÓN DE AUDITORÍA: 4 entradas en el ledger pero 2/4 casillas en la orden se reporta como error (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([
    ['WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'Ana' }],
    ...['CK-1', 'CK-2', 'CK-3', 'CK-4'].map((id) => ['CHECKLIST_ITEM_COMPLETED', { workOrderId: 'OT-1', itemId: id, done: true }] as [string, unknown]),
  ]);
  const o = order({ checklist: ['CK-1', 'CK-2', 'CK-3', 'CK-4'].map((id, i) => ({ id, label: id, done: i < 2 })) });
  const issues = auditOrderAgainstLedger(o, ledger);
  assert.equal(issues.filter((i) => i.code === 'checklist_mismatch').length, 2);
});

test('orden y ledger coherentes: sin errores (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([
    ['WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'Ana' }],
    ['CHECKLIST_ITEM_COMPLETED', { workOrderId: 'OT-1', itemId: 'CK-1', done: true }],
    ['CHECKLIST_ITEM_REOPENED', { workOrderId: 'OT-1', itemId: 'CK-1', done: false }],
    ['WORK_ORDER_ASSIGNED', { workOrderId: 'OT-1', from: 'Ana', to: 'Luis' }],
  ]);
  assert.deepEqual(auditOrderAgainstLedger(order({ assignee: 'Luis' }), ledger).filter((i) => i.severity === 'error'), []);
});

test('responsable distinto del último asignado en el ledger es error (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([
    ['WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'Ana' }],
    ['WORK_ORDER_ASSIGNED', { workOrderId: 'OT-1', from: 'Ana', to: 'Luis' }],
  ]);
  assert.ok(auditOrderAgainstLedger(order({ assignee: 'Ana' }), ledger).some((i) => i.code === 'assignee_mismatch'));
});

test('foto de la orden distinta del último sello del ledger es error (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([
    ['WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'Ana' }],
    ['CLOSURE_EVIDENCE_ATTACHED', { workOrderId: 'OT-1', sha256: 'a'.repeat(64) }],
  ]);
  const o = order({ closureEvidence: { fileName: 'f', mimeType: 'image/png', sizeBytes: 1, sha256: 'b'.repeat(64), attachedAt: 't', attachedBy: 'Ana' } });
  assert.ok(auditOrderAgainstLedger(o, ledger).some((i) => i.code === 'evidence_mismatch'));
});

test('orden cerrada con pasos pendientes, sin foto o sin cierre en el ledger es error (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([['WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'Ana' }]]);
  const codes = auditOrderAgainstLedger(order({ status: 'Cerrada' }), ledger).map((i) => i.code);
  assert.ok(codes.includes('closure_entries'));
  assert.ok(codes.includes('closed_with_pending'));
  assert.ok(codes.includes('closed_without_photo'));
});

test('estado completo: huérfanos, aceptado sin orden, índices del ledger alterados (REQ-LED-06)', async () => {
  const ledger = await ledgerWith([['A', {}], ['B', {}]]);
  const tampered = structuredClone(ledger);
  tampered[1].index = 7;
  const issues = auditStateConsistency({
    workOrders: [],
    diagnoses: [{ id: 'D9', operatorDecision: 'accepted' } as never, { id: 'D8', operatorDecision: 'rejected' } as never],
    anomalies: [],
    ledger: tampered,
  });
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('ledger_index'));
  assert.ok(codes.includes('accepted_without_order'));
  assert.ok(codes.includes('rejection_unrecorded'));
});
