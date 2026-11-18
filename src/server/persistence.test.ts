import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPersistedState, savePersistedState } from './persistence';
import { createBaselineNodes, generateBaselineSeries } from '../core/networkData';
import { appendLedgerEntry } from '../core/cryptoLedger';

test('savePersistedState and loadPersistedState survive simulated restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-persist-'));
  const filePath = path.join(tmpDir, 'state.json');

  try {
    const nodes = createBaselineNodes();
    const seriesByNode = { [nodes[0].id]: generateBaselineSeries(nodes[0], 4) };
    const ledger = await appendLedgerEntry([], {
      action: 'ANOMALY_DETECTED',
      actor: 'Motor Determinista',
      assetId: nodes[0].id,
      evidenceSummary: 'Prueba de persistencia',
      previousState: 'nominal',
      newState: 'critical',
    });

    savePersistedState(
      {
        nodes,
        seriesByNode,
        anomalies: [],
        visionAnalyses: [],
        diagnoses: [],
        workOrders: [
          {
            id: 'OT-2026-001',
            diagnosisId: 'DIAG-1',
            anomalyId: 'ANOM-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            location: 'Bocatoma',
            nodeId: 'N-TOMA-01',
            assetName: 'ACT-TOMA-001',
            evidenceSummary: ['Turbidez 14.8 NTU'],
            probableCause: 'Escorrentía',
            priority: 'Crítica',
            requiredResources: ['Kit DPD'],
            interventionSteps: ['Muestrear'],
            assignee: 'Brigada A',
            status: 'Abierta',
          },
        ],
        ledger,
        syncedOfflineKeys: new Set(['key-1', 'key-2']),
      },
      filePath
    );

    const loaded = loadPersistedState(filePath);
    assert.ok(loaded);
    assert.equal(loaded.nodes.length, 7);
    assert.equal(loaded.ledger.length, 1);
    assert.equal(loaded.workOrders[0].id, 'OT-2026-001');
    assert.deepEqual(loaded.syncedOfflineKeys, ['key-1', 'key-2']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadPersistedState returns null safely on missing or corrupt file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-corrupt-'));
  const missingPath = path.join(tmpDir, 'missing.json');
  const corruptPath = path.join(tmpDir, 'corrupt.json');

  try {
    assert.equal(loadPersistedState(missingPath), null);
    fs.writeFileSync(corruptPath, '{invalid-json', 'utf8');
    assert.equal(loadPersistedState(corruptPath), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

