// SOLO PARA PRUEBAS: simula el endpoint REST de Gemini para ejercitar el manejo de errores del servidor.
// NO es Gemini real y no valida nada sobre Gemini real. Se carga con `node --import <este archivo>`.
// El modo se lee de un archivo (FAKE_GEMINI_MODE_FILE) para poder cambiarlo sin reiniciar el servidor.
import fs from 'node:fs';

const MODE_FILE = process.env.FAKE_GEMINI_MODE_FILE;
const LOG = process.env.FAKE_GEMINI_LOG;
const realFetch = globalThis.fetch;
const mode = () => {
  try {
    return fs.readFileSync(MODE_FILE, 'utf8').trim();
  } catch {
    return 'ok';
  }
};
let n429 = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (obj) =>
  json(200, { candidates: [{ content: { role: 'model', parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }] });

const VISION_OK = { observed: ['Chorro de agua en una brida'], cannotDetermine: ['Caudal exacto'], missingData: ['Prueba de presión'], visualCategory: 'leak', imageQuality: 'adecuada' };
const DIAG_OK = {
  detectedProblem: 'Fuga en el tramo (texto simulado del LLM)',
  primaryHypothesis: 'Rotura de brida (texto simulado del LLM)',
  alternativeHypotheses: [{ title: 'Falla de medidor', likelihood: 'Baja', supportingEvidence: 'Explicaría el exceso aparente', contradictingOrMissing: 'La presión es coherente con caudal real' }],
  uncertaintyStatement: 'Estimación sin calibración de campo',
  missingData: ['Inspección acústica'],
  potentialImpact: 'Baja presión en el sector',
  recommendedAction: 'Aislar el tramo y reparar',
  requiredResources: ['Cuadrilla hidráulica'],
  interventionSteps: ['Aislar el tramo con las válvulas', 'Reparar la brida y presurizar'],
};

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input.url ?? String(input));
  if (!/generativelanguage\.googleapis\.com/.test(url)) return realFetch(input, init);
  const m = mode();
  const isVision = String(init?.body ?? '').includes('inlineData');
  if (LOG) fs.appendFileSync(LOG, `${m}:${isVision ? 'vision' : 'diag'}\n`);
  if (m === 'hang') return new Promise(() => {});
  if (m === 'err400') return json(400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } });
  if (m === 'err429') return json(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
  if (m === 'err429once' && n429++ % 2 === 0) return json(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
  if (m === 'badjson') return wrap('esto no es json');
  if (m === 'empty') return wrap('{}');
  if (m === 'wrongtypes') {
    return wrap(
      isVision
        ? { observed: 'una fuga', cannotDetermine: null, missingData: [], visualCategory: 'dragon', imageQuality: 9 }
        : { detectedProblem: 123, primaryHypothesis: 'x', alternativeHypotheses: 'ninguna', uncertaintyStatement: 'u', missingData: 'n', potentialImpact: 'p', recommendedAction: 'r', requiredResources: 'r', interventionSteps: 'paso único' }
    );
  }
  if (m === 'conflict' && isVision) return wrap({ ...VISION_OK, visualCategory: 'contamination', observed: ['Agua turbia'] });
  return wrap(isVision ? VISION_OK : DIAG_OK);
};
