import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AIFallbackReason,
  AnomalyCategory,
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  VisionAnalysisResult,
} from '../core/types';

export const DEFAULT_GEMINI_TIMEOUT_MS = 25000;
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export interface GeminiHealth {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}
const geminiHealth: GeminiHealth = { lastSuccessAt: null, lastErrorAt: null, lastError: null };

export function recordGeminiOutcome(err?: unknown): void {
  if (err === undefined) {
    geminiHealth.lastSuccessAt = new Date().toISOString();
    return;
  }
  geminiHealth.lastErrorAt = new Date().toISOString();
  geminiHealth.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 240);
}

export function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(msg);
}

/** Runs a Gemini call with one retry on transient errors (429/5xx). Timeouts are not retried. */
export async function withGeminiRetry<T>(fn: () => Promise<T>, delayMs = 800): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryableGeminiError(err)) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function classifyFallbackReason(err: unknown): AIFallbackReason {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes('timeout')) return 'timeout';
  return 'api_error';
}

export function formatFallbackProviderLabel(
  scope: 'vision' | 'diagnosis',
  reason: AIFallbackReason,
  isProvisional = false
): string {
  if (isProvisional) {
    return 'Evaluación Determinista Inmediata (Enriqueciendo con Gemini...)';
  }
  const prefix =
    scope === 'vision' ? 'Adaptador de Respaldo Multimodal' : 'Motor Híbrido + Adaptador de Respaldo';
  switch (reason) {
    case 'missing_key':
      return `${prefix} (Sin API Key)`;
    case 'timeout':
      return `${prefix} (Timeout Gemini API)`;
    case 'api_error':
      return `${prefix} (Error Gemini API)`;
    case 'no_image':
      return `${prefix} (Sin imagen válida)`;
  }
}

export interface VisionAnalyzeInput {
  node: NetworkNode;
  imageUrl: string;
  imageTitle: string;
  imageBase64?: string;
  imageMimeType?: string;
  activeAnomaly?: AnomalyEvent | null;
}

export interface DiagnoseInput {
  anomaly: AnomalyEvent;
  node: NetworkNode;
  visionAnalysis?: VisionAnalysisResult | null;
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function resolveLocalImageAsBase64(imageUrl: string): { base64: string; mimeType: string } | null {
  if (!imageUrl.startsWith('/src/assets/images/')) {
    return null;
  }
  const safeRel = imageUrl.replace(/^\/+/, '');
  const fullPath = path.resolve(process.cwd(), safeRel);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  const buffer = fs.readFileSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { base64: buffer.toString('base64'), mimeType };
}

export function getProviderStatus() {
  const hasGemini = Boolean(getGeminiClient());
  const model = getGeminiModel();
  const verified = Boolean(geminiHealth.lastSuccessAt) && (!geminiHealth.lastErrorAt || geminiHealth.lastSuccessAt! >= geminiHealth.lastErrorAt);
  return {
    aiProvider: hasGemini
      ? `Gemini ${model} (clave configurada · ${verified ? 'verificado en vivo' : 'aún sin verificar'})`
      : 'Adaptador de Respaldo Determinista (sin GEMINI_API_KEY)',
    aiMode: hasGemini ? ('gemini-live' as const) : ('fallback-adapter' as const),
    geminiModel: model,
    geminiHealth: { ...geminiHealth, verified },
    // Honestidad: ninguno de estos es un servicio AWS real. Son adaptadores locales.
    awsAdapters: {
      s3: 'SIMULADO · almacenamiento local del servidor (sin AWS S3)',
      lambda: 'SIMULADO · rutas Express locales (sin AWS Lambda)',
      dynamodb: 'SIMULADO · archivo JSON local + IndexedDB offline (sin AWS DynamoDB)',
      bedrock: 'NO CONFIGURADO · se usa Gemini o el adaptador determinista',
    },
  };
}

/** Probe real a Gemini con una llamada mínima. Nunca lanza: devuelve el resultado honesto. */
export async function probeGemini(): Promise<{
  configured: boolean;
  ok: boolean;
  model: string;
  latencyMs?: number;
  error?: string;
}> {
  const model = getGeminiModel();
  const client = getGeminiClient();
  if (!client) return { configured: false, ok: false, model, error: 'GEMINI_API_KEY ausente o con valor de ejemplo.' };
  const t0 = Date.now();
  try {
    await withTimeout(
      withGeminiRetry(() => client.models.generateContent({ model, contents: 'Responde solo: ok' })),
      DEFAULT_GEMINI_TIMEOUT_MS,
      'Gemini probe'
    );
    recordGeminiOutcome();
    return { configured: true, ok: true, model, latencyMs: Date.now() - t0 };
  } catch (err) {
    recordGeminiOutcome(err);
    return { configured: true, ok: false, model, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 240) : String(err) };
  }
}
export async function analyzeVisionEvidence(
  input: VisionAnalyzeInput
): Promise<VisionAnalysisResult> {
  const client = getGeminiClient();
  const timestamp = new Date().toISOString();

  let base64Data = input.imageBase64;
  let mimeType = input.imageMimeType ?? 'image/jpeg';

  if (!base64Data && input.imageUrl.startsWith('data:')) {
    const match = input.imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    }
  } else if (!base64Data) {
    const local = resolveLocalImageAsBase64(input.imageUrl);
    if (local) {
      base64Data = local.base64;
      mimeType = local.mimeType;
    }
  }

  if (client && base64Data) {
    try {
      const sensorContext = `Nodo: ${input.node.name} (${input.node.id}), Sector: ${input.node.sector}, Material: ${input.node.material}.
Lecturas actuales (sintéticas): Presión=${input.node.current.pressureBar} bar (base ${input.node.baseline.pressureBar}), Caudal=${input.node.current.flowLs} L/s (base ${input.node.baseline.flowLs}), Turbidez=${input.node.current.turbidityNtu} NTU (base ${input.node.baseline.turbidityNtu}), Cloro=${input.node.current.chlorineMgL} mg/L, pH=${input.node.current.ph}.
Anomalía determinista activa: ${input.activeAnomaly ? input.activeAnomaly.title : 'Ninguna activa actualmente'}.`;

      const response = await withTimeout(
        withGeminiRetry(() => client.models.generateContent({
          model: getGeminiModel(),
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
              {
                text: `Analiza esta fotografía de infraestructura hídrica comunitaria en español técnico claro.\n${sensorContext}`,
              },
            ],
          },
          config: {
            systemInstruction:
              'Eres el módulo de visión artificial de Aqua Sentinel. Reglas estrictas: 1) Nunca inventes mediciones numéricas que no estén en el contexto. 2) Nunca confirmes contaminación química o bacteriológica únicamente por una fotografía. 3) Separa claramente hechos observables en la imagen, inferencias operativas al cruzar con sensores, y qué NO puede determinarse solo visualmente.',
            responseMimeType: 'application/json',
            responseSchema: {
            type: Type.OBJECT,
            properties: {
              observed: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Lista de observaciones visuales directas en la imagen.',
              },
              inferred: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Inferencias operativas al cruzar la imagen con la telemetría del nodo.',
              },
              cannotDetermine: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Aspectos que NO pueden confirmarse solo con la fotografía.',
              },
              missingData: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Pruebas o mediciones faltantes para confirmación total.',
              },
              sensorCorrelationSummary: {
                type: Type.STRING,
                description: 'Resumen breve en 1-2 frases de la correlación imagen-sensor.',
              },
              confidenceLabel: {
                type: Type.STRING,
                description: 'Nivel de confianza cualitativo calibrado (ej. Moderado-Alto 78%).',
              },
              visualCategory: {
                type: Type.STRING,
                enum: ['leak', 'obstruction', 'contamination', 'sensor_fault', 'quality_drift', 'nominal', 'inconclusive'],
                description: 'Categoría que la imagen respalda por sí sola. Usa inconclusive si no discrimina.',
              },
            },
            required: [
              'observed',
              'inferred',
              'cannotDetermine',
              'missingData',
              'sensorCorrelationSummary',
              'confidenceLabel',
            ],
          },
        },
        })),
        DEFAULT_GEMINI_TIMEOUT_MS,
        'Vision analyze'
      );

      recordGeminiOutcome();

      const raw = (response.text ?? '{}').trim();
      const parsed = JSON.parse(raw) as {
        observed: string[];
        inferred: string[];
        cannotDetermine: string[];
        missingData: string[];
        sensorCorrelationSummary: string;
        confidenceLabel: string;
        visualCategory?: string;
      };

      return {
        id: `VIS-${Date.now().toString(36).toUpperCase()}`,
        timestamp,
        nodeId: input.node.id,
        imageUrl: input.imageUrl,
        imageTitle: input.imageTitle,
        providerUsed: `Gemini ${getGeminiModel()} (Multimodal)`,
        providerMode: 'gemini-live',
        enrichmentStatus: 'live',
        observed: parsed.observed ?? [],
        inferred: parsed.inferred ?? [],
        cannotDetermine: parsed.cannotDetermine ?? [],
        missingData: parsed.missingData ?? [],
        sensorCorrelationSummary: parsed.sensorCorrelationSummary ?? '',
        confidenceLabel: parsed.confidenceLabel ?? 'Calibrada',
        visualCategory: normalizeVisualCategory(parsed.visualCategory),
      };
    } catch (err) {
      recordGeminiOutcome(err);
      const reason = classifyFallbackReason(err);
      console.warn('Gemini multimodal fallback triggered:', err instanceof Error ? err.message : err);
      return buildFallbackVisionAnalysis(input, timestamp, { reason });
    }
  }

  return buildFallbackVisionAnalysis(input, timestamp, {
    reason: client ? 'no_image' : 'missing_key',
  });
}

const DEMO_IMAGE_NOTE =
  'Anotación predefinida de una imagen de demostración incluida en el repositorio; no es análisis de píxeles en vivo.';
const NO_PIXEL_ANALYSIS_NOTE =
  'El adaptador de respaldo no analiza el contenido de la imagen; solo la registra como evidencia. Requiere Gemini multimodal o inspección humana.';

/** Solo las imágenes de demostración empaquetadas tienen anotación conocida. Las fotos del usuario nunca se "interpretan" sin visión real. */
export function demoImageCategory(
  input: Pick<VisionAnalyzeInput, 'imageUrl' | 'imageTitle'>
): AnomalyCategory | null {
  if (!input.imageUrl.startsWith('/src/assets/images/')) return null;
  const url = input.imageUrl.toLowerCase();
  if (url.includes('turbid')) return 'contamination';
  if (url.includes('corrosion') || url.includes('valve')) return 'obstruction';
  if (url.includes('leak')) return 'leak';
  return null;
}

export function buildFallbackVisionAnalysis(
  input: VisionAnalyzeInput,
  timestamp: string = new Date().toISOString(),
  options: { reason?: AIFallbackReason; provisional?: boolean; id?: string } = {}
): VisionAnalysisResult {
  const base = buildFallbackVisionAnalysisInner(input, timestamp, options);
  const cat = demoImageCategory(input);
  return cat
    ? { ...base, observed: [`[${DEMO_IMAGE_NOTE}]`, ...base.observed], visualCategory: cat }
    : {
        ...base,
        cannotDetermine: [NO_PIXEL_ANALYSIS_NOTE, ...base.cannotDetermine],
        visualCategory: 'inconclusive',
      };
}
function buildFallbackVisionAnalysisInner(
  input: VisionAnalyzeInput,
  timestamp: string = new Date().toISOString(),
  options: { reason?: AIFallbackReason; provisional?: boolean; id?: string } = {}
): VisionAnalysisResult {
  const reason: AIFallbackReason = options.reason ?? 'missing_key';
  const provisional = Boolean(options.provisional);
  const providerUsed = formatFallbackProviderLabel('vision', reason, provisional);
  const demoCategory = demoImageCategory(input);
  const isLeak = demoCategory === 'leak';
  const isTurbid = demoCategory === 'contamination';
  const isCorrosion = demoCategory === 'obstruction';

  if (isTurbid) {
    return {
      id: options.id ?? `VIS-${Date.now().toString(36).toUpperCase()}`,
      timestamp,
      nodeId: input.node.id,
      imageUrl: input.imageUrl,
      imageTitle: input.imageTitle,
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus: provisional ? 'pending' : 'fallback',
      fallbackReason: provisional ? undefined : reason,
      observed: [
        'Coloración marrón-ámbar en el flujo de entrada del canal de concreto y rejilla metálica.',
        'Alta carga aparente de sólidos suspendidos en superficie junto a la compuerta de captación.',
        'Oxidación superficial en la estructura metálica de la compuerta.',
      ],
      inferred: [
        `Consistente con el salto de turbidez medido en ${input.node.name} (${input.node.current.turbidityNtu} NTU vs ${input.node.baseline.turbidityNtu} NTU base) y la caída de cloro residual (${input.node.current.chlorineMgL} mg/L).`,
        'Posible evento de escorrentía o arrastre de sedimentos aguas arriba en la quebrada de captación.',
      ],
      cannotDetermine: [
        'La fotografía NO permite confirmar contaminación microbiológica (E. coli / coliformes) ni presencia de contaminantes químicos disueltos.',
        'No es posible determinar la concentración exacta de patógenos ni la toxicidad del agua mediante inspección visual.',
      ],
      missingData: [
        'Muestra de laboratorio microbiológico y perfil de metales/pesticidas.',
        'Inspección aguas arriba de la quebrada y verificación de dosificación de coagulante en PTAP.',
      ],
      sensorCorrelationSummary:
        'La evidencia visual de turbidez refuerza la alerta determinista de calidad, pero requiere aislamiento preventivo y análisis de laboratorio antes de emitir veredicto sanitario.',
      confidenceLabel: 'Moderada-Alta (79%) — Sujeta a muestreo de laboratorio',
    };
  }

  if (isCorrosion) {
    return {
      id: options.id ?? `VIS-${Date.now().toString(36).toUpperCase()}`,
      timestamp,
      nodeId: input.node.id,
      imageUrl: input.imageUrl,
      imageTitle: input.imageTitle,
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus: provisional ? 'pending' : 'fallback',
      fallbackReason: provisional ? undefined : reason,
      observed: [
        'Válvula de compuerta de hierro fundido con oxidación avanzada e incrustaciones calcáreas en vástago y brida.',
        'Humedad activa y goteo lento en el múltiple del manómetro de presión.',
        'Manómetro analógico cercano con condensación interna.',
      ],
      inferred: [
        `Correlaciona con el estrangulamiento hidráulico en ${input.node.name}: caudal reducido a ${input.node.current.flowLs} L/s y contrapresión de ${input.node.current.pressureBar} bar.`,
        'Probable atascamiento parcial del disco de compuerta o acumulación interna de sarro/sedimento.',
      ],
      cannotDetermine: [
        'No se puede observar el porcentaje exacto de cierre interno de la compuerta desde el exterior.',
        'No es posible evaluar el espesor remanente de pared metálica sin ultrasonido.',
      ],
      missingData: [
        'Prueba de torque de apertura/cierre manual de la válvula.',
        'Medición de presión diferencial exacta aguas arriba y aguas abajo del accesorio.',
      ],
      sensorCorrelationSummary:
        'El deterioro mecánico observado en cámara explica la caída de caudal y sobrepresión previa detectadas por el motor determinista.',
      confidenceLabel: 'Alta (84%) — Obstrucción mecánica probable',
    };
  }

  if (isLeak) {
    return {
      id: options.id ?? `VIS-${Date.now().toString(36).toUpperCase()}`,
      timestamp,
      nodeId: input.node.id,
      imageUrl: input.imageUrl,
      imageTitle: input.imageTitle,
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus: provisional ? 'pending' : 'fallback',
      fallbackReason: provisional ? undefined : reason,
      observed: [
        'Chorro presurizado de agua clara saliendo lateralmente desde una brida metálica acoplada a tubería PVC gris.',
        'Fisura longitudinal visible en el tramo de tubería PVC adyacente al collarín.',
        'Saturación hídrica del suelo y grava en el fondo de la cámara excavada.',
      ],
      inferred: [
        `Coincide con la caída abrupta de presión en ${input.node.name} (${input.node.current.pressureBar} bar vs ${input.node.baseline.pressureBar} bar base) y el exceso de caudal (${input.node.current.flowLs} L/s).`,
        'Falla estructural de empaquetadura o fractura por fatiga/sobrepresión en unión PVC-brida.',
      ],
      cannotDetermine: [
        'No se puede medir el volumen exacto fugado en L/s únicamente a partir de la imagen.',
        'No es visible si existen microfisuras adicionales enterradas más allá del perímetro excavado.',
      ],
      missingData: [
        'Lectura acústica en los 50 m aguas abajo tras cierre parcial de seccionamiento.',
        'Verificación de torque en pernos de brida y presión estática tras aislamiento.',
      ],
      sensorCorrelationSummary:
        'Evidencia visual directa de descarga presurizada altamente consistente con la caída de presión y divergencia de caudal.',
      confidenceLabel: 'Alta (91%) — Evidencia visual y de presión concordantes',
    };
  }

  return {
    id: options.id ?? `VIS-${Date.now().toString(36).toUpperCase()}`,
    timestamp,
    nodeId: input.node.id,
    imageUrl: input.imageUrl,
    imageTitle: input.imageTitle,
    providerUsed,
    providerMode: 'fallback-adapter',
    enrichmentStatus: provisional ? 'pending' : 'fallback',
    fallbackReason: provisional ? undefined : reason,
    observed: [
      'Fotografía de infraestructura hídrica cargada para inspección en nodo seleccionado.',
      'Superficies estructurales visibles sin confirmación automática de falla interna.',
    ],
    inferred: [
      `Telemetría actual en ${input.node.name}: Presión ${input.node.current.pressureBar} bar, Caudal ${input.node.current.flowLs} L/s, Turbidez ${input.node.current.turbidityNtu} NTU.`,
    ],
    cannotDetermine: [
      'No es posible determinar integridad hidráulica interna o calidad química únicamente desde una imagen estática.',
    ],
    missingData: [
      'Inspección física dirigida en campo o prueba de presión/muestreo.',
    ],
    sensorCorrelationSummary:
      'Inspección visual registrada como evidencia adjunta al historial del nodo.',
    confidenceLabel: 'Baja-Moderada (58%) — Requiere validación en campo',
  };
}

export async function synthesizeDiagnosis(
  input: DiagnoseInput
): Promise<AquaBrainDiagnosis> {
  const client = getGeminiClient();
  const timestamp = new Date().toISOString();
  const rulesText = input.anomaly.rulesTriggered
    .map((r) => `- [${r.ruleId}] ${r.explanation} (Delta: ${r.deltaPct}%)`)
    .join('\n');

  const visionText = input.visionAnalysis
    ? `Observado en foto: ${input.visionAnalysis.observed.join('; ')}. No determinable: ${input.visionAnalysis.cannotDetermine.join('; ')}.`
    : 'No se adjuntó evidencia fotográfica para este incidente.';

  const hydraulicText = [
    input.anomaly.correlatedUpstreamNodeId
      ? `Nodo aguas arriba: ${input.anomaly.correlatedUpstreamNodeId}`
      : null,
    input.anomaly.downstreamAffectedNodeIds && input.anomaly.downstreamAffectedNodeIds.length > 0
      ? `Nodos aguas abajo expuestos (${input.anomaly.downstreamAffectedNodeIds.length}): ${input.anomaly.downstreamAffectedNodeIds.join(', ')} (población expuesta acumulada: ${input.anomaly.downstreamPopulationAffected ?? input.node.populationServed} hab.)`
      : null,
    typeof input.anomaly.massBalanceDeltaLs === 'number'
      ? `Desbalance hidráulico nodal: ${input.anomaly.massBalanceDeltaLs} L/s`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  if (client) {
    try {
      const response = await withTimeout(
        withGeminiRetry(() => client.models.generateContent({
          model: getGeminiModel(),
          contents: `Genera un diagnóstico operativo explicable para Aqua Brain en español.
Nodo: ${input.node.name} (${input.node.id}), Sector: ${input.node.sector}, Población servida: ${input.node.populationServed} habitantes, Activo: ${input.node.assetCode} (${input.node.material}, ${input.node.diameterMm} mm).
Prioridad determinista calculada: ${input.anomaly.priority.priority} (${input.anomaly.priority.totalScore}/100).
Reglas deterministas disparadas:\n${rulesText}
${hydraulicText ? `Topología hidráulica:\n${hydraulicText}\n` : ''}Evidencia visual:\n${visionText}`,
          config: {
            systemInstruction:
              'Eres Aqua Brain, agente de razonamiento operativo hídrico. Nunca contradigas ni re-calcules los datos medidos; explica hipótesis, causas alternativas, incertidumbre calibrada, datos faltantes y pasos concretos de intervención en campo.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                detectedProblem: { type: Type.STRING },
                primaryHypothesis: { type: Type.STRING },
                alternativeHypotheses: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      likelihood: { type: Type.STRING },
                      supportingEvidence: { type: Type.STRING },
                      contradictingOrMissing: { type: Type.STRING },
                    },
                    required: ['title', 'likelihood', 'supportingEvidence', 'contradictingOrMissing'],
                  },
                },
                confidencePct: { type: Type.NUMBER },
                uncertaintyStatement: { type: Type.STRING },
                missingData: { type: Type.ARRAY, items: { type: Type.STRING } },
                potentialImpact: { type: Type.STRING },
                recommendedAction: { type: Type.STRING },
                requiredResources: { type: Type.ARRAY, items: { type: Type.STRING } },
                interventionSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: [
                'detectedProblem',
                'primaryHypothesis',
                'alternativeHypotheses',
                'confidencePct',
                'uncertaintyStatement',
                'missingData',
                'potentialImpact',
                'recommendedAction',
                'requiredResources',
                'interventionSteps',
              ],
            },
          },
        })),
        DEFAULT_GEMINI_TIMEOUT_MS,
        'Diagnosis synthesis'
      );

      recordGeminiOutcome();

      const parsed = JSON.parse((response.text ?? '{}').trim());
      return {
        id: `DIAG-${Date.now().toString(36).toUpperCase()}`,
        anomalyId: input.anomaly.id,
        timestamp,
        nodeId: input.node.id,
        nodeName: input.node.name,
        detectedProblem: parsed.detectedProblem,
        availableEvidences: [
          ...input.anomaly.rulesTriggered.map((r) => r.explanation),
          ...(input.visionAnalysis ? [input.visionAnalysis.sensorCorrelationSummary] : []),
        ],
        primaryHypothesis: parsed.primaryHypothesis,
        alternativeHypotheses: parsed.alternativeHypotheses ?? [],
        confidencePct: Math.max(15, Math.min(95, Math.round(parsed.confidencePct ?? 75))),
        uncertaintyStatement: parsed.uncertaintyStatement,
        missingData: parsed.missingData ?? [],
        potentialImpact: parsed.potentialImpact,
        priority: input.anomaly.priority.priority,
        priorityScore: input.anomaly.priority.totalScore,
        recommendedAction: parsed.recommendedAction,
        requiredResources: parsed.requiredResources ?? [],
        interventionSteps: parsed.interventionSteps ?? [],
        operatorDecision: 'pending',
        providerUsed: `Gemini ${getGeminiModel()} (Razonamiento Operativo)`,
        providerMode: 'gemini-live',
        enrichmentStatus: 'live',
        visionAnalysisId: input.visionAnalysis?.id,
      };
    } catch (err) {
      recordGeminiOutcome(err);
      const reason = classifyFallbackReason(err);
      console.warn('Gemini diagnosis fallback triggered:', err instanceof Error ? err.message : err);
      return buildFallbackDiagnosis(input, timestamp, { reason });
    }
  }

  return buildFallbackDiagnosis(input, timestamp, { reason: 'missing_key' });
}

export function buildFallbackDiagnosis(
  input: DiagnoseInput,
  timestamp: string = new Date().toISOString(),
  options: { reason?: AIFallbackReason; provisional?: boolean; id?: string } = {}
): AquaBrainDiagnosis {
  const { anomaly, node, visionAnalysis } = input;
  const reason: AIFallbackReason = options.reason ?? 'missing_key';
  const provisional = Boolean(options.provisional);
  const providerUsed = formatFallbackProviderLabel('diagnosis', reason, provisional);
  const enrichmentStatus = provisional ? ('pending' as const) : ('fallback' as const);
  const fallbackReason = provisional ? undefined : reason;
  const diagId = options.id ?? `DIAG-${Date.now().toString(36).toUpperCase()}`;
  const evidences = [
    ...anomaly.rulesTriggered.map((r) => r.explanation),
    `Topología: ${node.name} abastece a ${node.populationServed.toLocaleString('es-ES')} habitantes en ${node.sector}.`,
    ...(anomaly.downstreamAffectedNodeIds && anomaly.downstreamAffectedNodeIds.length > 0
      ? [
          `Propagación en grafo hidráulico: ${anomaly.downstreamAffectedNodeIds.length} nodo(s) aguas abajo expuestos (${anomaly.downstreamAffectedNodeIds.join(', ')}) · población potencialmente impactada: ${(anomaly.downstreamPopulationAffected ?? node.populationServed).toLocaleString('es-ES')} hab.`,
        ]
      : []),
    ...(visionAnalysis
      ? [`Evidencia visual (${visionAnalysis.confidenceLabel}): ${visionAnalysis.sensorCorrelationSummary}`]
      : []),
  ];

  if (anomaly.category === 'leak') {
    return {
      id: diagId,
      anomalyId: anomaly.id,
      timestamp,
      nodeId: node.id,
      nodeName: node.name,
      detectedProblem: `Pérdida abrupta de carga hidráulica en ${node.name} con incremento simultáneo de caudal entrante.`,
      availableEvidences: evidences,
      primaryHypothesis:
        'Rotura o desacople parcial en brida/tubería PVC PN10 de la troncal principal generando fuga activa.',
      alternativeHypotheses: [
        {
          title: 'Apertura no autorizada de hidrante o toma clandestina',
          likelihood: 'Baja',
          supportingEvidence: 'Explica el aumento de caudal y caída de presión local.',
          contradictingOrMissing:
            visionAnalysis
              ? 'La fotografía muestra fractura física en brida PVC, reduciendo probabilidad de consumo no medido.'
              : 'Falta inspección visual en hidrantes del tramo.',
        },
        {
          title: 'Falla de calibración en transmisor de presión',
          likelihood: 'Baja',
          supportingEvidence: 'Podría explicar la caída de presión aislada.',
          contradictingOrMissing: 'El aumento concurrente de caudal (+29%) confirma pérdida real de masa.',
        },
      ],
      confidencePct: visionAnalysis ? 89 : 76,
      uncertaintyStatement:
        'Caudal fugado exacto estimado por balance diferencial; la extensión subterránea de la fisura requiere exposición completa.',
      missingData: [
        'Presión residual en nodos domiciliarios extremos del Sector Norte.',
        'Confirmación visual del estado de junta aguas abajo tras cierre parcial.',
      ],
      potentialImpact: `Desabastecimiento parcial para ${node.populationServed.toLocaleString('es-ES')} usuarios y riesgo de socavación en cámara de válvulas.`,
      priority: anomaly.priority.priority,
      priorityScore: anomaly.priority.totalScore,
      recommendedAction:
        'Aislar tramo Troncal Sector Norte mediante válvula de seccionamiento, despresurizar y ejecutar reemplazo de brida/carrete PVC 200 mm.',
      requiredResources: [
        'Cuadrilla hidráulica (2 técnicos)',
        'Carrete PVC PN10 200 mm + kit brida y empaquetadura EPDM',
        'Motobomba de achique y manómetro patrón portátil',
      ],
      interventionSteps: [
        'Cerrar parcialmente válvula de cabecera en Tanque Mirador y notificar al sector.',
        'Achicar cámara excavada y verificar longitud real de la fisura en PVC.',
        'Sustituir tramo fisurado y ajustar torque de brida en cruz.',
        'Purgar aire, presurizar gradualmente y verificar estabilidad de presión por 15 min.',
      ],
      operatorDecision: 'pending',
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus,
      fallbackReason,
      visionAnalysisId: visionAnalysis?.id,
    };
  }

  if (anomaly.category === 'obstruction') {
    return {
      id: diagId,
      anomalyId: anomaly.id,
      timestamp,
      nodeId: node.id,
      nodeName: node.name,
      detectedProblem: `Estrangulamiento de flujo en ${node.name} con caída de caudal y acumulación de contrapresión.`,
      availableEvidences: evidences,
      primaryHypothesis:
        'Obstrucción parcial por incrustación calcárea, corrosión severa o desplazamiento de compuerta en válvula de hierro fundido.',
      alternativeHypotheses: [
        {
          title: 'Bolsa de aire atrapada en punto alto del ramal',
          likelihood: 'Media',
          supportingEvidence: 'Reduce sección efectiva de paso y eleva presión previa.',
          contradictingOrMissing: 'La fotografía muestra oxidación severa e incrustaciones en el cuerpo de la válvula.',
        },
        {
          title: 'Cierre accidental de válvula por terceros',
          likelihood: 'Media',
          supportingEvidence: 'Produce exactamente caída de caudal + aumento de presión aguas arriba.',
          contradictingOrMissing: 'Requiere verificación física de posición del volante y número de vueltas.',
        },
      ],
      confidencePct: visionAnalysis ? 85 : 74,
      uncertaintyStatement:
        'El porcentaje exacto de obstrucción interna solo puede verificarse al desmontar o ejercitar la compuerta.',
      missingData: [
        'Registro de última maniobra preventiva en válvula ACT-VALV-055.',
        'Presión aguas abajo en Ramal Barrio La Esperanza.',
      ],
      potentialImpact: `Baja presión severa para ${node.populationServed.toLocaleString('es-ES')} habitantes del Sector Sur y riesgo de golpe de ariete si la compuerta colapsa.`,
      priority: anomaly.priority.priority,
      priorityScore: anomaly.priority.totalScore,
      recommendedAction:
        'Inspeccionar cámara Válvula Sur, purgar aire, limpiar incrustaciones y programar reemplazo o rehabilitación de compuerta.',
      requiredResources: [
        'Llave de válvula T + kit desincrustante mecánico',
        'Válvula de compuerta de respaldo 150 mm',
        'Registrador portátil de presión diferencial',
      ],
      interventionSteps: [
        'Medir presión con manómetro calibrado antes y después de la válvula.',
        'Realizar maniobra controlada de apertura/cierre verificando tope mecánico.',
        'Purgar cámara y limpiar depósito calcáreo/óxido en vástago.',
        'Evaluar reemplazo de cuerpo de válvula si persiste pérdida de carga > 1.2 bar.',
      ],
      operatorDecision: 'pending',
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus,
      fallbackReason,
      visionAnalysisId: visionAnalysis?.id,
    };
  }

  if (anomaly.category === 'sensor_fault') {
    return {
      id: diagId,
      anomalyId: anomaly.id,
      timestamp,
      nodeId: node.id,
      nodeName: node.name,
      detectedProblem: `Inconsistencia física o congelamiento de telemetría en ${node.name}.`,
      availableEvidences: evidences,
      primaryHypothesis:
        'Falla de calibración, deriva de lazo 4–20 mA, congelamiento de buffer Modbus o entrada de humedad en el nodo sensor.',
      alternativeHypotheses: [
        {
          title: 'Pérdida de alimentación o falso contacto RS-485/Modbus',
          likelihood: 'Media',
          supportingEvidence: 'Genera lecturas fuera de rango o congelamiento en valores repetidos.',
          contradictingOrMissing: 'El nodo sigue transmitiendo paquetes periódicos.',
        },
        {
          title: 'Obstrucción física del caudalímetro electromagnético sin falla de tubería',
          likelihood: 'Baja',
          supportingEvidence: 'Explicaría caudal 0.0 L/s.',
          contradictingOrMissing: 'No explica valores negativos imposibles o varianza cero exacta.',
        },
      ],
      confidencePct: 92,
      uncertaintyStatement:
        'Se descarta falla hidráulica crítica mientras los nodos vecinos mantengan presión estable; el estado real del parámetro afectado queda temporalmente sin medición confiable.',
      missingData: [
        'Diagnóstico eléctrico de voltaje de batería/panel solar y señal 4–20 mA.',
        'Medición manual portátil en sitio.',
      ],
      potentialImpact: `Pérdida de observabilidad en ${node.name} (${node.populationServed.toLocaleString('es-ES')} usuarios). Riesgo de falsa alarma o ceguera operativa.`,
      priority: anomaly.priority.priority,
      priorityScore: anomaly.priority.totalScore,
      recommendedAction:
        'Despachar revisión electrónica y recalibración del módulo sensor; mantener vigilancia en nodos vecinos sin cerrar suministro.',
      requiredResources: [
        'Técnico de instrumentación IoT',
        'Multímetro, solución patrón de turbidez 0/10 NTU y turbidímetro portátil',
        'Módulo transductor de repuesto',
      ],
      interventionSteps: [
        'Aislar alertas automáticas de calidad de este sensor en consola sin detener bombeo.',
        'Medir parámetros manualmente en sitio con equipo portátil calibrado.',
        'Inspeccionar sellos IP67, bornes 4–20 mA y recalibrar sonda.',
        'Validar 3 ciclos consecutivos consistentes antes de reincorporar a producción.',
      ],
      operatorDecision: 'pending',
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus,
      fallbackReason,
      visionAnalysisId: visionAnalysis?.id,
    };
  }

  if (anomaly.category === 'quality_drift') {
    return {
      id: diagId,
      anomalyId: anomaly.id,
      timestamp,
      nodeId: node.id,
      nodeName: node.name,
      detectedProblem: `Deriva moderada de calidad en ${node.name} (cloro ${node.current.chlorineMgL} mg/L, turbidez ${node.current.turbidityNtu} NTU, pH ${node.current.ph}).`,
      availableEvidences: evidences,
      primaryHypothesis:
        'Desajuste gradual en dosificación de cloro residual o demanda estacional sin arrastre de turbidez.',
      alternativeHypotheses: [
        {
          title: 'Consumo de cloro por tiempo de retención prolongado en ramal',
          likelihood: 'Media',
          supportingEvidence: `La turbidez permanece baja (${node.current.turbidityNtu} NTU <= 4.0 NTU).`,
          contradictingOrMissing: 'Requiere medición de cloro libre con comparador DPD portátil en punto de muestreo.',
        },
      ],
      confidencePct: 81,
      uncertaintyStatement:
        'No se observan indicadores combinados de contaminación ni turbidez; se recomienda ajuste operativo preventivo antes de escalar a alerta sanitaria.',
      missingData: [
        'Lectura DPD manual de cloro libre en salida de planta y punto extremo del ramal.',
      ],
      potentialImpact: `Posible pérdida de protección residual para ${node.populationServed.toLocaleString('es-ES')} usuarios si continúa descendiendo por debajo de 0.20 mg/L.`,
      priority: anomaly.priority.priority,
      priorityScore: anomaly.priority.totalScore,
      recommendedAction:
        'Ajustar dosificación de hipoclorito en planta y verificar cloro libre en 30 minutos mediante muestreo DPD.',
      requiredResources: ['Operador PTAP', 'Kit comparador DPD de cloro libre y pH'],
      interventionSteps: [
        'Verificar caudal y reserva del tanque dosificador de cloro.',
        'Ajustar bomba dosificadora en +10% y registrar nueva lectura a los 30 min.',
      ],
      operatorDecision: 'pending',
      providerUsed,
      providerMode: 'fallback-adapter',
      enrichmentStatus,
      fallbackReason,
      visionAnalysisId: visionAnalysis?.id,
    };
  }

  // Default: contamination
  return {
    id: diagId,
    anomalyId: anomaly.id,
    timestamp,
    nodeId: node.id,
    nodeName: node.name,
    detectedProblem: `Anomalía de calidad en ${node.name}: turbidez ${node.current.turbidityNtu} NTU y cloro libre ${node.current.chlorineMgL} mg/L.`,
    availableEvidences: evidences,
    primaryHypothesis:
      'Evento de arrastre de sedimentos y materia orgánica en cuenca alta por escorrentía o desajuste en dosificación de desinfectante.',
    alternativeHypotheses: [
      {
        title: 'Vertimiento o alteración puntual aguas arriba de la bocatoma',
        likelihood: 'Media',
        supportingEvidence: `Lecturas registradas (pH ${node.current.ph}, cloro ${node.current.chlorineMgL} mg/L) sugieren demanda externa.`,
        contradictingOrMissing: 'No existe confirmación química ni microbiológica de laboratorio aún.',
      },
      {
        title: 'Desajuste en pre-cloración o saturación de filtro en planta',
        likelihood: 'Media',
        supportingEvidence: 'Explica el bajo cloro libre si la demanda aumentó.',
        contradictingOrMissing: 'Requiere inspección física en dosificador y muestreo comparativo.',
      },
    ],
    confidencePct: 78,
    uncertaintyStatement:
      'IMPORTANTE: Ni los sensores básicos ni la fotografía confirman el agente contaminante específico (biológico o químico). Se trata de una alerta preventiva sujeta a muestreo.',
    missingData: [
      'Análisis microbiológico (coliformes fecales / E. coli) y metales/pesticidas.',
      'Recorrido de inspección aguas arriba y verificación en PTAP.',
    ],
    potentialImpact: `Exposición potencial de hasta ${node.populationServed.toLocaleString('es-ES')} habitantes a agua fuera de norma sanitaria si ingresa a distribución sin control.`,
    priority: anomaly.priority.priority,
    priorityScore: anomaly.priority.totalScore,
    recommendedAction:
      'Aislar o regular admisión en bocatoma, operar con reserva de Tanque Mirador, tomar muestras estériles y verificar cloración en PTAP.',
    requiredResources: [
      'Operador de planta + promotor sanitario comunitario',
      'Frascos estériles de muestreo, kit DPD cloro libre y turbidímetro',
      'Hipoclorito de calcio / ajuste de coagulante en PTAP',
    ],
    interventionSteps: [
      'Evaluar cierre parcial de compuerta para evitar ingreso de sólidos a planta.',
      'Tomar 2 muestras estériles (captación y salida PTAP) para análisis externo.',
      'Verificar dosis de coagulación y cloro residual en Tanque Mirador (>0.5 mg/L).',
      'Emitir aviso preventivo comunitario si la reserva desciende de 35%.',
    ],
    operatorDecision: 'pending',
    providerUsed,
    providerMode: 'fallback-adapter',
    enrichmentStatus,
    fallbackReason,
    visionAnalysisId: visionAnalysis?.id,
  };
}



const VISUAL_CATEGORIES = ['leak', 'obstruction', 'contamination', 'sensor_fault', 'quality_drift', 'nominal'] as const;

export function normalizeVisualCategory(v: unknown): AnomalyCategory | 'inconclusive' {
  return (VISUAL_CATEGORIES as readonly unknown[]).includes(v) ? (v as AnomalyCategory) : 'inconclusive';
}


