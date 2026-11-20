import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenario, formatEvalTable, runSequence } from './evaluation';
import { ScenarioEvent } from './scenarioGenerator';

/**
 * REQ-HYD-06: umbrales de regresión del comportamiento del detector frente a verdad conocida.
 * Datos SINTÉTICOS generados con un solver validado contra EPANET. Si alguien cambia el detector y empeora la
 * especificidad o la localización, estas pruebas fallan. Los números documentan, además, los límites reales del sistema.
 */

const N = 300;
const leak = (pipeId: string, flowLs: number): ScenarioEvent => ({ type: 'leak', pipeId, flowLs, startStep: 0 });
const demand = (factor: number, nodeIds?: string[]): ScenarioEvent => ({ type: 'demand', factor, startStep: 0, ...(nodeIds ? { nodeIds } : {}) });

test('ESPECIFICIDAD: sin fuga no hay conclusión de fuga ante ruido, demanda uniforme o no, deriva de medidor, sesgo de presión ni cambio de nivel (REQ-HYD-03, REQ-HYD-06)', () => {
  const noLeak: Array<[string, ScenarioEvent[]]> = [
    ['sin evento', []],
    ...[0.5, 0.75, 1.25, 1.5, 2, 3].map((f): [string, ScenarioEvent[]] => [`demanda uniforme x${f}`, [demand(f)]]),
    ['demanda NO uniforme', [demand(1.4, ['N-DIST-06']), demand(0.7, ['N-DIST-07'])]],
    ['deriva +8% del medidor de TRON', [{ type: 'meter_bias', nodeId: 'N-TRON-04', relBias: 0.08, startStep: 0 }]],
    ['deriva +15% del medidor de TRON', [{ type: 'meter_bias', nodeId: 'N-TRON-04', relBias: 0.15, startStep: 0 }]],
    ['sesgo -0.3 bar del transmisor de TRON', [{ type: 'pressure_bias', nodeId: 'N-TRON-04', biasBar: -0.3, startStep: 0 }]],
    ['tanque -4 m', [{ type: 'tank_head', shiftM: -4, startStep: 0 }]],
  ];
  for (const [label, events] of noLeak) {
    const r = evaluateScenario(label, events, { n: N });
    assert.equal(r.leakConclusion, 0, `${label}: concluyó fuga sin que la haya (${r.leakConclusion})`);
    assert.ok(r.anyFinding <= 0.05, `${label}: ${(r.anyFinding * 100).toFixed(1)}% de hallazgos espurios`);
  }
});

test('REGRESIÓN DE AUDITORÍA: un aumento general de la demanda ×1.5 ya no se confunde con una fuga (REQ-HYD-03)', () => {
  const r = evaluateScenario('demanda x1.5', [demand(1.5)], { n: N });
  assert.equal(r.anyFinding, 0);
});

test('SENSIBILIDAD Y LOCALIZACIÓN: la rotura de 12 L/s en P-05 se localiza el 100% de las veces y en el tramo correcto (REQ-HYD-06)', () => {
  const r = evaluateScenario('12 L/s en P-05', [leak('P-05', 12)], { n: N, truth: { pipeId: 'P-05', nodeId: 'N-TRON-04' } });
  assert.ok(r.localized >= 0.99);
  assert.equal(r.correctReach, 1);
  assert.equal(r.correctNode, 1);
  const v = evaluateScenario('8 L/s en P-06', [leak('P-06', 8)], { n: N, truth: { pipeId: 'P-06', nodeId: 'N-VALV-05' } });
  assert.ok(v.localized >= 0.99);
  assert.equal(v.correctReach, 1);
});

test('LÍMITE HONESTO: fugas de 6-8 L/s en P-05 se detectan como anomalía de caudal pero NO se declaran fuga (presión no discrimina) (REQ-HYD-03, REQ-HYD-06)', () => {
  for (const q of [6, 8]) {
    const r = evaluateScenario(`${q} L/s en P-05`, [leak('P-05', q)], { n: N });
    assert.ok(r.anyFinding >= 0.99, `${q} L/s debe verse como anomalía de caudal`);
    assert.equal(r.leakConclusion, 0, `${q} L/s no puede declararse fuga con la presión disponible`);
  }
});

test('LÍMITE HONESTO: una fuga de 2 L/s (172 m³/día) es indetectable con estos medidores (REQ-HYD-06)', () => {
  const r = evaluateScenario('2 L/s en P-05', [leak('P-05', 2)], { n: N });
  assert.ok(r.anyFinding <= 0.02, 'por debajo del límite de detección: no se afirma nada');
  assert.equal(r.leakConclusion, 0);
});

test('LÍMITE HONESTO: aguas arriba del tanque (bombeo) nunca pasa de anomalía de caudal sin otra evidencia (REQ-HYD-03)', () => {
  for (const pipe of ['P-01', 'P-02']) {
    const r = evaluateScenario(`8 L/s en ${pipe}`, [leak(pipe, 8)], { n: N });
    assert.ok(r.anyFinding >= 0.99);
    assert.equal(r.leakConclusion, 0, `${pipe}: sin modelo de presión no se puede concluir fuga`);
  }
});

test('LÍMITE HONESTO: una fuga en la salida del tanque (almacenamiento) no produce ninguna conclusión (REQ-HYD-03)', () => {
  const r = evaluateScenario('12 L/s en P-03', [leak('P-03', 12)], { n: N });
  assert.equal(r.anyFinding, 0);
  assert.equal(r.leakConclusion, 0);
});

test('PERSISTENCIA: con 2 fotogramas consecutivos exigidos no hay falsos positivos de fuga, ni con un salto de demanda (REQ-HYD-03)', () => {
  let fp = 0;
  for (let i = 0; i < 400; i++) {
    for (const events of [[], [demand(1.8)]] as ScenarioEvent[][]) {
      const m = runSequence(events.map((e) => ({ ...e, startStep: 2 })), 5000 + i, 6, 2).maxLevel;
      if (m === 'possible_leak' || m === 'localized_leak') fp++;
    }
  }
  assert.equal(fp, 0);
});

test('PERSISTENCIA: una rotura real sostenida alcanza fuga localizada tras la persistencia exigida (REQ-HYD-03)', () => {
  const r = runSequence([{ type: 'leak', pipeId: 'P-05', flowLs: 12, startStep: 2, rampSteps: 2 }], 11, 8, 2);
  assert.equal(r.maxLevel, 'localized_leak');
  assert.ok(!['possible_leak', 'localized_leak'].includes(r.levels[0]));
});

test('la tabla de evaluación se formatea para el informe (REQ-HYD-06)', () => {
  const table = formatEvalTable([evaluateScenario('x', [], { n: 10 })]);
  assert.match(table, /Escenario/);
  assert.match(table, /0\.0%/);
});
