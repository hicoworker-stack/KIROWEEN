import { AnomalyEvent, AquaBrainDiagnosis, NetworkNode, SmartWorkOrder, TelemetryReading } from '../core/types';

/** Datos de prueba mínimos para las pruebas de la interfaz. */
export const reading = (over: Partial<TelemetryReading> = {}): TelemetryReading => ({
  id: 'R1', timestamp: '2026-06-01T12:00:00.000Z', nodeId: 'N1', pressureBar: 4.5, flowLs: 20, levelPct: 0, turbidityNtu: 1, chlorineMgL: 1, ph: 7.2, synthetic: true, source: 'api', ...over,
});
export const node = (over: Partial<NetworkNode> = {}): NetworkNode =>
  ({ id: 'N1', name: 'Troncal Norte', sector: 'Norte', kind: 'junction', x: 0, y: 0, elevationM: 0, populationServed: 100, status: 'nominal', baseline: { pressureBar: 4.5, flowLs: 20, levelPct: 0, turbidityNtu: 1, chlorineMgL: 1, ph: 7.2 }, current: reading(), assetCode: 'A', material: 'PVC', diameterMm: 100, ...over }) as NetworkNode;
export const anomaly = (over: Partial<AnomalyEvent> = {}): AnomalyEvent =>
  ({ id: 'A1', timestamp: '2026-06-01T12:00:00.000Z', nodeId: 'N1', nodeName: 'Troncal Norte', sector: 'Norte', category: 'leak', title: 'técnico', status: 'active', rulesTriggered: [], priority: { totalScore: 70, priority: 'Alta' } as never, telemetrySnapshot: reading(), baselineSnapshot: node().baseline, synthetic: true, origin: 'node-rule', ...over }) as AnomalyEvent;
export const diag = (over: Partial<AquaBrainDiagnosis> = {}): AquaBrainDiagnosis => ({ id: 'D1', anomalyId: 'A1', operatorDecision: 'pending', providerMode: 'fallback-adapter', evidenceBasis: ['sensores'], ...over }) as AquaBrainDiagnosis;
export const order = (over: Partial<SmartWorkOrder> = {}): SmartWorkOrder =>
  ({ id: 'OT-1', anomalyId: 'A1', diagnosisId: 'D1', nodeId: 'N1', location: 'Troncal Norte · Norte', assignee: 'Brigada', status: 'Abierta', updatedAt: '2026-06-01T12:30:00.000Z', createdAt: '2026-06-01T12:00:00.000Z', ...over }) as SmartWorkOrder;
