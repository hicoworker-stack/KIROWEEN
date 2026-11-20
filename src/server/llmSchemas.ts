import { AnomalyCategory } from '../core/types';

/**
 * REQ-AI-03: validación estricta de la salida del LLM.
 * Una respuesta vacía, incompleta o con tipos distintos NUNCA se acepta ni se completa con valores por defecto
 * (antes `{}` producía un diagnóstico "live" con confianza 75% inventada y `observed.join` reventaba con otro tipo).
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Limpia texto procedente del LLM: sin caracteres de control ni etiquetas HTML, espacios colapsados. */
export function cleanLlmText(s: string): string {
  return s
    .replace(CONTROL_CHARS, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto que no controlamos (descripciones de reportes, títulos): se acota antes de entrar en un prompt. */
export function sanitizeUntrusted(text: unknown, max = 300): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return cleanLlmText(s).replace(/[`{}[\]]/g, '').slice(0, max);
}

export function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : t;
}

const PLACEHOLDERS = new Set(['string', 'null', 'undefined', 'n/a', 'na', 'none', 'ninguno', '...']);

function text(v: unknown, field: string, min = 5, max = 800): ParseResult<string> {
  if (typeof v !== 'string') return { ok: false, reason: `${field}: se esperaba texto (llegó ${v === null ? 'null' : typeof v}).` };
  const c = cleanLlmText(v);
  if (c.length < min) return { ok: false, reason: `${field}: demasiado corto o vacío.` };
  if (c.length > max) return { ok: false, reason: `${field}: supera ${max} caracteres.` };
  if (PLACEHOLDERS.has(c.toLowerCase())) return { ok: false, reason: `${field}: valor de relleno.` };
  return { ok: true, value: c };
}

function list(v: unknown, field: string, minItems: number, maxItems: number, minLen = 3, maxLen = 400): ParseResult<string[]> {
  if (!Array.isArray(v)) return { ok: false, reason: `${field}: se esperaba una lista (llegó ${typeof v}).` };
  if (v.length < minItems || v.length > maxItems) return { ok: false, reason: `${field}: debe tener entre ${minItems} y ${maxItems} elementos (tiene ${v.length}).` };
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = text(v[i], `${field}[${i}]`, minLen, maxLen);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
}

function parseObject(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'Respuesta vacía.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, reason: 'La respuesta no es JSON válido.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'La respuesta JSON no es un objeto.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface LlmDiagnosisFields {
  detectedProblem: string;
  primaryHypothesis: string;
  alternativeHypotheses: Array<{
    title: string;
    likelihood: 'Alta' | 'Media' | 'Baja';
    supportingEvidence: string;
    contradictingOrMissing: string;
  }>;
  uncertaintyStatement: string;
  missingData: string[];
  potentialImpact: string;
  recommendedAction: string;
  requiredResources: string[];
  interventionSteps: string[];
}

const LIKELIHOODS = ['Alta', 'Media', 'Baja'] as const;

export function parseDiagnosisResponse(raw: unknown): ParseResult<LlmDiagnosisFields> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const o = obj.value;

  const fields = {
    detectedProblem: text(o.detectedProblem, 'detectedProblem'),
    primaryHypothesis: text(o.primaryHypothesis, 'primaryHypothesis'),
    uncertaintyStatement: text(o.uncertaintyStatement, 'uncertaintyStatement'),
    potentialImpact: text(o.potentialImpact, 'potentialImpact'),
    recommendedAction: text(o.recommendedAction, 'recommendedAction'),
    missingData: list(o.missingData, 'missingData', 1, 10),
    requiredResources: list(o.requiredResources, 'requiredResources', 1, 10),
    interventionSteps: list(o.interventionSteps, 'interventionSteps', 1, 12, 5),
  };
  for (const r of Object.values(fields)) if (!r.ok) return r;

  if (!Array.isArray(o.alternativeHypotheses) || o.alternativeHypotheses.length < 1 || o.alternativeHypotheses.length > 5) {
    return { ok: false, reason: 'alternativeHypotheses: se esperaba una lista de 1 a 5 hipótesis.' };
  }
  const alts: LlmDiagnosisFields['alternativeHypotheses'] = [];
  for (let i = 0; i < o.alternativeHypotheses.length; i++) {
    const a = o.alternativeHypotheses[i] as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, reason: `alternativeHypotheses[${i}]: se esperaba un objeto.` };
    const title = text(a.title, `alternativeHypotheses[${i}].title`);
    const sup = text(a.supportingEvidence, `alternativeHypotheses[${i}].supportingEvidence`);
    const con = text(a.contradictingOrMissing, `alternativeHypotheses[${i}].contradictingOrMissing`);
    if (!title.ok) return title;
    if (!sup.ok) return sup;
    if (!con.ok) return con;
    if (typeof a.likelihood !== 'string' || !(LIKELIHOODS as readonly string[]).includes(a.likelihood)) {
      return { ok: false, reason: `alternativeHypotheses[${i}].likelihood: debe ser Alta, Media o Baja.` };
    }
    alts.push({ title: title.value, likelihood: a.likelihood as 'Alta' | 'Media' | 'Baja', supportingEvidence: sup.value, contradictingOrMissing: con.value });
  }

  return {
    ok: true,
    value: {
      detectedProblem: (fields.detectedProblem as { value: string }).value,
      primaryHypothesis: (fields.primaryHypothesis as { value: string }).value,
      alternativeHypotheses: alts,
      uncertaintyStatement: (fields.uncertaintyStatement as { value: string }).value,
      missingData: (fields.missingData as { value: string[] }).value,
      potentialImpact: (fields.potentialImpact as { value: string }).value,
      recommendedAction: (fields.recommendedAction as { value: string }).value,
      requiredResources: (fields.requiredResources as { value: string[] }).value,
      interventionSteps: (fields.interventionSteps as { value: string[] }).value,
    },
  };
}

export const VISUAL_CATEGORIES = ['leak', 'obstruction', 'contamination', 'sensor_fault', 'quality_drift', 'nominal', 'inconclusive'] as const;
export type VisualCategory = (typeof VISUAL_CATEGORIES)[number];

export interface LlmVisionFields {
  observed: string[];
  cannotDetermine: string[];
  missingData: string[];
  visualCategory: AnomalyCategory | 'inconclusive';
  imageQuality: 'adecuada' | 'deficiente';
}

export function parseVisionResponse(raw: unknown): ParseResult<LlmVisionFields> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const o = obj.value;
  if (typeof o.visualCategory !== 'string' || !(VISUAL_CATEGORIES as readonly string[]).includes(o.visualCategory)) {
    return { ok: false, reason: 'visualCategory: valor fuera del conjunto permitido.' };
  }
  if (o.imageQuality !== 'adecuada' && o.imageQuality !== 'deficiente') {
    return { ok: false, reason: 'imageQuality: debe ser adecuada o deficiente.' };
  }
  const observed = list(o.observed, 'observed', 1, 10, 3, 300);
  const cannot = list(o.cannotDetermine, 'cannotDetermine', 1, 8, 3, 300);
  const missing = list(o.missingData, 'missingData', 0, 8, 3, 300);
  if (!observed.ok) return observed;
  if (!cannot.ok) return cannot;
  if (!missing.ok) return missing;
  // Una imagen deficiente nunca puede sostener una categoría.
  const category = o.imageQuality === 'deficiente' ? 'inconclusive' : (o.visualCategory as VisualCategory);
  return {
    ok: true,
    value: {
      observed: observed.value,
      cannotDetermine: cannot.value,
      missingData: missing.value,
      visualCategory: category as AnomalyCategory | 'inconclusive',
      imageQuality: o.imageQuality,
    },
  };
}
