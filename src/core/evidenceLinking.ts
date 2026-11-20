import { AnomalyEvent, VisionAnalysisResult, VisionEvidenceRole } from './types';

/**
 * REQ-AI-05: una fotografía es evidencia de UN incidente concreto, no de un nodo.
 * Sin vínculo explícito (anomalyId) y sin coherencia temporal, no se usa como evidencia.
 */

/** Una foto puede ser algo anterior a la detección (el técnico la tomó antes de que el sensor alertara). */
export const PHOTO_PRE_INCIDENT_WINDOW_MS = 30 * 60 * 1000;

export type LinkRejection = 'sin_vinculo' | 'otro_incidente' | 'otro_nodo' | 'anterior_al_incidente';

export function explainVisionLink(
  vision: Pick<VisionAnalysisResult, 'anomalyId' | 'nodeId' | 'timestamp'>,
  anomaly: Pick<AnomalyEvent, 'id' | 'nodeId' | 'timestamp'>
): { linked: true } | { linked: false; reason: LinkRejection } {
  if (!vision.anomalyId) return { linked: false, reason: 'sin_vinculo' };
  if (vision.anomalyId !== anomaly.id) return { linked: false, reason: 'otro_incidente' };
  if (vision.nodeId !== anomaly.nodeId) return { linked: false, reason: 'otro_nodo' };
  const visionMs = Date.parse(vision.timestamp);
  const anomalyMs = Date.parse(anomaly.timestamp);
  if (Number.isFinite(visionMs) && Number.isFinite(anomalyMs) && visionMs < anomalyMs - PHOTO_PRE_INCIDENT_WINDOW_MS) {
    return { linked: false, reason: 'anterior_al_incidente' };
  }
  return { linked: true };
}

export function isVisionLinkedToAnomaly(
  vision: Pick<VisionAnalysisResult, 'anomalyId' | 'nodeId' | 'timestamp'>,
  anomaly: Pick<AnomalyEvent, 'id' | 'nodeId' | 'timestamp'>
): boolean {
  return explainVisionLink(vision, anomaly).linked;
}

/** La fotografía más reciente vinculada a este incidente, o null. Nunca se busca "por nodo". */
export function selectVisionForAnomaly(
  visions: VisionAnalysisResult[],
  anomaly: Pick<AnomalyEvent, 'id' | 'nodeId' | 'timestamp'> | null | undefined
): VisionAnalysisResult | null {
  if (!anomaly) return null;
  const linked = visions.filter((v) => isVisionLinkedToAnomaly(v, anomaly));
  if (linked.length === 0) return null;
  return [...linked].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

/**
 * Rol de la fotografía respecto al incidente. Lo calcula el servidor comparando categorías;
 * un LLM aporta la categoría visual, nunca el veredicto de concordancia.
 */
export function visionRoleForAnomaly(
  vision: Pick<VisionAnalysisResult, 'analysisStatus' | 'visualCategory'> | null | undefined,
  anomaly: Pick<AnomalyEvent, 'category'>
): VisionEvidenceRole {
  if (!vision || vision.analysisStatus !== 'analyzed') return 'not_analyzed';
  const cat = vision.visualCategory;
  if (!cat || cat === 'inconclusive' || cat === 'nominal') return 'inconclusive';
  return cat === anomaly.category ? 'confirmatory' : 'contradictory';
}
