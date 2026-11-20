import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, describePersistence, restoreEvidence, validateSnapshot, SNAPSHOT_FORMAT } from './snapshot';
import { saveEvidence } from './evidenceStore';
import { appendLedgerEntry } from '../core/cryptoLedger';
import { createBaselineNodes } from '../core/networkData';
import { PersistedServerState } from './persistence';
import { SmartWorkOrder, TrustLedgerEntry } from '../core/types';
import { issueAnchor, loadOrCreateSealKeys, verifyAnchorSignature } from './sealing';

const entry = (action: string, evidenceData: unknown) => ({
  action, actor: 'x', assetId: 'N-TRON-04', evidenceSummary: action, previousState: 'a', newState: 'b', evidenceData,
});

async function sampleState(evidenceDir: string): Promise<PersistedServerState> {
  let ledger: TrustLedgerEntry[] = [];
  ledger = await appendLedgerEntry(ledger, entry('NETWORK_INITIALIZED', { k: 1 }));
  ledger = await appendLedgerEntry(ledger, entry('WORK_ORDER_ISSUED', { workOrderId: 'OT-1', assignee: 'x' }));
  ledger = await appendLedgerEntry(ledger, entry('CLOSURE_EVIDENCE_ATTACHED', { workOrderId: 'OT-1', sha256: saveEvidence(Buffer.from('foto').toString('base64'), 'image/jpeg', evidenceDir).sha256 }));
  const sha = (ledger[2].evidenceData as { sha256: string }).sha256;
  const order = {
    id: 'OT-1', diagnosisId: 'd', anomalyId: 'a', createdAt: 't', updatedAt: 't', location: 'l', nodeId: 'N-TRON-04', assetName: 'a',
    evidenceSummary: [], probableCause: 'c', priority: 'Alta', requiredResources: [], interventionSteps: [], assignee: 'x', status: 'Abierta',
    checklist: [],
    closureEvidence: { fileName: 'f.jpg', mimeType: 'image/jpeg', sizeBytes: 4, sha256: sha, attachedAt: 't', attachedBy: 'x' },
  } as SmartWorkOrder;
  return {
    version: 2, savedAt: 't', nodes: createBaselineNodes(), seriesByNode: {}, anomalies: [], visionAnalyses: [],
    diagnoses: [{ id: 'd', operatorDecision: 'accepted' } as never], workOrders: [order], ledger, syncedOfflineKeys: [],
    sealedDossiers: {}, anchors: [], seenReadingKeys: {},
  };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('un snapshot íntegro se acepta y la evidencia se restaura (REQ-PER-02)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const snap = buildSnapshot(await sampleState(dir), dir);
  assert.equal(snap.format, SNAPSHOT_FORMAT);
  assert.equal(Object.keys(snap.evidence).length, 1);
  const v = await validateSnapshot(clone(snap));
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(restoreEvidence(snap, fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap2-'))), 1);
});

test('REGRESIÓN DE AUDITORÍA: órdenes alteradas con el ledger intacto ya NO se aceptan (REQ-LED-07)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const base = clone(buildSnapshot(await sampleState(dir), dir));

  const assignee = clone(base);
  assignee.state.workOrders[0].assignee = 'Alterado en snapshot';
  const a = await validateSnapshot(assignee);
  assert.equal(a.ok, false);
  if (!a.ok) assert.ok(a.errors.some((e) => e.startsWith('assignee_mismatch')));

  const fakeClosed = clone(base);
  const fake = clone(fakeClosed.state.workOrders[0]);
  fake.id = 'OT-777';
  fake.status = 'Cerrada';
  fakeClosed.state.workOrders.unshift(fake);
  const b = await validateSnapshot(fakeClosed);
  assert.equal(b.ok, false, 'una orden cerrada inexistente en el ledger no puede importarse');

  const photo = clone(base);
  photo.state.workOrders[0].closureEvidence!.sha256 = 'c'.repeat(64);
  assert.equal((await validateSnapshot(photo)).ok, false);
});

test('ledger manipulado o evidencia alterada/ausente se rechazan (REQ-PER-02)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const base = clone(buildSnapshot(await sampleState(dir), dir));
  const l = clone(base);
  l.state.ledger[0].evidenceSummary = 'manipulado';
  assert.equal((await validateSnapshot(l)).ok, false);
  const e = clone(base);
  const sha = Object.keys(e.evidence)[0];
  e.evidence[sha].base64 = Buffer.from('otra cosa').toString('base64');
  const r = await validateSnapshot(e);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((x) => /SHA-256/.test(x)));
  const m = clone(base);
  m.evidence = {};
  assert.equal((await validateSnapshot(m)).ok, false);
});

test('basura y formatos desconocidos se rechazan (REQ-PER-02)', async () => {
  assert.equal((await validateSnapshot(null)).ok, false);
  assert.equal((await validateSnapshot({ format: 'x' })).ok, false);
  assert.equal((await validateSnapshot({ format: SNAPSHOT_FORMAT, state: { nodes: [] } })).ok, false);
});

test('un snapshot que retrocede respecto a un ancla del servidor se rechaza salvo restauración deliberada (REQ-LED-07)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const keys = loadOrCreateSealKeys({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-k-')) });
  const state = await sampleState(dir);
  const newerLedger = await appendLedgerEntry(state.ledger, entry('MAS', {}));
  const anchorNow = issueAnchor(keys, newerLedger);
  const snap = clone(buildSnapshot(state, dir)); // más corto que el ancla actual
  const rejected = await validateSnapshot(snap, { currentAnchors: [anchorNow] });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.ok(rejected.errors.some((e) => /acceptRollback/.test(e)));
  assert.equal((await validateSnapshot(snap, { currentAnchors: [anchorNow], acceptRollback: true })).ok, true);
});

test('anclas con firma inválida o incoherentes dentro del snapshot se rechazan (REQ-LED-07)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const keys = loadOrCreateSealKeys({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-k-')) });
  const state = await sampleState(dir);
  const good = issueAnchor(keys, state.ledger);
  const verify = (a: Parameters<typeof verifyAnchorSignature>[1]) => verifyAnchorSignature(keys.publicKeyPem, a);
  const okSnap = clone(buildSnapshot({ ...state, anchors: [good] }, dir));
  assert.equal((await validateSnapshot(okSnap, { verifyAnchor: verify })).ok, true);
  const forged = clone(okSnap);
  forged.state.anchors![0].payload.height = 2;
  assert.equal((await validateSnapshot(forged, { verifyAnchor: verify })).ok, false);
});

test('describePersistence informa escritura y riesgo efímero con honestidad (REQ-PER-02)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-p-'));
  const info = describePersistence(path.join(dir, 'state.json'));
  assert.equal(info.writable, true);
  assert.equal(info.kind, 'local-file');
  assert.match(info.note, /./);
});
