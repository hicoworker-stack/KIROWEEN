import { visionRoleForAnomaly } from './evidenceLinking';
import { AnomalyEvent, EvidenceLevel, VisionAnalysisResult } from './types';

/**
 * REQ-AI-07: concordancia entre canales de evidencia, sin porcentajes.
 *
 * Antes se mostraban "confianza calibrada" y puntajes 0-100 con topes (55/70/82/95) sin ninguna calibración.
 * Ahora se informa un NIVEL CUALITATIVO de respaldo, derivado solo de cuántos canales distintos del propio sensor
 * coinciden, y del conflicto cuando alguno contradice:
 *   baja         solo el detector sobre los sensores respalda la hipótesis
 *   media        un canal adicional coincide (balance hidráulico corroborado, o fotografía analizada que confirma)
 *   alta         ambos canales adicionales coinciden
 *   en_conflicto un canal analizado contradice la hipótesis: se reporta, no se promedia
 *
 * El nivel NO es una probabilidad. El balance hidráulico usa los mismos medidores de caudal, así que no es
 * independiente de los sensores en sentido estricto; se cuenta aparte porque aplica una ley física distinta
 * (conservación de masa + coherencia presión-caudal). La fotografía solo cuenta si un proveedor de visión
 * la analizó realmente y está vinculada a ESTE incidente.
 */

export type ChannelVerdict = 'supports' | 'contradicts' | 'neutral' | 'missing';

export interface ConcordanceChannel {
  /** "reporte" es un reporte de campo DECLARADO por una persona: nunca se cuenta como "sensores" (corrección de F1). */
  channel: 'sensores' | 'reporte' | 'hidráulica' | 'fotografía';
  verdict: ChannelVerdict;
  detail: string;
}

export interface ConcordanceReport {
  level: EvidenceLevel;
  channels: ConcordanceChannel[];
  statement: string;
  basis: string[];
}

/** Subconjunto estructural del diagnóstico hidráulico que necesita la concordancia. */
export interface HydraulicEvidence {
  level: 'insufficient_data' | 'no_anomaly' | 'flow_anomaly' | 'possible_leak' | 'localized_leak';
  excessLs?: number;
  sigmaLs?: number;
  /** Tramos candidatos, p. ej. ["P-05"]. */
  candidatePipeIds?: string[];
  limits?: string[];
}

export function evaluateConcordance(input: {
  anomaly: Pick<AnomalyEvent, 'category' | 'rulesTriggered'> & Partial<Pick<AnomalyEvent, 'origin'>>;
  vision?: VisionAnalysisResult | null;
  hydraulic?: HydraulicEvidence | null;
}): ConcordanceReport {
  const { anomaly, vision, hydraulic } = input;
  const channels: ConcordanceChannel[] = [];
  const declared = anomaly.origin === 'offline-report';

  // F1 corregido: el canal de origen de un reporte de campo es la palabra de una persona, no una lectura de sensor.
  channels.push(
    declared
      ? { channel: 'reporte', verdict: 'supports', detail: `Una persona reportó "${anomaly.category}" en campo. Es un dato declarado: ningún sensor lo confirma.` }
      : { channel: 'sensores', verdict: 'supports', detail: `${anomaly.rulesTriggered.length} regla(s) determinista(s) respaldan "${anomaly.category}".` },
  );
  const origin = declared ? 'el reporte declarado' : 'los sensores';

  // Hidráulica: solo aplica a la hipótesis de fuga.
  if (anomaly.category !== 'leak') {
    channels.push({ channel: 'hidráulica', verdict: 'missing', detail: 'El balance hidráulico no aplica a esta categoría.' });
  } else if (!hydraulic) {
    channels.push({ channel: 'hidráulica', verdict: 'missing', detail: 'No se calculó el balance hidráulico.' });
  } else if (hydraulic.level === 'possible_leak' || hydraulic.level === 'localized_leak') {
    const where = hydraulic.candidatePipeIds?.length ? ` Tramo(s) candidato(s): ${hydraulic.candidatePipeIds.join(', ')}.` : '';
    channels.push({
      channel: 'hidráulica',
      verdict: 'supports',
      detail: `Exceso de caudal de ${hydraulic.excessLs ?? '?'} L/s (±${hydraulic.sigmaLs ?? '?'}) corroborado por la respuesta de presión (${hydraulic.level === 'localized_leak' ? 'localizada' : 'posible fuga'}).${where}`,
    });
  } else if (hydraulic.level === 'flow_anomaly') {
    channels.push({
      channel: 'hidráulica',
      verdict: 'neutral',
      detail: 'Hay una anomalía de caudal, pero la presión no la corrobora o no es evaluable: puede ser deriva de medidor o demanda no uniforme.',
    });
  } else {
    channels.push({
      channel: 'hidráulica',
      verdict: 'neutral',
      detail:
        hydraulic.level === 'insufficient_data'
          ? 'Datos insuficientes para evaluar el balance; no corrobora ni descarta.'
          : 'El balance no muestra un exceso de caudal significativo; una fuga pequeña puede estar por debajo del límite de detección.',
    });
  }

  // Fotografía: solo cuenta si fue analizada y está vinculada a este incidente (el llamador pasa la ya vinculada).
  const role = visionRoleForAnomaly(vision, anomaly);
  if (!vision) {
    channels.push({ channel: 'fotografía', verdict: 'missing', detail: 'No hay fotografía vinculada a este incidente.' });
  } else if (role === 'not_analyzed') {
    channels.push({
      channel: 'fotografía',
      verdict: 'missing',
      detail: 'Hay una fotografía vinculada pero ningún proveedor de visión la analizó: no se usa como evidencia.',
    });
  } else if (role === 'inconclusive') {
    channels.push({ channel: 'fotografía', verdict: 'neutral', detail: 'La imagen fue analizada y no discrimina una categoría.' });
  } else if (role === 'confirmatory') {
    channels.push({ channel: 'fotografía', verdict: 'supports', detail: `La imagen analizada es compatible con "${anomaly.category}".` });
  } else {
    channels.push({
      channel: 'fotografía',
      verdict: 'contradicts',
      detail: `Los sensores indican "${anomaly.category}" pero la imagen analizada sugiere "${vision.visualCategory}".${
        anomaly.category === 'sensor_fault' && vision.visualCategory === 'leak'
          ? ' No descartar una fuga real aunque la lectura parezca físicamente imposible.'
          : ''
      }`,
    });
  }

  const hydro = channels.find((c) => c.channel === 'hidráulica')!;
  const photo = channels.find((c) => c.channel === 'fotografía')!;
  const conflict = channels.some((c) => c.verdict === 'contradicts');
  const extra = [hydro, photo].filter((c) => c.verdict === 'supports').length;

  let level: EvidenceLevel;
  let statement: string;
  if (conflict) {
    level = 'en_conflicto';
    statement = 'Un canal analizado contradice la hipótesis: resolver la contradicción en campo antes de actuar.';
  } else if (extra === 2) {
    level = 'alta';
    statement = `El balance hidráulico y la fotografía analizada coinciden con ${origin}.`;
  } else if (extra === 1) {
    level = 'media';
    statement = `Un canal adicional coincide con ${origin}; falta corroboración del otro.`;
  } else {
    level = 'baja';
    statement = declared
      ? 'Solo un reporte declarado por una persona respalda la hipótesis; ningún sensor ni otro canal lo confirma.'
      : 'Solo el detector sobre los sensores respalda la hipótesis.';
  }

  const basis = channels.filter((c) => c.verdict === 'supports').map((c) => c.channel);
  return { level, channels, statement, basis };
}

export const EVIDENCE_LEVEL_LABEL: Record<EvidenceLevel, string> = {
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
  en_conflicto: 'En conflicto',
};
