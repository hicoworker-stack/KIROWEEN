import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLedgerEntry, canonicalLedgerPayload, GENESIS_HASH, sha256Hex } from '../core/cryptoLedger';
import { DecisionDossier, SealedContent } from '../core/dossier';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import { AnomalyEvent, TrustLedgerEntry } from '../core/types';
import { verifyDossierFull } from './dossierVerify';
import { exportDossier, finalizeSeal, prepareSeal } from './dossierService';
import { loadOrCreateSealKeys, SealKeys } from './sealing';

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface Fixture {
  dossier: DecisionDossier;
  keys: SealKeys;
  keysDir: string;
}

/** Construye un expediente real: ledger encadenado + sello + recibo y ancla firmados, con 2 entradas posteriores al cierre. */
async function buildFixture(): Promise<Fixture> {
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-seal-'));
  const keys = loadOrCreateSealKeys({ dir: keysDir });
  const nodes = createBaselineNodes();
  const node = nodes.find((n) => n.id === 'N-TRON-04')!;
  const photo = Buffer.from(PNG_A, 'base64');
  const sha = crypto.createHash('sha256').update(photo).digest('hex');
  const orderId = 'OT-2026-001';
  const append = (action: string, evidenceData: unknown, summary = action) => ({
    action,
    actor: 'test',
    assetId: node.id,
    evidenceSummary: summary,
    previousState: 'a',
    newState: 'b',
    evidenceData,
  });

  let ledger: TrustLedgerEntry[] = [];
  ledger = await appendLedgerEntry(ledger, append('NETWORK_INITIALIZED', { synthetic: true }));
  ledger = await appendLedgerEntry(ledger, append('ANOMALY_DETECTED', { anomalyId: 'ANOM-1' }));
  ledger = await appendLedgerEntry(ledger, append('WORK_ORDER_ISSUED', { workOrderId: orderId, assignee: 'Cuadrilla Norte', decision: 'accepted' }));
  ledger = await appendLedgerEntry(ledger, append('WORK_ORDER_ASSIGNED', { workOrderId: orderId, from: 'Cuadrilla Norte', to: 'Ing. Marta Rojas' }));
  const checklist = ['Aislar tramo', 'Reparar brida'].map((label, i) => ({ id: `CK-${i + 1}`, label, done: true, doneBy: 'Ing. Marta Rojas', doneAt: '2026-11-19T12:30:00.000Z' }));
  for (const c of checklist) {
    ledger = await appendLedgerEntry(ledger, append('CHECKLIST_ITEM_COMPLETED', { workOrderId: orderId, itemId: c.id, label: c.label, done: true }));
  }
  ledger = await appendLedgerEntry(ledger, append('CLOSURE_EVIDENCE_ATTACHED', { workOrderId: orderId, sha256: sha, mimeType: 'image/png', sizeBytes: photo.length }));

  const anomaly = {
    id: 'ANOM-1', timestamp: '2026-11-19T12:00:00.000Z', nodeId: node.id, nodeName: node.name, sector: node.sector,
    category: 'leak', title: 'Posible fuga', status: 'resolved', rulesTriggered: [], priority: { totalScore: 70, priority: 'Alta' },
    telemetrySnapshot: node.current, baselineSnapshot: node.baseline, synthetic: true,
  } as unknown as AnomalyEvent;
  const sealed: SealedContent = {
    version: 1,
    order: {
      id: orderId, diagnosisId: 'DIAG-1', anomalyId: 'ANOM-1', createdAt: '2026-11-19T12:10:00.000Z', updatedAt: '2026-11-19T13:00:00.000Z',
      location: 'Troncal', nodeId: node.id, assetName: 'ACT-PVC-204', evidenceSummary: ['e'], probableCause: 'Fuga en brida', priority: 'Alta',
      requiredResources: ['Cuadrilla'], interventionSteps: ['Aislar tramo', 'Reparar brida'], assignee: 'Ing. Marta Rojas', status: 'Cerrada',
      closureNotes: 'Brida reemplazada', closureEvidenceLabel: 'cierre.png', checklist,
      closureEvidence: { fileName: 'cierre.png', mimeType: 'image/png', sizeBytes: photo.length, sha256: sha, attachedAt: '2026-11-19T12:40:00.000Z', attachedBy: 'Ing. Marta Rojas' },
    },
    anomaly,
    telemetry: { nodeId: node.id, window: [node.current], baseline: node.baseline },
    networkSnapshot: { nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, status: n.status, current: n.current, baseline: n.baseline })), pipes: NETWORK_PIPES },
    diagnosis: { id: 'DIAG-1', primaryHypothesis: 'Rotura de brida', operatorDecision: 'accepted', evidenceLevel: 'media' } as never,
    vision: null,
    hydraulic: { level: 'localized_leak', estimatedLossLs: 6.6 },
    concordance: { level: 'media' },
    evidence: { sha256: sha, mimeType: 'image/png', sizeBytes: photo.length },
  };
  const digests = await prepareSeal(sealed);
  ledger = await appendLedgerEntry(ledger, append('WORK_ORDER_CLOSED', { workOrderId: orderId, closureNotes: 'Brida reemplazada', dossierDigest: digests.dossierDigest, componentDigests: digests.componentDigests, sealVersion: 1 }));
  const seal = finalizeSeal(keys, orderId, digests, ledger[ledger.length - 1]);
  // Historia posterior al cierre (otra anomalía): es lo que un atacante intentaría truncar.
  ledger = await appendLedgerEntry(ledger, append('ANOMALY_DETECTED', { anomalyId: 'ANOM-2' }));
  ledger = await appendLedgerEntry(ledger, append('DIAGNOSIS_GENERATED', { diagnosisId: 'DIAG-2' }));
  const dossier = exportDossier({ keys, sealed, seal, ledger, evidencePhoto: { sha256: sha, mimeType: 'image/png', base64: PNG_A } });
  return { dossier, keys, keysDir };
}

const clone = <T>(x: T): T => structuredClone(x);

test('expediente genuino con clave fijada: verified (REQ-LED-05)', async () => {
  const { dossier, keys } = await buildFixture();
  const v = await verifyDossierFull(dossier, { trustedPublicKeyPem: keys.publicKeyPem });
  assert.equal(v.overall, 'verified', JSON.stringify([...v.integrity.checks, ...v.authenticity.checks].filter((c) => !c.ok)));
  assert.equal(v.valid, true);
  assert.equal(v.authenticity.status, 'verified');
  assert.equal(v.immutability.guaranteed, false);
});

test('sin clave fijada el expediente genuino NO es "verified": solo integridad (REQ-LED-05)', async () => {
  const { dossier } = await buildFixture();
  const v = await verifyDossierFull(dossier);
  assert.equal(v.integrity.valid, true);
  assert.equal(v.authenticity.status, 'unpinned');
  assert.equal(v.overall, 'integrity-only');
  assert.equal(v.valid, false);
});

test('también se puede fijar solo la huella (keyId) de la clave (REQ-LED-05)', async () => {
  const { dossier, keys } = await buildFixture();
  assert.equal((await verifyDossierFull(dossier, { trustedKeyId: keys.keyId })).overall, 'verified');
  assert.equal((await verifyDossierFull(dossier, { trustedKeyId: 'f'.repeat(64) })).overall, 'invalid');
});

// ---- Las 21 manipulaciones de la auditoría, ahora como pruebas de regresión ----

type Tamper = (d: DecisionDossier) => void | Promise<void>;
const contentTampers: Array<[string, Tamper]> = [
  ['V1 ledger: texto de evidenceSummary', (d) => { d.ledger[1].evidenceSummary = 'manipulado'; }],
  ['V2 ledger: evidenceData', (d) => { (d.ledger.find((e) => e.action === 'WORK_ORDER_ISSUED')!.evidenceData as { assignee: string }).assignee = 'Otro'; }],
  ['V3 ledger: timestamp', (d) => { d.ledger[2].timestamp = '2020-01-01T00:00:00.000Z'; }],
  ['V4 ledger: actor', (d) => { d.ledger[2].actor = 'Otro actor'; }],
  ['V6 ledger: reordenar entradas', (d) => { [d.ledger[2], d.ledger[3]] = [d.ledger[3], d.ledger[2]]; }],
  ['V7 orden: responsable', (d) => { d.sealed.order.assignee = 'Otra persona'; }],
  ['V8 orden: prioridad Alta→Baja', (d) => { d.sealed.order.priority = 'Baja'; }],
  ['V9 orden: causa probable y ubicación', (d) => { d.sealed.order.probableCause = 'Falsa'; d.sealed.order.location = 'Otro sitio'; }],
  ['V10 orden: texto del checklist', (d) => { d.sealed.order.checklist![0].label = 'Paso falso'; }],
  ['V11 orden: notas de cierre', (d) => { d.sealed.order.closureNotes = 'Nota falsa'; }],
  ['V12 anomalía: telemetría de la anomalía', (d) => { d.sealed.anomaly!.telemetrySnapshot.pressureBar = 99; }],
  ['V12b telemetría: ventana del nodo', (d) => { d.sealed.telemetry!.window[0].flowLs = 1; }],
  ['V12c red: lectura de otro nodo usada por el balance', (d) => { d.sealed.networkSnapshot.nodes[0].current.flowLs = 1; }],
  ['V13 diagnóstico: hipótesis y decisión', (d) => { d.sealed.diagnosis!.primaryHypothesis = 'Falsa'; (d.sealed.diagnosis as { operatorDecision: string }).operatorDecision = 'rejected'; }],
  ['V14 análisis hidráulico: pérdida estimada', (d) => { (d.sealed.hydraulic as { estimatedLossLs: number }).estimatedLossLs = 0.5; }],
  ['V14b concordancia', (d) => { (d.sealed.concordance as { level: string }).level = 'alta'; }],
  ['V15 foto: sustituir bytes', (d) => { d.evidencePhoto!.base64 = PNG_B; }],
  ['V16 foto: eliminarla', (d) => { d.evidencePhoto = null; }],
  ['V17 orden: cambiar responsable Y status (antes eludía la comprobación)', (d) => { d.sealed.order.assignee = 'Otra persona'; (d.sealed.order as { status: string }).status = 'En Progreso'; }],
  ['V18 orden: borrar closureEvidence y foto', (d) => { delete d.sealed.order.closureEvidence; d.sealed.evidence = null; d.evidencePhoto = null; }],
  ['V19 metadatos: syntheticData true→false', (d) => { d.syntheticData = false; }],
  ['V19b contenido: anomalía marcada como dato real', (d) => { d.sealed.anomaly!.synthetic = false; }],
];

for (const [label, tamper] of contentTampers) {
  test(`manipulación detectada como inválida: ${label} (REQ-LED-03)`, async () => {
    const { dossier, keys } = await buildFixture();
    const d = clone(dossier);
    await tamper(d);
    const v = await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem });
    assert.equal(v.overall, 'invalid', `no se detectó: ${label}`);
    assert.equal(v.valid, false);
  });
}

test('V5 truncamiento POSTERIOR al cierre: detectado por el ancla firmada (REQ-LED-05, regresión de auditoría)', async () => {
  const { dossier, keys } = await buildFixture();
  for (const n of [1, 2]) {
    const d = clone(dossier);
    d.ledger = d.ledger.slice(0, -n);
    const v = await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem });
    assert.equal(v.overall, 'invalid', `truncar ${n} entrada(s) debe detectarse`);
    assert.ok(v.authenticity.checks.some((c) => c.id === 'anchor-ledger' && !c.ok));
  }
});

test('V5b quitar el ancla para ocultar el truncamiento nunca produce "verified" (REQ-LED-05)', async () => {
  const { dossier, keys } = await buildFixture();
  const d = clone(dossier);
  d.ledger = d.ledger.slice(0, -2);
  d.anchor = null;
  const v = await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem });
  assert.equal(v.overall, 'integrity-only');
  assert.equal(v.authenticity.status, 'partial');
  assert.equal(v.valid, false);
});

test('truncar incluyendo el cierre se detecta incluso sin ancla (REQ-LED-03)', async () => {
  const { dossier, keys } = await buildFixture();
  const d = clone(dossier);
  d.ledger = d.ledger.slice(0, -3);
  d.anchor = null;
  assert.equal((await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem })).overall, 'invalid');
});

async function rechain(ledger: TrustLedgerEntry[], from: number): Promise<void> {
  for (let k = from; k < ledger.length; k++) {
    ledger[k].previousHash = k === 0 ? GENESIS_HASH : ledger[k - 1].hash;
    const { hash: _h, evidenceData: _e, ...unsigned } = ledger[k];
    ledger[k].hash = await sha256Hex(canonicalLedgerPayload(unsigned));
  }
}

test('V20 re-encadenado completo tras reescribir un bloque: el recibo firmado lo delata (REQ-LED-05)', async () => {
  const { dossier, keys } = await buildFixture();
  const d = clone(dossier);
  d.ledger[1].evidenceSummary = 'Texto reescrito por el atacante';
  await rechain(d.ledger, 1);
  // El atacante también ajusta lo que SÍ puede editar (el sello sin firma), pero no puede refirmar el recibo.
  d.seal.closedLedgerHash = d.ledger.find((e) => e.action === 'WORK_ORDER_CLOSED')!.hash;
  const v = await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem });
  assert.equal(v.overall, 'invalid');
  assert.ok(v.authenticity.checks.some((c) => c.id === 'receipt-binding' && !c.ok));
});

test('V21 falsificación total con claves propias: nunca "verified" (REQ-LED-05)', async () => {
  const real = await buildFixture();
  const forger = await buildFixture(); // el falsificador monta su propio expediente completo y lo firma con SU clave
  const fake = clone(forger.dossier);
  fake.sealed.order.id = 'OT-2026-999';
  // Sin clave fijada: las firmas "valen" pero no se puede afirmar nada sobre el emisor.
  const unpinned = await verifyDossierFull(forger.dossier);
  assert.notEqual(unpinned.overall, 'verified');
  // Con la clave del servidor real fijada: el expediente del falsificador no es del emisor esperado.
  const pinned = await verifyDossierFull(forger.dossier, { trustedPublicKeyPem: real.keys.publicKeyPem });
  assert.equal(pinned.overall, 'invalid');
  assert.notEqual((await verifyDossierFull(fake, { trustedPublicKeyPem: real.keys.publicKeyPem })).overall, 'verified');
});

test('V21b expediente fabricado sin recibo ni ancla: integrity-only como máximo (REQ-LED-05)', async () => {
  const { dossier, keys } = await buildFixture();
  const d = clone(dossier);
  d.seal.receipt = null;
  d.anchor = null;
  d.issuer = null;
  const v = await verifyDossierFull(d, { trustedPublicKeyPem: keys.publicKeyPem });
  assert.equal(v.authenticity.status, 'absent');
  assert.equal(v.overall, 'integrity-only');
  assert.equal(v.valid, false);
});

test('intercambio de clave: sustituir issuer y refirmar con otra clave se detecta al fijar la clave real (REQ-LED-05)', async () => {
  const real = await buildFixture();
  const attackerKeys = loadOrCreateSealKeys({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-atk-')) });
  const d = clone(real.dossier);
  const { finalizeSeal: fin } = await import('./dossierService');
  const closed = d.ledger.find((e) => e.action === 'WORK_ORDER_CLOSED')!;
  d.seal = fin(attackerKeys, d.sealed.order.id, { dossierDigest: d.seal.dossierDigest, componentDigests: d.seal.componentDigests as never }, closed);
  d.issuer = { keyId: attackerKeys.keyId, publicKeyPem: attackerKeys.publicKeyPem };
  assert.equal((await verifyDossierFull(d, { trustedPublicKeyPem: real.keys.publicKeyPem })).overall, 'invalid');
  assert.notEqual((await verifyDossierFull(d)).overall, 'verified', 'sin pinning tampoco se considera auténtico');
});

test('el expediente de un formato desconocido se rechaza con un motivo claro (REQ-LED-03)', async () => {
  const v = await verifyDossierFull({ format: 'otro' } as unknown as DecisionDossier);
  assert.equal(v.overall, 'invalid');
  assert.equal(v.integrity.checks[0].id, 'format');
});
