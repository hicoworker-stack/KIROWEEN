import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { admin, ADMIN_TOKEN, api, RunningServer, sleep, startServer, waitFor } from './testing/harness';

/**
 * Manejo de errores de la capa de IA contra un endpoint de Gemini SIMULADO (src/server/testing/fakeGemini.mjs).
 * Estas pruebas NO validan Gemini real: validan que el servidor se comporta bien cuando la respuesta es buena,
 * vacía, malformada, lenta o falla (REQ-AI-03..06).
 */
let srv: RunningServer;
const get = (url: string) => api(srv.base, 'GET', url);
const post = (url: string, body?: unknown, headers?: Record<string, string>) => api(srv.base, 'POST', url, body ?? {}, headers);
const ledgerOf = async () => (await get('/api/state')).data.ledger as any[];
const count = (ledger: any[], action: string) => ledger.filter((e) => e.action === action).length;

before(async () => {
  srv = await startServer({
    fakeGemini: true,
    env: { AQUA_ADMIN_TOKEN: ADMIN_TOKEN, GEMINI_TIMEOUT_MS: '300', GEMINI_TOTAL_BUDGET_MS: '1200' },
  });
});
after(async () => {
  await srv?.stop();
});

async function fresh(mode: string) {
  srv.setMode(mode);
  fs.writeFileSync(srv.geminiLog, '');
  assert.equal((await post('/api/reset', {}, admin('reset'))).status, 200);
}
async function trigger() {
  const r = await post('/api/scenarios/leak/trigger');
  assert.equal(r.status, 200);
  return r.data;
}
async function settled(diagId: string) {
  return waitFor(
    async () => ((await get('/api/state')).data.diagnoses as any[]).find((d) => d.id === diagId),
    (d) => d?.enrichmentStatus !== 'pending',
    12_000
  );
}

test('REQ-AI-03: respuesta válida → enriquecimiento "live", visión confirmatoria, un único AI_ENRICHMENT_COMPLETED', async () => {
  await fresh('ok');
  const t = await trigger();
  assert.equal(t.aiEnrichmentStatus, 'pending');
  const d = await settled(t.diagnosis.id);
  assert.equal(d.providerMode, 'gemini-live');
  assert.equal(d.confidencePct, undefined);
  const state = (await get('/api/state')).data;
  const v = state.visionAnalyses.find((x: any) => x.anomalyId === t.anomaly.id);
  assert.equal(v.analysisStatus, 'analyzed');
  assert.equal(v.evidenceRole, 'confirmatory');
  assert.equal(d.evidenceLevel, 'alta');
  assert.equal(count(state.ledger, 'AI_ENRICHMENT_COMPLETED'), 1);
});

test('REQ-AI-05/REQ-HYD-05: foto que contradice la hidráulica → en_conflicto, no se promedia', async () => {
  await fresh('conflict');
  const t = await trigger();
  const d = await settled(t.diagnosis.id);
  assert.equal(d.evidenceLevel, 'en_conflicto');
  const v = ((await get('/api/state')).data.visionAnalyses as any[]).find((x) => x.anomalyId === t.anomaly.id);
  assert.equal(v.evidenceRole, 'contradictory');
});

for (const mode of ['empty', 'badjson', 'wrongtypes']) {
  test(`REQ-AI-03: Gemini "${mode}" → respaldo determinista (invalid_response), nunca pendiente, sin texto inventado`, async () => {
    await fresh(mode);
    const t = await trigger();
    const d = await settled(t.diagnosis.id);
    assert.equal(d.providerMode, 'fallback-adapter');
    assert.equal(d.fallbackReason, 'invalid_response');
    assert.ok(!/simulado del LLM/.test(JSON.stringify(d)), 'no se filtra contenido de una respuesta inválida');
    const state = (await get('/api/state')).data;
    assert.ok(state.visionAnalyses.every((v: any) => v.analysisStatus !== 'pending'));
    assert.equal(count(state.ledger, 'AI_ENRICHMENT_COMPLETED'), 1);
  });
}

for (const mode of ['err400', 'err429']) {
  test(`REQ-AI-04: Gemini "${mode}" → respaldo api_error y el servidor sigue vivo`, async () => {
    await fresh(mode);
    const t = await trigger();
    const d = await settled(t.diagnosis.id);
    assert.equal(d.providerMode, 'fallback-adapter');
    assert.equal(d.fallbackReason, 'api_error');
    assert.ok(srv.isAlive());
  });
}

test('REQ-AI-04: Gemini colgado → respaldo por tiempo límite dentro del presupuesto total, nunca pendiente para siempre', async () => {
  await fresh('hang');
  const started = Date.now();
  const t = await trigger();
  const d = await settled(t.diagnosis.id);
  assert.equal(d.providerMode, 'fallback-adapter');
  assert.ok(['timeout', 'api_error'].includes(d.fallbackReason), `motivo: ${d.fallbackReason}`);
  assert.ok(Date.now() - started < 10_000, 'se resuelve dentro del presupuesto + vigilante');
  assert.equal(count(await ledgerOf(), 'AI_ENRICHMENT_COMPLETED'), 1);
});

test('REQ-AI-06: un reset durante una llamada pendiente descarta la respuesta tardía: sin entradas fantasma en el ledger nuevo', async () => {
  await fresh('hang');
  await trigger();
  assert.equal((await post('/api/reset', {}, admin('reset'))).status, 200);
  srv.setMode('ok'); // aunque la IA responda bien después, la época cambió
  await sleep(7500); // más que presupuesto + vigilante
  const ledger = await ledgerOf();
  assert.equal(ledger.length, 1, 'solo el génesis del estado nuevo');
  assert.equal(count(ledger, 'AI_ENRICHMENT_COMPLETED'), 0);
  const s = (await get('/api/state')).data;
  assert.equal(s.diagnoses.length, 0);
});

test('REQ-DEMO-01: el modo demo con clave presente no llama a Gemini (ai_disabled) y el log del endpoint queda vacío', async () => {
  srv.setMode('ok');
  fs.writeFileSync(srv.geminiLog, '');
  const r = await post('/api/demo/frankenstein', {}, admin('demo'));
  assert.equal(r.status, 200);
  assert.equal(r.data.aiEnrichmentStatus, 'complete');
  assert.equal(r.data.diagnosis.providerMode, 'fallback-adapter');
  assert.equal(r.data.diagnosis.fallbackReason, 'ai_disabled');
  await sleep(1500);
  assert.equal(fs.readFileSync(srv.geminiLog, 'utf8').trim(), '', 'ninguna llamada a Gemini en modo demo');
});
