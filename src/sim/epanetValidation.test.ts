import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js';
import { diagnoseHydraulics } from '../core/hydraulicDiagnosis';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import { NetworkNode } from '../core/types';
import { baselineLocalDemands, M_PER_BAR, solveSteadyState } from './hydraulicModel';

/**
 * REQ-HYD-05: validación del solver propio contra EPANET 2.2 (referencia hidráulica independiente, vía epanet-js/WASM).
 *
 * Alcance honesto: EPANET valida la FÍSICA del solver (Hazen-Williams, conservación de masa, emisores dependientes de la
 * presión, carga del tanque) sobre la parte por gravedad de la red (tanque → distribución). NO valida los datos sintéticos
 * contra una red real ni la parte bombeada. Que EPANET y el solver coincidan prueba que el generador no inventa física;
 * no prueba que la red de San Cristóbal exista.
 */

const nodes = createBaselineNodes();
const byId = new Map(nodes.map((n) => [n.id, n]));
const demands = baselineLocalDemands(nodes, NETWORK_PIPES);
const gravityNodes = ['N-TRON-04', 'N-VALV-05', 'N-DIST-06', 'N-DIST-07'];
const gravityPipes = NETWORK_PIPES.filter((p) => ['P-03', 'P-04', 'P-05', 'P-06'].includes(p.id));

interface Case {
  name: string;
  demandFactor?: number;
  byNode?: Record<string, number>;
  leaks?: Array<{ pipeId: string; nominalFlowLs: number }>;
  tankHeadShiftM?: number;
}

function inp(c: Case): string {
  const tank = byId.get('N-TANQ-03')!;
  const head = tank.elevationM + tank.baseline.pressureBar * M_PER_BAR + (c.tankHeadShiftM ?? 0);
  const f = c.demandFactor ?? 1;
  const junctions = gravityNodes
    .map((id) => `${id} ${byId.get(id)!.elevationM} ${(demands[id] * f * (c.byNode?.[id] ?? 1)).toFixed(6)}`)
    .join('\n');
  const pipes = gravityPipes.map((p) => `${p.id} ${p.from} ${p.to} ${p.lengthM} ${p.diameterMm} 140 0 Open`).join('\n');
  const emitters = (c.leaks ?? [])
    .map((l) => {
      const from = byId.get(NETWORK_PIPES.find((p) => p.id === l.pipeId)!.from)!;
      const p0m = from.baseline.pressureBar * M_PER_BAR;
      return `${from.id} ${(l.nominalFlowLs / Math.sqrt(p0m)).toFixed(8)}`;
    })
    .join('\n');
  return `[TITLE]
${c.name}

[RESERVOIRS]
N-TANQ-03 ${head.toFixed(4)}

[JUNCTIONS]
${junctions}

[PIPES]
${pipes}

[EMITTERS]
${emitters}

[OPTIONS]
Units LPS
Headloss H-W
Emitter Exponent 0.5
Quality None

[TIMES]
Duration 0

[END]
`;
}

let ws: Workspace;
let counter = 0;
before(async () => {
  ws = new Workspace();
  await ws.loadModule();
});

function runEpanet(c: Case): { pressureBar: Record<string, number>; pipeFlowLs: Record<string, number> } {
  const model = new Project(ws);
  const name = `case${counter++}`;
  ws.writeFile(`${name}.inp`, inp(c));
  model.open(`${name}.inp`, `${name}.rpt`, `${name}.out`);
  model.solveH();
  const pressureBar: Record<string, number> = {};
  const pipeFlowLs: Record<string, number> = {};
  for (const id of gravityNodes) pressureBar[id] = model.getNodeValue(model.getNodeIndex(id), NodeProperty.Pressure) / M_PER_BAR;
  for (const p of gravityPipes) pipeFlowLs[p.id] = model.getLinkValue(model.getLinkIndex(p.id), LinkProperty.Flow);
  model.close();
  return { pressureBar, pipeFlowLs };
}

const cases: Case[] = [
  { name: 'linea base' },
  { name: 'demanda x1.5', demandFactor: 1.5 },
  { name: 'demanda x0.6', demandFactor: 0.6 },
  { name: 'fuga 12 L/s en P-05', leaks: [{ pipeId: 'P-05', nominalFlowLs: 12 }] },
  { name: 'fuga 8 L/s en P-06', leaks: [{ pipeId: 'P-06', nominalFlowLs: 8 }] },
  { name: 'demanda no uniforme', byNode: { 'N-DIST-06': 1.4, 'N-DIST-07': 0.7 } },
  { name: 'tanque -3 m', tankHeadShiftM: -3 },
  { name: 'fuga 6 L/s en P-05 con demanda x1.2 y tanque -2 m', demandFactor: 1.2, leaks: [{ pipeId: 'P-05', nominalFlowLs: 6 }], tankHeadShiftM: -2 },
];

for (const c of cases) {
  test(`el solver propio coincide con EPANET 2.2: ${c.name} (REQ-HYD-05)`, () => {
    const ref = runEpanet(c);
    const mine = solveSteadyState({ nodes, pipes: NETWORK_PIPES, demandFactor: c.demandFactor, demandFactorByNode: c.byNode, leaks: c.leaks, tankHeadShiftM: c.tankHeadShiftM });
    for (const id of gravityNodes) {
      const d = Math.abs(ref.pressureBar[id] - mine.pressureBar[id]);
      assert.ok(d <= 0.005, `presión ${id}: EPANET ${ref.pressureBar[id].toFixed(4)} bar vs solver ${mine.pressureBar[id].toFixed(4)} bar (Δ ${d.toFixed(4)})`);
    }
    for (const p of gravityPipes) {
      const d = Math.abs(ref.pipeFlowLs[p.id] - mine.pipeFlowLs[p.id]);
      assert.ok(d <= 0.002, `caudal ${p.id}: EPANET ${ref.pipeFlowLs[p.id].toFixed(4)} vs solver ${mine.pipeFlowLs[p.id].toFixed(4)} L/s`);
    }
  });
}

/** Nodos cuyas lecturas salen de EPANET (no del solver propio): datos generados por una herramienta ajena al diagnóstico. */
function nodesFromEpanet(c: Case): NetworkNode[] {
  const ref = runEpanet(c);
  const f = c.demandFactor ?? 1;
  const ts = '2026-11-19T12:00:00.000Z';
  const flowIn: Record<string, number> = {};
  for (const p of gravityPipes) flowIn[p.to] = ref.pipeFlowLs[p.id];
  const tankIn = ref.pipeFlowLs['P-03'] + ref.pipeFlowLs['P-04'] + demands['N-TANQ-03'] * f;
  flowIn['N-TANQ-03'] = tankIn;
  flowIn['N-PLANTA-02'] = tankIn + demands['N-PLANTA-02'] * f;
  flowIn['N-TOMA-01'] = flowIn['N-PLANTA-02'] + demands['N-TOMA-01'] * f;
  return createBaselineNodes().map((n) => ({
    ...n,
    current: {
      ...n.current,
      timestamp: ts,
      flowLs: Number(flowIn[n.id].toFixed(3)),
      pressureBar: ref.pressureBar[n.id] !== undefined ? Number(ref.pressureBar[n.id].toFixed(3)) : n.baseline.pressureBar,
    },
  }));
}

test('el diagnóstico concluye "fuga localizada" con lecturas generadas por EPANET, sin pasar por el solver propio (REQ-HYD-05)', () => {
  const d = diagnoseHydraulics(nodesFromEpanet({ name: 'f', leaks: [{ pipeId: 'P-05', nominalFlowLs: 12 }] }), NETWORK_PIPES);
  assert.equal(d.level, 'localized_leak');
  assert.equal(d.findings[0].nodeId, 'N-TRON-04');
  assert.equal(d.findings[0].candidates[0].pipeId, 'P-05');
  assert.equal(d.findings[0].pressure.verdict, 'consistent');
  assert.ok(Math.abs(d.findings[0].excessLs - 11.6) < 1, `exceso ${d.findings[0].excessLs}`);

  const v = diagnoseHydraulics(nodesFromEpanet({ name: 'v', leaks: [{ pipeId: 'P-06', nominalFlowLs: 10 }] }), NETWORK_PIPES);
  assert.equal(v.findings[0].nodeId, 'N-VALV-05');
  assert.equal(v.findings[0].level, 'localized_leak');
});

test('la predicción de presión del diagnóstico coincide con la caída que da EPANET (REQ-HYD-05)', () => {
  const d = diagnoseHydraulics(nodesFromEpanet({ name: 'f', leaks: [{ pipeId: 'P-05', nominalFlowLs: 12 }] }), NETWORK_PIPES);
  const p = d.findings[0].pressure;
  assert.ok(p.ratio !== undefined && p.ratio > 0.85 && p.ratio < 1.15, `razón observada/predicha = ${p.ratio}`);
});

test('con demanda ×1.5 y ×0.6 generada por EPANET el diagnóstico NO concluye fuga (REQ-HYD-03, REQ-HYD-05)', () => {
  for (const factor of [1.5, 0.6, 2]) {
    const d = diagnoseHydraulics(nodesFromEpanet({ name: `x${factor}`, demandFactor: factor }), NETWORK_PIPES);
    assert.ok(['no_anomaly', 'insufficient_data'].includes(d.level), `demanda ×${factor} → ${d.level}`);
    assert.equal(d.findings.length, 0);
  }
});

test('demanda NO uniforme (un distrito +40%) no se interpreta como fuga con corroboración de presión (REQ-HYD-03)', () => {
  const d = diagnoseHydraulics(nodesFromEpanet({ name: 'nu', byNode: { 'N-DIST-06': 1.4, 'N-DIST-07': 0.7 } }), NETWORK_PIPES);
  assert.ok(!['possible_leak', 'localized_leak'].includes(d.level), `nivel ${d.level}`);
});
