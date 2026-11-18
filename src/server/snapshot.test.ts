import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, describePersistence, restoreEvidence, validateSnapshot } from './snapshot';
import { saveEvidence } from './evidenceStore';
import { appendLedgerEntry } from '../core/cryptoLedger';
import { createBaselineNodes } from '../core/networkData';
import { PersistedServerState } from './persistence';
import { SmartWorkOrder, TrustLedgerEntry } from '../core/types';

async function sampleState(evidenceDir: string): Promise<PersistedServerState> {
  let ledger: TrustLedgerEntry[] = [];
  ledger = await appendLedgerEntry(ledger, { action: 'A', actor: 'x', assetId: 'n', evidenceSummary: 's', previousState: 'a', newState: 'b', evidenceData: { k: 1 } });
  const saved = saveEvidence(Buffer.from('foto').toString('base64'), 'image/jpeg', evidenceDir);
  const order = {
    id: 'OT-1', diagnosisId: 'd', anomalyId: 'a', createdAt: 't', updatedAt: 't', location: 'l', nodeId: 'N-TRON-04', assetName: 'a',
    evidenceSummary: [], probableCause: 'c', priority: 'Alta', requiredResources: [], interventionSteps: [], assignee: 'x', status: 'Abierta',
    closureEvidence: { fileName: 'f.jpg', mimeType: 'image/jpeg', sizeBytes: 4, sha256: saved.sha256, attachedAt: 't', attachedBy: 'x' },
  } as SmartWorkOrder;
  return {
    version: 1, savedAt: 't', nodes: createBaselineNodes(), seriesByNode: {}, anomalies: [], visionAnalyses: [], diagnoses: [],
    workOrders: [order], ledger, syncedOfflineKeys: [],
  };
}

test('snapshot round-trips with evidence and verified ledger (REQ-PER-02)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const snap = buildSnapshot(await sampleState(dir), dir);
  assert.equal(Object.keys(snap.evidence).length, 1);
  const v = await validateSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(v.ok, true);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap2-'));
  assert.equal(restoreEvidence(snap, dir2), 1);
});

test('snapshot with tampered ledger or evidence is rejected (REQ-PER-02)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const snap = JSON.parse(JSON.stringify(buildSnapshot(await sampleState(dir), dir)));
  snap.state.ledger[0].evidenceSummary = 'manipulado';
  const a = await validateSnapshot(snap);
  assert.equal(a.ok, false);

  const snap2 = JSON.parse(JSON.stringify(buildSnapshot(await sampleState(dir), dir)));
  const sha = Object.keys(snap2.evidence)[0];
  snap2.evidence[sha].base64 = Buffer.from('otra cosa').toString('base64');
  const b = await validateSnapshot(snap2);
  assert.equal(b.ok, false);
  if (!b.ok) assert.ok(b.errors.some((e) => /SHA-256/.test(e)));
});

test('snapshot rejects garbage and missing evidence (REQ-PER-02)', async () => {
  assert.equal((await validateSnapshot(null)).ok, false);
  assert.equal((await validateSnapshot({ format: 'x' })).ok, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-snap-'));
  const snap = JSON.parse(JSON.stringify(buildSnapshot(await sampleState(dir), dir)));
  snap.evidence = {};
  const r = await validateSnapshot(snap);
  assert.equal(r.ok, false);
});

test('describePersistence reports writable dir and honest risk (REQ-PER-02)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-p-'));
  const info = describePersistence(path.join(dir, 'state.json'));
  assert.equal(info.writable, true);
  assert.equal(info.kind, 'local-file');
  assert.match(info.note, /./);
});

