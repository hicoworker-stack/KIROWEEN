import { SmartWorkOrder } from './types';

/**
 * REQ-RES-03: un reporte de campo solo se considera "anterior a un cierre" si su fecha es anterior
 * al cierre de una orden de ese nodo. Antes, CUALQUIER orden cerrada en el nodo, de cualquier fecha,
 * marcaba como resuelto un reporte nuevo y lo ocultaba.
 *
 * Límite honesto: createdAt lo declara el dispositivo del reportante y no es verificable.
 */

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface OfflineClassification {
  /** 'active': la incidencia se trata como nueva. 'superseded': describe algo previo a una reparación ya cerrada. */
  status: 'active' | 'superseded';
  effectiveCreatedAt: string;
  conflictOrderId?: string;
  note: string;
}

export function classifyOfflineReport(
  report: { nodeId: string; createdAt?: unknown },
  orders: Pick<SmartWorkOrder, 'id' | 'nodeId' | 'status' | 'updatedAt'>[],
  nowMs: number
): OfflineClassification {
  const notes: string[] = [];
  let createdMs = typeof report.createdAt === 'string' ? Date.parse(report.createdAt) : NaN;
  if (!Number.isFinite(createdMs)) {
    createdMs = nowMs;
    notes.push('fecha del reporte inválida: se usó la hora de recepción');
  } else if (createdMs > nowMs + MAX_FUTURE_SKEW_MS) {
    createdMs = nowMs;
    notes.push('fecha del reporte en el futuro: se usó la hora de recepción');
  }
  const effectiveCreatedAt = new Date(createdMs).toISOString();

  const closedAfterReport = orders
    .filter((o) => o.nodeId === report.nodeId && o.status === 'Cerrada')
    .filter((o) => {
      const closedMs = Date.parse(o.updatedAt);
      return Number.isFinite(closedMs) && closedMs >= createdMs;
    })
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];

  if (closedAfterReport) {
    return {
      status: 'superseded',
      effectiveCreatedAt,
      conflictOrderId: closedAfterReport.id,
      note: `El reporte es anterior al cierre de ${closedAfterReport.id}; posiblemente describe algo ya reparado. Requiere revisión humana.${notes.length ? ' (' + notes.join('; ') + ')' : ''}`,
    };
  }
  return {
    status: 'active',
    effectiveCreatedAt,
    note: `Reporte posterior a cualquier cierre en el nodo: se trata como incidencia nueva.${notes.length ? ' (' + notes.join('; ') + ')' : ''}`,
  };
}
