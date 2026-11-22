import test from 'node:test';
import assert from 'node:assert/strict';
import { anomaly, diag, node, order, reading } from './fixtures';
import {
  channelLabel,
  diagnosisProvenance,
  evidenceBasisLabels,
  hashFor,
  incidentProvenance,
  incidentTitle,
  incidentWhatHappens,
  networkSummary,
  nextActions,
  nodeHealth,
  orderVerification,
  parseHash,
  timeAgo,
  urgency,
} from './vocab';

test('REQ-UX-03: un nodo cuya última lectura es la "restaurada" al cerrar una orden queda pendiente de verificación, no estable (F2 visible)', () => {
  assert.equal(nodeHealth(node()), 'stable');
  assert.equal(nodeHealth(node({ status: 'critical' })), 'critical');
  assert.equal(nodeHealth(node({ status: 'warning' })), 'attention');
  assert.equal(nodeHealth(node({ status: 'fault' })), 'attention');
  assert.equal(nodeHealth(node({ status: 'nominal', current: reading({ source: 'restored' }) })), 'verifying', 'el servidor dice "nominal" pero la lectura no es una medición');
});

test('REQ-FIX-02 (F2): un punto con orden cerrada y sin medición posterior se muestra «pendiente de verificación», sea cual sea su estado', () => {
  const pending = { workOrderId: 'OT-1', closedAt: '2026-06-01T13:00:00.000Z' };
  assert.equal(nodeHealth(node({ status: 'critical', pendingVerification: pending })), 'verifying', 'las cifras son de antes del cierre');
  assert.equal(nodeHealth(node({ status: 'nominal', pendingVerification: pending })), 'verifying');
  assert.equal(nodeHealth(node({ status: 'nominal' })), 'stable', 'tras la medición posterior el servidor quita la marca');
});

test('REQ-FIX-01 (F1): el canal «reporte» del servidor se muestra como declarado, sin aviso de dato antiguo', () => {
  const declared = anomaly({ origin: 'offline-report', synthetic: false });
  const r = evidenceBasisLabels(declared, diag({ evidenceBasis: ['reporte', 'hidráulica'] }));
  assert.deepEqual(r.labels, ['Reporte de campo (declarado)', 'Balance hidráulico']);
  assert.equal(r.warning, undefined);
  assert.equal(channelLabel(declared, 'reporte'), 'Reporte de campo (declarado)');
});

test('REQ-UX-03: tras el cierre solo cuentan las mediciones POSTERIORES; la lectura restaurada y la línea base no verifican nada', () => {
  const closed = order({ status: 'Cerrada', updatedAt: '2026-06-01T13:00:00.000Z' });
  assert.deepEqual(orderVerification(order(), []), { state: 'not_closed' });
  const restoredOnly = [reading({ timestamp: '2026-06-01T13:00:01.000Z', source: 'restored' }), reading({ timestamp: '2026-06-01T13:05:00.000Z', source: 'baseline' })];
  assert.equal(orderVerification(closed, restoredOnly).state, 'pending');
  assert.equal(orderVerification(closed, undefined).state, 'pending');
  const before = reading({ timestamp: '2026-06-01T12:59:00.000Z', source: 'api' });
  assert.equal(orderVerification(closed, [before]).state, 'pending', 'una medición anterior al cierre no confirma la recuperación');
  const after = [reading({ id: 'R2', timestamp: '2026-06-01T13:10:00.000Z', source: 'api' }), reading({ id: 'R3', timestamp: '2026-06-01T13:20:00.000Z', source: 'csv' })];
  const v = orderVerification(closed, [...restoredOnly, ...after]);
  assert.equal(v.state, 'measured');
  assert.equal(v.state === 'measured' && v.measuredAfter, 2);
  assert.equal(v.state === 'measured' && v.last.id, 'R3');
});

test('REQ-UX-02: un reporte declarado por una persona NUNCA se presenta como lectura de sensores, aunque el servidor lo cuente así (F1 visible)', () => {
  const declared = anomaly({ origin: 'offline-report', synthetic: false });
  const r = evidenceBasisLabels(declared, diag({ evidenceBasis: ['sensores'] }));
  assert.deepEqual(r.labels, ['Reporte de campo (declarado)']);
  assert.match(r.warning ?? '', /ningún sensor lo confirma/);
  assert.equal(channelLabel(declared, 'sensores'), 'Reporte de campo (declarado)');
  const measured = evidenceBasisLabels(anomaly(), diag({ evidenceBasis: ['sensores', 'hidráulica'] }));
  assert.deepEqual(measured.labels, ['Lecturas de sensores', 'Balance hidráulico']);
  assert.equal(measured.warning, undefined);
  assert.equal(channelLabel(anomaly(), 'sensores'), 'Lecturas de sensores');
  assert.deepEqual(incidentProvenance(declared), ['declarado']);
});

test('REQ-UX-02: procedencia: lo inferido por el motor, lo simulado y la hipótesis de IA se distinguen; el texto de respaldo no es "IA"', () => {
  assert.deepEqual(incidentProvenance(anomaly()), ['inferido', 'simulado']);
  assert.deepEqual(incidentProvenance(anomaly({ synthetic: false, telemetrySnapshot: reading({ synthetic: false }) })), ['inferido']);
  assert.equal(diagnosisProvenance({ providerMode: 'gemini-live' }), 'hipotesis_ia');
  assert.equal(diagnosisProvenance({ providerMode: 'fallback-adapter' }), 'inferido');
});

test('REQ-UX-01: los incidentes se describen en lenguaje claro, con cifras y su referencia, y sin afirmar certeza que no hay', () => {
  assert.equal(incidentTitle(anomaly()), 'Posible fuga en Troncal Norte');
  assert.equal(incidentTitle(anomaly({ origin: 'network-balance', hydraulicLevel: 'possible_leak' })), 'Posible fuga cerca de Troncal Norte');
  assert.equal(incidentTitle(anomaly({ origin: 'network-balance', hydraulicLevel: 'localized_leak' })), 'Fuga probable cerca de Troncal Norte');
  assert.ok(!/confirmad/i.test(incidentTitle(anomaly({ origin: 'network-balance', hydraulicLevel: 'localized_leak' }))));
  assert.equal(incidentTitle(anomaly({ category: 'contamination' })), 'Calidad del agua fuera de rango en Troncal Norte');
  const rule = { ruleId: 'PRESSURE_DROP_LEAK', metric: 'pressureBar', observedValue: 3.1, baselineValue: 4.5, deltaPct: -31.1, title: '', category: 'leak', severityScore: 1, explanation: '' } as never;
  assert.equal(incidentWhatHappens(anomaly({ rulesTriggered: [rule] })), 'La presión está 31.1% por debajo de lo normal (3.1 bar frente a 4.5 bar).');
  const field = { ...(rule as object), metric: 'fieldReport', explanation: 'Reporte en sitio (declarado por el reportante, no verificado): "huele a cloro y sale agua"' } as never;
  const text = incidentWhatHappens(anomaly({ origin: 'offline-report', rulesTriggered: [field] }));
  assert.match(text, /huele a cloro y sale agua/);
  assert.match(text, /Ningún sensor lo ha confirmado/);
  const net = { ...(rule as object), ruleId: 'HYDRAULIC_MASS_IMBALANCE', metric: 'massBalanceLs', observedValue: 12.65, deltaPct: 50 } as never;
  assert.match(incidentWhatHappens(anomaly({ origin: 'network-balance', rulesTriggered: [net] })), /unos 12\.65 L\/s .*estimación/);
});

test('REQ-UX-01: la urgencia usa palabras, no puntuaciones internas', () => {
  assert.deepEqual(urgency('Crítica'), { label: 'Urgente', tone: 'critical' });
  assert.equal(urgency('Alta').label, 'Importante');
  assert.equal(urgency('Baja').tone, 'neutral');
});

test('REQ-UX-01: el resumen de la red responde en una frase y respeta F2 (pendiente de verificación) y la marca de simulado', () => {
  const base = { nodes: [node()], anomalies: [], diagnoses: [], orders: [], pendingReports: 0 };
  const stable = networkSummary(base);
  assert.equal(stable.status, 'stable');
  assert.equal(stable.headline, 'La red está estable');
  assert.equal(stable.allSynthetic, true);
  const critical = networkSummary({ ...base, anomalies: [anomaly({ priority: { totalScore: 90, priority: 'Crítica' } as never })] });
  assert.equal(critical.status, 'critical');
  assert.equal(critical.headline, 'Posible fuga en Troncal Norte');
  const two = networkSummary({ ...base, anomalies: [anomaly(), anomaly({ id: 'A2' })] });
  assert.equal(two.status, 'attention');
  assert.equal(two.headline, '2 incidentes requieren atención');
  const verifying = networkSummary({ ...base, nodes: [node({ current: reading({ source: 'restored' }) })] });
  assert.equal(verifying.status, 'verifying', 'una red "sin incidentes" con un nodo restaurado sin medir NO se declara estable');
  assert.notEqual(verifying.headline, 'La red está estable');
  assert.equal(networkSummary({ ...base, nodes: [node({ current: reading({ synthetic: false }) })] }).allSynthetic, false);
});

test('REQ-UX-01: "qué hacer ahora" prioriza lo urgente y explica por qué hace falta cada acción', () => {
  const closedNode = node({ id: 'N2', name: 'Válvula', current: reading({ nodeId: 'N2', source: 'restored' }) });
  const input = {
    anomalies: [anomaly({ id: 'A1', priority: { totalScore: 60, priority: 'Media' } as never }), anomaly({ id: 'A9', priority: { totalScore: 95, priority: 'Crítica' } as never })],
    diagnoses: [diag({ anomalyId: 'A1' })],
    orders: [order({ id: 'OT-7', anomalyId: 'A-old', nodeId: 'N2', status: 'Cerrada', location: 'Válvula · Sur' }), order({ id: 'OT-8', anomalyId: 'A-x', status: 'En Progreso' })],
    nodes: [node(), closedNode],
    seriesByNode: { N2: [reading({ nodeId: 'N2', source: 'restored' })] },
    pendingReports: 2,
    online: true,
  };
  const list = nextActions(input);
  assert.equal(list[0].tone, 'critical');
  assert.equal(list[0].target.kind === 'incident' && list[0].target.id, 'A9');
  assert.equal(list[0].needs, 'ai:use', 'A9 no tiene diagnóstico: hace falta permiso de IA');
  assert.ok(list.some((a) => a.id === 'inc-A1' && a.cta === 'Decidir' && a.needs === 'diagnosis:decide'));
  assert.ok(list.some((a) => a.id === 'ord-OT-8'));
  assert.ok(list.some((a) => a.id === 'ver-OT-7' && a.tone === 'verifying'), 'la orden cerrada sin mediciones aparece como pendiente');
  const sync = list.find((a) => a.id === 'sync')!;
  assert.equal(sync.cta, 'Enviar ahora');
  assert.equal(nextActions({ ...input, online: false }).find((a) => a.id === 'sync')!.cta, 'Esperando conexión');
  assert.deepEqual(nextActions({ anomalies: [], diagnoses: [], orders: [], nodes: [node()], seriesByNode: {}, pendingReports: 0, online: true }), []);
});

test('REQ-UX-04: la navegación principal tiene cuatro apartados y las rutas se resuelven con seguridad', () => {
  assert.equal(parseHash('').view, 'home');
  assert.equal(parseHash('#/mapa').view, 'map');
  assert.equal(parseHash('#/incidentes').view, 'incidents');
  assert.equal(parseHash('#/ordenes').view, 'orders');
  assert.deepEqual(parseHash('#/avanzado/ledger'), { view: 'advanced', tab: 'ledger' });
  assert.deepEqual(parseHash('#/avanzado/<script>'), { view: 'advanced', tab: 'sensores' });
  assert.equal(parseHash('#/cualquier-cosa').view, 'home');
  assert.equal(hashFor('map'), '#/mapa');
  assert.equal(hashFor('advanced', 'demo'), '#/avanzado/demo');
});

test('timeAgo expresa la antigüedad en palabras', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  assert.equal(timeAgo('2026-06-01T11:59:50Z', now), 'hace unos segundos');
  assert.equal(timeAgo('2026-06-01T11:55:00Z', now), 'hace 5 min');
  assert.equal(timeAgo('2026-06-01T09:00:00Z', now), 'hace 3 h');
  assert.equal(timeAgo(null, now), 'sin datos');
  assert.equal(timeAgo('basura', now), 'sin datos');
});
