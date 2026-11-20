import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOfflineReport } from './offlineConflict';

const now = Date.parse('2026-11-19T12:00:00Z');
const closed = (id: string, nodeId: string, updatedAt: string) => ({ id, nodeId, status: 'Cerrada' as const, updatedAt });

test('REGRESIÓN: una orden cerrada hace semanas NO oculta un reporte nuevo (REQ-RES-03)', () => {
  const r = classifyOfflineReport(
    { nodeId: 'N-TRON-04', createdAt: '2026-11-19T11:00:00Z' },
    [closed('OT-1', 'N-TRON-04', '2026-10-01T10:00:00Z')],
    now
  );
  assert.equal(r.status, 'active');
});

test('un reporte anterior al cierre se marca superseded y cita la orden (REQ-RES-03)', () => {
  const r = classifyOfflineReport(
    { nodeId: 'N-TRON-04', createdAt: '2026-11-18T08:00:00Z' },
    [closed('OT-1', 'N-TRON-04', '2026-11-18T20:00:00Z')],
    now
  );
  assert.equal(r.status, 'superseded');
  assert.equal(r.conflictOrderId, 'OT-1');
});

test('solo cuentan las órdenes cerradas del mismo nodo (REQ-RES-03)', () => {
  const r = classifyOfflineReport(
    { nodeId: 'N-TRON-04', createdAt: '2026-11-18T08:00:00Z' },
    [closed('OT-9', 'N-VALV-05', '2026-11-18T20:00:00Z'), { id: 'OT-2', nodeId: 'N-TRON-04', status: 'Abierta', updatedAt: '2026-11-18T20:00:00Z' }],
    now
  );
  assert.equal(r.status, 'active');
});

test('fecha inválida o futura usa la hora de recepción (no permite adelantar ni retrasar el reporte) (REQ-RES-03)', () => {
  const orders = [closed('OT-1', 'N-TRON-04', '2026-11-19T11:30:00Z')];
  const bad = classifyOfflineReport({ nodeId: 'N-TRON-04', createdAt: 'basura' }, orders, now);
  assert.equal(bad.status, 'active');
  assert.equal(bad.effectiveCreatedAt, new Date(now).toISOString());
  const future = classifyOfflineReport({ nodeId: 'N-TRON-04', createdAt: '2027-01-01T00:00:00Z' }, orders, now);
  assert.equal(future.status, 'active');
  assert.match(future.note, /futuro/);
});
