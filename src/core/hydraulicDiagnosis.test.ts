import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseHydraulics, assessMassBalances, toHydraulicEvidence, DEFAULT_HYDRAULIC_ASSUMPTIONS } from './hydraulicDiagnosis';
import { createBaselineNodes, NETWORK_PIPES } from './networkData';
import { applyFrameToNodes, generateFrames } from '../sim/scenarioGenerator';
import { NetworkNode } from './types';

const T0 = Date.parse('2026-11-19T12:00:00Z');
const quiet = { flowRel: 0, pressureSigmaBar: 0 };

function nodesFor(events: Parameters<typeof generateFrames>[0]['events'], noise = quiet): NetworkNode[] {
  const frames = generateFrames({ seed: 1, startMs: T0, stepMs: 60_000, steps: 1, noise, events: events.map((e) => ({ ...e, startStep: 0, ...(e.type === 'leak' ? { rampSteps: 1 } : {}) })) });
  return applyFrameToNodes(createBaselineNodes(), frames[0]);
}
const leak = (pipeId: string, flowLs: number) => ({ type: 'leak' as const, pipeId, flowLs, startStep: 0 });
const set = (nodes: NetworkNode[], id: string, patch: Partial<NetworkNode['current']>): NetworkNode[] =>
  nodes.map((n) => (n.id === id ? { ...n, current: { ...n.current, ...patch } } : n));

test('línea base sin ruido: balance coherente y límites de detección por nodo (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([]), NETWORK_PIPES);
  assert.equal(d.level, 'no_anomaly');
  const tron = d.balances.find((b) => b.nodeId === 'N-TRON-04')!;
  assert.equal(tron.state, 'consistent');
  assert.ok(Math.abs(tron.deviationLs) < 0.05);
  assert.ok(tron.detectionLimitLs > 3.5 && tron.detectionLimitLs < 5, `límite TRON ${tron.detectionLimitLs} L/s`);
  assert.equal(d.demandFactor?.value, 1);
});

test('el umbral es la incertidumbre propagada, no un 4 L/s / 15% fijo (REQ-HYD-03)', () => {
  const nodes = nodesFor([leak('P-05', 3.5)]);
  const strict = diagnoseHydraulics(nodes, NETWORK_PIPES, { assumptions: { meterRelUncertainty: 0.02 } });
  const precise = diagnoseHydraulics(nodes, NETWORK_PIPES, { assumptions: { meterRelUncertainty: 0.005, demandModelRelUncertainty: 0.02 } });
  const tronStrict = strict.balances.find((b) => b.nodeId === 'N-TRON-04')!;
  const tronPrecise = precise.balances.find((b) => b.nodeId === 'N-TRON-04')!;
  assert.ok(tronPrecise.sigmaLs < tronStrict.sigmaLs / 2, 'medidores mejores → incertidumbre menor');
  assert.ok(tronPrecise.detectionLimitLs < tronStrict.detectionLimitLs);
  assert.equal(tronStrict.state, 'consistent', '3.5 L/s no supera 3σ con medidores de ±2%');
  assert.equal(tronPrecise.state, 'excess', 'con medidores más precisos el mismo exceso sí es significativo');
});

test('rotura de 12 L/s en P-05: fuga localizada en un único tramo, con presión coherente (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([leak('P-05', 12)]), NETWORK_PIPES);
  assert.equal(d.level, 'localized_leak');
  const f = d.findings[0];
  assert.equal(f.nodeId, 'N-TRON-04');
  assert.deepEqual(f.candidates.map((c) => c.pipeId), ['P-05']);
  assert.equal(f.pressure.verdict, 'consistent');
  assert.ok(f.rationale.some((r) => /dentro del tramo/.test(r)), 'declara que no puede ubicar la fuga dentro del tramo');
  assert.ok(d.limits.some((l) => /entre dos medidores/.test(l)));
});

test('persistencia: con requiredConsecutive=2 la primera evaluación es solo anomalía de caudal (REQ-HYD-03)', () => {
  const nodes = nodesFor([leak('P-05', 12)]);
  const first = diagnoseHydraulics(nodes, NETWORK_PIPES, { requiredConsecutive: 2, streak: {} });
  assert.equal(first.level, 'flow_anomaly');
  assert.ok(first.findings[0].rationale.some((r) => /Pendiente de persistencia/.test(r)));
  const second = diagnoseHydraulics(nodes, NETWORK_PIPES, { requiredConsecutive: 2, streak: { 'N-TRON-04': 1 } });
  assert.equal(second.level, 'localized_leak');
});

test('REGRESIÓN DE AUDITORÍA: exceso de caudal SIN respuesta de presión (deriva de medidor) no es fuga (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([{ type: 'meter_bias', nodeId: 'N-TRON-04', relBias: 0.5, startStep: 0 }]), NETWORK_PIPES);
  const f = d.findings.find((x) => x.nodeId === 'N-TRON-04')!;
  assert.ok(f, 'un +50% de deriva sí es una anomalía de caudal');
  assert.equal(f.level, 'flow_anomaly');
  assert.equal(f.pressure.verdict, 'absent');
  assert.match(f.pressure.detail, /deriva de medidor/);
});

test('caída de presión mucho mayor que la que explica el caudal: no se concluye fuga (REQ-HYD-03)', () => {
  let nodes = nodesFor([leak('P-05', 12)]);
  nodes = set(nodes, 'N-TRON-04', { pressureBar: 2.0 });
  const d = diagnoseHydraulics(nodes, NETWORK_PIPES);
  const f = d.findings.find((x) => x.nodeId === 'N-TRON-04')!;
  assert.equal(f.pressure.verdict, 'too_large');
  assert.equal(f.level, 'flow_anomaly');
});

test('el exceso pequeño no discrimina por presión y queda como anomalía de caudal; una foto ANALIZADA que confirma lo eleva (REQ-HYD-03)', () => {
  const nodes = nodesFor([leak('P-05', 7)]);
  const without = diagnoseHydraulics(nodes, NETWORK_PIPES);
  assert.equal(without.findings[0].pressure.verdict, 'not_discriminating');
  assert.equal(without.level, 'flow_anomaly');
  const withPhoto = diagnoseHydraulics(nodes, NETWORK_PIPES, { confirmingPhotoNodeIds: ['N-TRON-04'] });
  assert.equal(withPhoto.level, 'localized_leak');
  assert.ok(withPhoto.findings[0].photoConfirms);
});

test('aguas arriba del tanque (bombeo) no hay modelo de presión: not_applicable y máximo anomalía de caudal (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([leak('P-02', 10)]), NETWORK_PIPES);
  const f = d.findings.find((x) => x.nodeId === 'N-PLANTA-02')!;
  assert.equal(f.pressure.verdict, 'not_applicable');
  assert.equal(f.level, 'flow_anomaly');
});

test('el tanque nunca se evalúa (almacenamiento) y se explica por qué (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([leak('P-03', 12)]), NETWORK_PIPES);
  const tank = d.balances.find((b) => b.nodeId === 'N-TANQ-03')!;
  assert.equal(tank.state, 'not_evaluable');
  assert.match(tank.notEvaluableReasons.join(' '), /almacenamiento/);
  assert.equal(d.findings.length, 0);
});

test('lecturas no sincronizadas: no se evalúa en lugar de mezclar épocas (REQ-HYD-03)', () => {
  let nodes = nodesFor([leak('P-05', 12)]);
  nodes = set(nodes, 'N-DIST-06', { timestamp: new Date(T0 - 3 * 3600_000).toISOString() });
  const d = diagnoseHydraulics(nodes, NETWORK_PIPES);
  const tron = d.balances.find((b) => b.nodeId === 'N-TRON-04')!;
  assert.equal(tron.state, 'not_evaluable');
  assert.match(tron.notEvaluableReasons.join(' '), /sincronizadas/);
  assert.equal(d.findings.find((f) => f.nodeId === 'N-TRON-04'), undefined);
});

test('un nodo cuyo medidor está en falla de sensor no genera conclusiones (REQ-HYD-03)', () => {
  const nodes = nodesFor([leak('P-05', 12)]).map((n) => (n.id === 'N-DIST-06' ? { ...n, status: 'fault' as const } : n));
  const d = diagnoseHydraulics(nodes, NETWORK_PIPES);
  assert.equal(d.balances.find((b) => b.nodeId === 'N-TRON-04')!.state, 'not_evaluable');
});

test('un déficit (salida > entrada) es incoherencia de medidor, nunca fuga (REQ-HYD-03)', () => {
  const nodes = set(nodesFor([]), 'N-DIST-06', { flowLs: 24 });
  const d = diagnoseHydraulics(nodes, NETWORK_PIPES);
  assert.equal(d.findings.length, 0);
  assert.ok(d.meterInconsistencies.some((m) => /Una fuga no explica eso/.test(m)));
});

test('sin ninguna lectura utilizable el resultado es insufficient_data y no una afirmación de normalidad (REQ-HYD-03)', () => {
  const broken = createBaselineNodes().map((n) => ({ ...n, status: 'fault' as const }));
  assert.equal(diagnoseHydraulics(broken, NETWORK_PIPES).level, 'insufficient_data');
});

test('toHydraulicEvidence: resume el hallazgo del nodo y distingue "no anomalía" de "datos insuficientes" (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFor([leak('P-05', 12)]), NETWORK_PIPES);
  const ev = toHydraulicEvidence(d, 'N-TRON-04')!;
  assert.equal(ev.level, 'localized_leak');
  assert.deepEqual(ev.candidatePipeIds, ['P-05']);
  assert.ok(ev.estimatedLossM3PerDay! > 900);
  assert.equal(toHydraulicEvidence(d, 'N-VALV-05')!.level, 'no_anomaly');
  const ok = toHydraulicEvidence(diagnoseHydraulics(nodesFor([]), NETWORK_PIPES));
  assert.equal(ok!.level, 'no_anomaly');
});

test('determinismo: el mismo estado produce siempre el mismo diagnóstico (REQ-HYD-03)', () => {
  const nodes = nodesFor([leak('P-05', 12)], { flowRel: 0.01, pressureSigmaBar: 0.02 });
  const a = JSON.stringify(diagnoseHydraulics(nodes, NETWORK_PIPES));
  for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(diagnoseHydraulics(nodes, NETWORK_PIPES)), a);
});

test('assessMassBalances usa los supuestos declarados y los expone (REQ-HYD-03)', () => {
  assert.equal(DEFAULT_HYDRAULIC_ASSUMPTIONS.meterRelUncertainty, 0.02);
  const { balances } = assessMassBalances(nodesFor([]), NETWORK_PIPES, { meterRelUncertainty: 0.05 });
  const base = assessMassBalances(nodesFor([]), NETWORK_PIPES).balances;
  assert.ok(balances.find((b) => b.nodeId === 'N-TOMA-01')!.sigmaLs > base.find((b) => b.nodeId === 'N-TOMA-01')!.sigmaLs);
});
