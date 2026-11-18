import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachEvidence,
  buildChecklist,
  closureBlockers,
  ensureChecklist,
  normalizeAssignee,
  parseEvidenceDataUrl,
  sanitizeFileName,
  setChecklistItem,
  WorkOrderError,
} from './workOrders';
import { SmartWorkOrder } from './types';

function sampleOrder(over: Partial<SmartWorkOrder> = {}): SmartWorkOrder {
  return {
    id: 'OT-2026-001',
    diagnosisId: 'D1',
    anomalyId: 'A1',
    createdAt: '2026-11-18T12:00:00.000Z',
    updatedAt: '2026-11-18T12:00:00.000Z',
    location: 'Troncal',
    nodeId: 'N-TRON-04',
    assetName: 'ACT-PVC-204',
    evidenceSummary: [],
    probableCause: 'Fuga',
    priority: 'Alta',
    requiredResources: [],
    interventionSteps: ['Aislar tramo', 'Reparar brida', 'Prueba de presión'],
    assignee: 'Brigada A',
    status: 'En Progreso',
    ...over,
  };
}

test('buildChecklist creates ordered pending items and skips blanks (REQ-WO-02)', () => {
  const list = buildChecklist(['A', '  ', 'B']);
  assert.deepEqual(
    list.map((c) => [c.id, c.label, c.done]),
    [['CK-1', 'A', false], ['CK-2', 'B', false]]
  );
});

test('ensureChecklist migrates legacy orders without checklist (REQ-WO-02)', () => {
  const migrated = ensureChecklist(sampleOrder());
  assert.equal(migrated.checklist?.length, 3);
});

test('setChecklistItem marks done with actor/time and can be undone (REQ-WO-02)', () => {
  const now = '2026-11-18T13:00:00.000Z';
  const { order, item } = setChecklistItem(sampleOrder(), 'CK-2', true, 'Ana', now);
  assert.equal(item.done, true);
  assert.equal(item.doneBy, 'Ana');
  assert.equal(order.checklist!.filter((c) => c.done).length, 1);
  const undone = setChecklistItem(order, 'CK-2', false, 'Ana', now);
  assert.equal(undone.item.done, false);
  assert.equal(undone.item.doneBy, undefined);
});

test('setChecklistItem rejects unknown item and closed orders (REQ-WO-02)', () => {
  assert.throws(() => setChecklistItem(sampleOrder(), 'CK-99', true, 'x', 'now'), (e: unknown) => e instanceof WorkOrderError && e.status === 404);
  assert.throws(() => setChecklistItem(sampleOrder({ status: 'Cerrada' }), 'CK-1', true, 'x', 'now'), (e: unknown) => e instanceof WorkOrderError && e.status === 409);
});

test('normalizeAssignee validates and trims (REQ-WO-02)', () => {
  assert.equal(normalizeAssignee('  Ana   Pérez '), 'Ana Pérez');
  assert.throws(() => normalizeAssignee('a'));
  assert.throws(() => normalizeAssignee(42));
  assert.throws(() => normalizeAssignee('x'.repeat(81)));
});

test('closureBlockers requires full checklist and photo evidence (REQ-WO-03)', () => {
  const order = sampleOrder();
  assert.equal(closureBlockers(order).length, 2);

  let o = order;
  for (const id of ['CK-1', 'CK-2', 'CK-3']) o = setChecklistItem(o, id, true, 'Ana', 'now').order;
  assert.equal(closureBlockers(o).length, 1);

  o = attachEvidence(
    o,
    { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 3, sha256: 'a'.repeat(64), attachedAt: 'now', attachedBy: 'Ana' },
    'now'
  );
  assert.deepEqual(closureBlockers(o), []);
});

test('parseEvidenceDataUrl accepts small png and rejects bad input (REQ-WO-03)', () => {
  const ok = parseEvidenceDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(ok.mimeType, 'image/png');
  assert.ok(ok.sizeBytes > 0);
  assert.throws(() => parseEvidenceDataUrl('data:text/html;base64,PGI+'), (e: unknown) => e instanceof WorkOrderError);
  assert.throws(() => parseEvidenceDataUrl('data:image/svg+xml;base64,PHN2Zz4='), (e: unknown) => e instanceof WorkOrderError && e.status === 415);
  assert.throws(() => parseEvidenceDataUrl('not a data url'));
  assert.throws(() => parseEvidenceDataUrl(undefined));
});

test('sanitizeFileName strips paths and unsafe chars (REQ-WO-03)', () => {
  assert.equal(sanitizeFileName('..\\..\\evil<script>.jpg'), 'evil_script_.jpg');
  assert.equal(sanitizeFileName(undefined), 'evidencia');
});

