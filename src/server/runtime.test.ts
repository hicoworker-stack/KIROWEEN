import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mutex, PersistenceTracker } from './runtime';
import { loadPersistedState, trySavePersistedState, SaveInput } from './persistence';
import { createBaselineNodes } from '../core/networkData';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Mutex serializa secciones lectura-modificación-escritura (REQ-RES-04, regresión de actualización perdida)', async () => {
  const m = new Mutex();
  const order = { done: new Set<string>() };

  // Reproduce el defecto: leer, esperar (await), escribir una copia derivada de lo leído.
  async function toggleUnsafe(id: string) {
    const snapshot = new Set(order.done);
    await sleep(5);
    snapshot.add(id);
    order.done = snapshot;
  }
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => toggleUnsafe(id)));
  assert.ok(order.done.size < 4, 'sin exclusión mutua se pierden actualizaciones (demuestra el defecto original)');

  order.done = new Set();
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => m.runExclusive(() => toggleUnsafe(id))));
  assert.equal(order.done.size, 4, 'con Mutex no se pierde ninguna');
});

test('Mutex continúa tras un error y respeta el orden FIFO (REQ-RES-04)', async () => {
  const m = new Mutex();
  const log: number[] = [];
  const p1 = m.runExclusive(async () => {
    await sleep(10);
    log.push(1);
  });
  const p2 = m.runExclusive(() => {
    log.push(2);
    throw new Error('falla');
  });
  const p3 = m.runExclusive(() => {
    log.push(3);
  });
  await p1;
  await assert.rejects(p2, /falla/);
  await p3;
  assert.deepEqual(log, [1, 2, 3]);
  assert.equal(m.queued, 0);
});

function emptyState(): SaveInput {
  const nodes = createBaselineNodes();
  return {
    nodes,
    seriesByNode: Object.fromEntries(nodes.map((n) => [n.id, [n.current]])),
    anomalies: [],
    visionAnalyses: [],
    diagnoses: [],
    workOrders: [],
    ledger: [],
    syncedOfflineKeys: [],
  };
}

test('un fallo de escritura degrada a solo-memoria sin lanzar y se recupera solo (REQ-RES-05)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-rt-'));
  const file = path.join(dir, 'state.json');
  const tracker = new PersistenceTracker(file);
  assert.equal(tracker.write(emptyState()).mode, 'disk');

  // Reproduce el fallo de la auditoría: el destino no se puede reemplazar. Un directorio con ese nombre lo provoca en todo SO.
  fs.rmSync(file);
  fs.mkdirSync(file);
  const failed = tracker.write(emptyState());
  assert.equal(failed.mode, 'memory-only');
  assert.ok(failed.lastError && failed.lastError.length > 0);
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(tracker.write(emptyState()).consecutiveFailures, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no deja archivos temporales');

  fs.rmSync(file, { recursive: true });
  const recovered = tracker.write(emptyState());
  assert.equal(recovered.mode, 'disk');
  assert.equal(recovered.consecutiveFailures, 0);
});

test('trySavePersistedState no lanza con una ruta inválida (REQ-RES-05)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-rt-'));
  const blocker = path.join(dir, 'archivo');
  fs.writeFileSync(blocker, 'x');
  const r = trySavePersistedState(emptyState(), path.join(blocker, 'sub', 'state.json'));
  assert.equal(r.ok, false);
});

test('un archivo de estado ilegible se aparta en lugar de sobrescribirse en silencio (REQ-RES-05)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-rt-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ esto no es json');
  assert.equal(loadPersistedState(file), null);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('state.json.corrupt-')), 'se conserva una copia del archivo dañado');
  assert.ok(!files.includes('state.json'));
});

test('el estado v2 conserva sellos, anclas y claves de deduplicación al ir y volver (REQ-LED-04)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-rt-'));
  const file = path.join(dir, 'state.json');
  const s = emptyState();
  s.sealedDossiers = { 'OT-1': { x: 1 } };
  s.seenReadingKeys = { 'N-TOMA-01|2026-11-19T11:59:00.000Z': '1|2' };
  assert.equal(trySavePersistedState(s, file).ok, true);
  const back = loadPersistedState(file)!;
  assert.deepEqual(back.sealedDossiers, { 'OT-1': { x: 1 } });
  assert.deepEqual(back.seenReadingKeys, { 'N-TOMA-01|2026-11-19T11:59:00.000Z': '1|2' });
  assert.equal(back.version, 2);
});
