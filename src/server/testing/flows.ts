import assert from 'node:assert/strict';
import { api, PNG_1X1 } from './harness';

/**
 * Flujos de extremo a extremo reutilizables por las pruebas y por el recorrido de demostración (scripts/demoLoop.ts).
 * Cada paso usa la API real del servidor, con sesión, CSRF y permisos reales: no hay atajos de prueba.
 */
export interface ClosedOrder {
  orderId: string;
  nodeId: string;
  anomalyId: string;
  closedAt: string;
  /** Estado del servidor justo después de lanzar el escenario (la anomalía ya detectada y su diagnóstico hidráulico). */
  detected: any;
  /** Diagnóstico propuesto, antes de que una persona decida. */
  diagnosis: any;
  /** Orden creada al aceptar la recomendación. */
  order: any;
}

/** Fuga simulada → diagnóstico → decisión humana → orden → tareas → foto sellada → cierre. Deja el punto pendiente de verificación. */
export async function runLeakToClosedOrder(base: string): Promise<ClosedOrder> {
  const get = (url: string) => api(base, 'GET', url);
  const post = (url: string, body?: unknown) => api(base, 'POST', url, body ?? {});
  const patch = (url: string, body?: unknown) => api(base, 'PATCH', url, body ?? {});

  const trig = await post('/api/scenarios/leak/trigger');
  assert.equal(trig.status, 200, JSON.stringify(trig.data).slice(0, 300));
  const detected = (await get('/api/state')).data;
  const anomaly = detected.anomalies.find((a: any) => a.status === 'active');
  assert.ok(anomaly, 'el escenario debe dejar una anomalía activa');
  const diagnosis = detected.diagnoses.find((d: any) => d.anomalyId === anomaly.id && d.operatorDecision === 'pending');
  assert.ok(diagnosis, 'el escenario debe dejar un diagnóstico pendiente de decisión');
  const dec = await post(`/api/diagnoses/${diagnosis.id}/decision`, { decision: 'accepted', assignee: 'Cuadrilla Norte' });
  assert.equal(dec.status, 200);
  const order = dec.data.createdOrder;
  assert.equal((await patch(`/api/work-orders/${order.id}`, { status: 'En Progreso' })).status, 200);
  for (const c of order.checklist) assert.equal((await patch(`/api/work-orders/${order.id}/checklist/${c.id}`, { done: true })).status, 200);
  assert.equal((await post(`/api/work-orders/${order.id}/evidence`, { fileName: 'cierre.png', dataUrl: PNG_1X1 })).status, 200);
  const closed = await patch(`/api/work-orders/${order.id}`, { status: 'Cerrada', closureNotes: 'Brida reemplazada' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data).slice(0, 300));
  const node = closed.data.nodes.find((n: any) => n.id === order.nodeId);
  assert.ok(node.pendingVerification, 'cerrar no declara recuperación: queda pendiente de verificación');
  return { orderId: order.id, nodeId: order.nodeId, anomalyId: anomaly.id, closedAt: node.pendingVerification.closedAt, detected, diagnosis, order };
}
