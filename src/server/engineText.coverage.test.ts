import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, RunningServer, startServer } from './testing/harness';
import { runLeakToClosedOrder } from './testing/flows';
import { translateEngineText } from '../ui/engineText';

/**
 * REQ-LANG-02: el texto que emiten el servidor y el motor se traduce al mostrarlo, sin tocar el motor.
 * Esta prueba usa el servidor REAL: lanza el ciclo completo (fuga, diagnóstico, decisión, orden, cierre, tres veredictos, expediente,
 * los otros escenarios y la vista previa 3D) y exige que cada frase que la interfaz muestra salga en inglés sin restos en español.
 * Los nombres propios de los nodos (Troncal Sector Norte...) y el texto escrito por personas se conservan a propósito.
 */
let srv: RunningServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
});

/** Campos que la interfaz pinta tal cual los recibe del servidor. */
const SHOWN = new Set([
  'title', 'explanation', 'detectedProblem', 'primaryHypothesis', 'supportingEvidence', 'contradictingOrMissing', 'uncertaintyStatement',
  'potentialImpact', 'recommendedAction', 'evidenceSummary', 'rationale', 'limits', 'alternatives', 'availableEvidences', 'missingData',
  'requiredResources', 'interventionSteps', 'label', 'detail', 'statement', 'reasons', 'notEvaluableReasons', 'newState', 'previousState',
  'notAnalyzedReason', 'cannotDetermine', 'sensorCorrelationSummary', 'shortTitle', 'summary', 'imageTitle', 'formulaNote', 'error', 'note',
  'probableCause', 'material', 'sector', 'aiProvider', 'visionProvider', 'geminiModelNote', 'providerUsed', 'actor', 's3', 'lambda', 'dynamodb', 'bedrock',
]);
const SPANISH = /[áéíóúñ¿¡«»]|\b(de|del|la|las|los|el|con|para|por|una|se|sin|que|hay|está|están|ni|solo|sobre|tras|desde|hacia|entre|aún)\b/;

function collect(v: unknown, key: string, out: Set<string>, own = false) {
  if (typeof v === 'string') {
    if (own && v.trim().length > 3) out.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => collect(x, key, out, own));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, k, out, SHOWN.has(k));
}

test('REQ-LANG-02: el ciclo completo (tres veredictos, expediente, escenarios y vista previa 3D) se muestra en inglés sin restos en español', async () => {
  const seen = new Set<string>();
  const names = new Set<string>();
  const grab = (data: unknown) => {
    collect(data, '', seen);
    for (const n of (data as any)?.nodes ?? []) [n.name, n.sector].forEach((x) => x && names.add(String(x)));
  };
  for (const mode of ['repaired', 'unresolved', 'sparse']) {
    await api(srv.base, 'POST', '/api/reset', {}).catch(() => null);
    const r = await runLeakToClosedOrder(srv.base);
    grab(r.detected);
    grab(r.diagnosis);
    grab(r.order);
    grab((await api(srv.base, 'POST', `/api/work-orders/${r.orderId}/simulated-measurements`, { mode })).data);
    const state = (await api(srv.base, 'GET', '/api/state')).data;
    grab(state);
    grab((await api(srv.base, 'GET', `/api/work-orders/${r.orderId}/dossier`)).data);
    grab((await api(srv.base, 'GET', `/api/work-orders/${r.orderId}/dossier/verify`)).data);
    grab((await api(srv.base, 'POST', '/api/ledger/verify', {})).data);
  }
  for (const sc of ['obstruction', 'sensor_fault', 'contamination']) {
    await api(srv.base, 'POST', '/api/reset', {}).catch(() => null);
    grab((await api(srv.base, 'POST', `/api/scenarios/${sc}/trigger`)).data);
    grab((await api(srv.base, 'GET', '/api/state')).data);
  }
  for (const q of [1, 3, 6, 12]) grab((await api(srv.base, 'GET', `/api/preview/leak?leakLps=${q}`)).data);
  for (const u of ['/api/nope', '/api/work-orders/XX/dossier']) grab((await api(srv.base, 'GET', u)).data);
  grab((await api(srv.base, 'POST', '/api/diagnoses/XX/decision', { decision: 'accepted' })).data);

  assert.ok(seen.size > 100, `se esperaban muchas frases del servidor, hay ${seen.size}`);
  const proper = [...names].sort((a, b) => b.length - a.length);
  const strip = (s: string) => proper.reduce((acc, n) => acc.split(n).join('·'), s);
  const left: string[] = [];
  for (const s of seen) {
    const en = strip(translateEngineText(s));
    // Texto escrito por personas o cadenas técnicas: no se traducen.
    if (/^(Brida reemplazada|Cuadrilla|Admin de Prueba|cierre\.png)/.test(en) || /^-----BEGIN/.test(en)) continue;
    if (SPANISH.test(en)) left.push(en.length > 160 ? `${en.slice(0, 160)}…` : en);
  }
  assert.deepEqual(left.slice(0, 30), [], `frases sin traducir (${left.length}):\n${left.slice(0, 30).join('\n')}`);
});
