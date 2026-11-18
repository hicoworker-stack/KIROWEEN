import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { verifyDossier, DecisionDossier } from '../core/dossier';
import { SmartWorkOrder } from '../core/types';

/**
 * Prueba de extremo a extremo REAL: arranca server.ts como proceso, ejecuta el flujo completo de la demo
 * (evento → forense → diagnóstico → orden → checklist → foto → cierre → expediente verificable → reinicio).
 * No usa Gemini ni red externa (REQ-DEMO-01).
 */

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let proc: ChildProcess | null = null;
let base = '';
let tmpDir = '';
let logs = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      AQUA_STATE_PATH: path.join(tmpDir, 'state.json'),
      GEMINI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => (logs += d.toString()));
  proc.stderr?.on('data', (d) => (logs += d.toString()));
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* aún no escucha */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`El servidor no arrancó a tiempo. Logs:\n${logs}`);
}

async function stopServer(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  await new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill();
    setTimeout(resolve, 3000);
  });
}

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-e2e-'));
  await startServer();
});

after(async () => {
  await stopServer();
});

test('demo mode → forensics → order → M-10 → verifiable dossier → restart persistence (e2e)', { timeout: 120_000 }, async () => {
  // 1. Modo demo sintético y reproducible
  const demo = await api('POST', '/api/demo/frankenstein', {});
  assert.equal(demo.status, 200);
  assert.equal(demo.data.demo.synthetic, true);
  assert.equal(demo.data.anomaly.category, 'leak');
  assert.equal(demo.data.anomaly.synthetic, true);
  assert.equal(demo.data.visionAnalysis.visualCategory, 'leak');
  assert.equal(demo.data.diagnosis.providerMode, 'fallback-adapter');
  // La rampa dejó una serie con levelPct y ph presentes en todas las lecturas
  const series = demo.data.seriesByNode['N-TRON-04'];
  assert.ok(series.length >= 6);
  assert.ok(series.every((r: any) => typeof r.levelPct === 'number' && typeof r.ph === 'number'));

  // 2. Forense + concordancia
  const fx = await api('GET', `/api/anomalies/${demo.data.anomaly.id}/forensics`);
  assert.equal(fx.status, 200);
  assert.equal(fx.data.forensics.detected, true);
  assert.equal(fx.data.forensics.suspects[0].pipeId, 'P-05');
  assert.ok(fx.data.forensics.estimatedLossLs > 6 && fx.data.forensics.estimatedLossLs < 7);
  assert.ok(['partial', 'concordant'].includes(fx.data.concordance.status));

  // 3. Aprobación → orden con checklist y responsable
  const decision = await api('POST', `/api/diagnoses/${demo.data.diagnosis.id}/decision`, {
    decision: 'accepted',
    assignee: 'Cuadrilla Norte',
  });
  assert.equal(decision.status, 200);
  const order: SmartWorkOrder = decision.data.createdOrder;
  assert.equal(order.assignee, 'Cuadrilla Norte');
  assert.ok(order.checklist && order.checklist.length > 0);

  // 4. Cierre bloqueado sin checklist ni foto
  const blocked = await api('PATCH', `/api/work-orders/${order.id}`, { status: 'Cerrada', closureNotes: 'x' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.blockers.length, 2);

  // 5. Reasignar, completar checklist, adjuntar foto
  const reassigned = await api('PATCH', `/api/work-orders/${order.id}/assignee`, { assignee: 'Ing. Marta Rojas' });
  assert.equal(reassigned.data.workOrder.assignee, 'Ing. Marta Rojas');
  const badAssignee = await api('PATCH', `/api/work-orders/${order.id}/assignee`, { assignee: ' ' });
  assert.equal(badAssignee.status, 400);

  for (const item of order.checklist!) {
    const r = await api('PATCH', `/api/work-orders/${order.id}/checklist/${item.id}`, { done: true });
    assert.equal(r.status, 200);
  }
  const badMime = await api('POST', `/api/work-orders/${order.id}/evidence`, { fileName: 'x.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' });
  assert.equal(badMime.status, 415);
  const ev = await api('POST', `/api/work-orders/${order.id}/evidence`, { fileName: '..\\cierre.png', dataUrl: PNG_1X1 });
  assert.equal(ev.status, 200);
  const sha = ev.data.workOrder.closureEvidence.sha256;
  assert.match(sha, /^[a-f0-9]{64}$/);
  assert.equal(ev.data.workOrder.closureEvidence.fileName, 'cierre.png');

  const img = await fetch(`${base}/api/evidence/${sha}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // 6. Cierre real: restaura nodo y sella huella
  const closed = await api('PATCH', `/api/work-orders/${order.id}`, { status: 'Cerrada', closureNotes: 'Brida reemplazada; presión 4.4 bar' });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.workOrder.status, 'Cerrada');
  const node = closed.data.nodes.find((n: any) => n.id === 'N-TRON-04');
  assert.equal(node.status, 'nominal');
  const reclose = await api('PATCH', `/api/work-orders/${order.id}`, { status: 'En Progreso' });
  assert.equal(reclose.status, 409);

  // 7. Trazabilidad en ledger
  const actions = closed.data.ledger.map((e: any) => e.action);
  for (const a of ['WORK_ORDER_ISSUED', 'WORK_ORDER_ASSIGNED', 'CHECKLIST_ITEM_COMPLETED', 'CLOSURE_EVIDENCE_ATTACHED', 'WORK_ORDER_CLOSED']) {
    assert.ok(actions.includes(a), `falta ${a} en el ledger`);
  }
  const verify = await api('POST', '/api/ledger/verify', {});
  assert.equal(verify.data.valid, true);

  // 8. Expediente verificable fuera del servidor; una alteración se detecta
  const dossier = (await api<DecisionDossier>('GET', `/api/work-orders/${order.id}/dossier`)).data;
  const ok = await verifyDossier(dossier);
  assert.equal(ok.valid, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
  const tamperedAssignee = JSON.parse(JSON.stringify(dossier)) as DecisionDossier;
  tamperedAssignee.order.assignee = 'Otra persona';
  assert.equal((await verifyDossier(tamperedAssignee)).valid, false);
  const tamperedPhoto = JSON.parse(JSON.stringify(dossier)) as DecisionDossier;
  tamperedPhoto.evidencePhoto!.base64 = Buffer.from('otra foto').toString('base64');
  assert.equal((await verifyDossier(tamperedPhoto)).valid, false);
  const tamperedLedger = JSON.parse(JSON.stringify(dossier)) as DecisionDossier;
  tamperedLedger.ledger[3].evidenceSummary = 'manipulado';
  assert.equal((await verifyDossier(tamperedLedger)).valid, false);

  // 9. Snapshot exportable
  const snapshot = (await api('GET', '/api/state/export')).data;
  assert.equal(snapshot.format, 'aqua-sentinel-snapshot/1');
  assert.equal(Object.keys(snapshot.evidence).length, 1);

  // 10. Persistencia real tras reinicio del proceso
  const ledgerLenBefore = closed.data.ledger.length;
  await stopServer();
  await startServer();
  const after = await api('GET', '/api/state');
  assert.equal(after.data.ledger.length, ledgerLenBefore);
  const persistedOrder = after.data.workOrders.find((w: any) => w.id === order.id);
  assert.equal(persistedOrder.status, 'Cerrada');
  assert.equal(persistedOrder.assignee, 'Ing. Marta Rojas');
  assert.equal(persistedOrder.checklist.every((c: any) => c.done), true);
  assert.equal((await fetch(`${base}/api/evidence/${sha}`)).status, 200);

  // 11. Importar un snapshot manipulado se rechaza; el íntegro se acepta
  const tamperedSnap = JSON.parse(JSON.stringify(snapshot));
  tamperedSnap.state.ledger[2].evidenceSummary = 'alterado';
  const rejected = await api('POST', '/api/state/import', tamperedSnap);
  assert.equal(rejected.status, 422);
  const accepted = await api('POST', '/api/state/import', snapshot);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.ledger[accepted.data.ledger.length - 1].action, 'STATE_RESTORED_FROM_SNAPSHOT');
  assert.equal((await api('POST', '/api/ledger/verify', {})).data.valid, true);
});

test('Gemini sin API key: sonda honesta y estado sin afirmar "en vivo" (e2e)', async () => {
  const probe = await api('POST', '/api/ai/probe', {});
  assert.equal(probe.data.configured, false);
  assert.equal(probe.data.ok, false);
  const health = await api('GET', '/api/health');
  assert.equal(health.data.aiMode, 'fallback-adapter');
  assert.match(health.data.awsAdapters.s3, /SIMULADO/);
  assert.equal(health.data.persistence.kind, 'local-file');
});

