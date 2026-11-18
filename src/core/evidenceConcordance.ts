import { LeakForensicsReport } from './leakForensics';
import { AnomalyEvent, VisionAnalysisResult } from './types';

/**
 * REQ-AI-02: Concordancia multimodal explícita entre sensores, fotografía y topología.
 * La foto no "suma confianza" por defecto: si contradice a los sensores se reporta el conflicto
 * y se limita la confianza calibrada del diagnóstico.
 */

export type ChannelVerdict = 'supports' | 'contradicts' | 'neutral' | 'missing';

export interface ConcordanceChannel {
  channel: 'sensores' | 'fotografía' | 'topología';
  verdict: ChannelVerdict;
  detail: string;
}

export interface ConcordanceReport {
  status: 'concordant' | 'partial' | 'conflict' | 'sensor_only';
  score: number;
  channels: ConcordanceChannel[];
  confidenceCapPct: number;
  statement: string;
}

export function evaluateConcordance(input: {
  anomaly: AnomalyEvent;
  vision?: VisionAnalysisResult | null;
  forensics?: LeakForensicsReport | null;
}): ConcordanceReport {
  const { anomaly, vision, forensics } = input;
  const channels: ConcordanceChannel[] = [];

  channels.push({
    channel: 'sensores',
    verdict: 'supports',
    detail: `${anomaly.rulesTriggered.length} regla(s) determinista(s) respaldan "${anomaly.category}".`,
  });

  // Fotografía
  if (!vision) {
    channels.push({ channel: 'fotografía', verdict: 'missing', detail: 'No hay evidencia fotográfica asociada al nodo.' });
  } else if (!vision.visualCategory || vision.visualCategory === 'inconclusive') {
    channels.push({
      channel: 'fotografía',
      verdict: 'neutral',
      detail: 'La imagen no discrimina por sí sola una categoría (sin visión IA o sin hallazgo concluyente).',
    });
  } else if (vision.visualCategory === anomaly.category) {
    channels.push({
      channel: 'fotografía',
      verdict: 'supports',
      detail: `La imagen es compatible con "${anomaly.category}".`,
    });
  } else {
    channels.push({
      channel: 'fotografía',
      verdict: 'contradicts',
      detail: `Los sensores indican "${anomaly.category}" pero la imagen sugiere "${vision.visualCategory}".${
        anomaly.category === 'sensor_fault' && vision.visualCategory === 'leak'
          ? ' No descartar una fuga real aunque la lectura parezca físicamente imposible.'
          : ''
      }`,
    });
  }

  // Topología
  if (anomaly.category === 'leak') {
    if (!forensics) {
      channels.push({ channel: 'topología', verdict: 'missing', detail: 'Sin balance hidráulico calculado.' });
    } else if (forensics.detected) {
      const s = forensics.suspects[0];
      channels.push({
        channel: 'topología',
        verdict: 'supports',
        detail: `Balance de masa entre medidores indica pérdida de ${forensics.estimatedLossLs} L/s; tramo sospechoso ${s?.pipeId ?? 'n/d'}.`,
      });
    } else {
      channels.push({
        channel: 'topología',
        verdict: 'neutral',
        detail: 'Los medidores vecinos no muestran desbalance de masa; la fuga no está corroborada por la red.',
      });
    }
  } else if (anomaly.category === 'contamination' || anomaly.category === 'quality_drift') {
    const exposed = anomaly.downstreamPopulationAffected ?? 0;
    channels.push({
      channel: 'topología',
      verdict: anomaly.downstreamAffectedNodeIds?.length ? 'supports' : 'neutral',
      detail: anomaly.downstreamAffectedNodeIds?.length
        ? `El riesgo se propaga aguas abajo a ${anomaly.downstreamAffectedNodeIds.length} nodo(s), ${exposed} hab. expuestos.`
        : 'Nodo terminal: sin propagación aguas abajo.',
    });
  } else if (anomaly.category === 'sensor_fault') {
    channels.push({
      channel: 'topología',
      verdict: 'neutral',
      detail: 'Una falla de instrumentación no se propaga hidráulicamente.',
    });
  } else {
    channels.push({
      channel: 'topología',
      verdict: anomaly.downstreamAffectedNodeIds?.length ? 'supports' : 'neutral',
      detail: anomaly.downstreamAffectedNodeIds?.length
        ? `Déficit propagado a ${anomaly.downstreamAffectedNodeIds.length} nodo(s) aguas abajo.`
        : 'Sin nodos aguas abajo.',
    });
  }

  const photo = channels.find((c) => c.channel === 'fotografía')!;
  const topo = channels.find((c) => c.channel === 'topología')!;
  const hasConflict = channels.some((c) => c.verdict === 'contradicts');
  const supportingExtra = [photo, topo].filter((c) => c.verdict === 'supports').length;

  let score = 40;
  if (photo.verdict === 'supports') score += 35;
  if (photo.verdict === 'contradicts') score -= 25;
  if (topo.verdict === 'supports') score += 25;
  score = Math.max(0, Math.min(100, score));

  let status: ConcordanceReport['status'];
  let confidenceCapPct: number;
  let statement: string;
  if (hasConflict) {
    status = 'conflict';
    confidenceCapPct = 55;
    statement = 'Hay canales en conflicto: la confianza se limita a 55% hasta resolver la contradicción en campo.';
  } else if (supportingExtra >= 2) {
    status = 'concordant';
    confidenceCapPct = 95;
    statement = 'Sensores, fotografía y topología coinciden.';
  } else if (supportingExtra === 1) {
    status = 'partial';
    confidenceCapPct = 82;
    statement = 'Un canal adicional respalda a los sensores; falta corroboración del resto.';
  } else {
    status = 'sensor_only';
    confidenceCapPct = 70;
    statement = 'Solo los sensores respaldan la hipótesis; la confianza se limita a 70%.';
  }

  return { status, score, channels, confidenceCapPct, statement };
}

export function calibratedConfidence(confidencePct: number, report: ConcordanceReport): number {
  return Math.min(confidencePct, report.confidenceCapPct);
}

