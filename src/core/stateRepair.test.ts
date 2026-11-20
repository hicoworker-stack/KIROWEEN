import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTelemetryState } from './stateRepair';
import { createBaselineNodes } from './networkData';

test('un estado persistido envenenado se repara y se informa (REQ-RES-02)', () => {
  const base = createBaselineNodes();
  const poisoned = createBaselineNodes();
  // Exactamente lo que dejaba el POST readings:[{nodeId}] de la auditoría.
  (poisoned[0] as unknown as { current: unknown }).current = { id: 'x', nodeId: 'N-TOMA-01' };
  const series: Record<string, unknown> = {
    'N-TOMA-01': [{ nodeId: 'N-TOMA-01' }, base[0].current],
  };
  const r = repairTelemetryState(poisoned, series, base);
  assert.equal(r.nodes[0].current.pressureBar, base[0].current.pressureBar);
  assert.equal(r.nodes[0].status, 'nominal');
  assert.equal(r.seriesByNode['N-TOMA-01'].length, 1);
  assert.ok(r.repairs.some((m) => m.includes('N-TOMA-01') && m.includes('corrupta')));
});

test('nodos ausentes y estados no-objeto se restauran desde la línea base (REQ-RES-02)', () => {
  const base = createBaselineNodes();
  const r = repairTelemetryState([base[1]], null, base);
  assert.equal(r.nodes.length, base.length);
  assert.ok(r.repairs.length >= base.length - 1);
  for (const n of r.nodes) assert.ok(r.seriesByNode[n.id].length >= 1);
});

test('un estado sano no genera reparaciones (REQ-RES-02)', () => {
  const base = createBaselineNodes();
  const series = Object.fromEntries(base.map((n) => [n.id, [n.current]]));
  const r = repairTelemetryState(base, series, base);
  assert.deepEqual(r.repairs, []);
});
