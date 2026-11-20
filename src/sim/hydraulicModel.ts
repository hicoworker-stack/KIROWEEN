import { NetworkNode, PipeSegment } from '../core/types';

/**
 * REQ-HYD-04: SIMULADOR hidráulico en régimen permanente para redes en ÁRBOL.
 *
 * Esto es GENERACIÓN de datos sintéticos con física, no diagnóstico. Regla de arquitectura: nada de src/core importa
 * este módulo (lo comprueba src/architecture.test.ts). El motor de diagnóstico solo ve lecturas, como en un despliegue real.
 *
 * Modelo (supuestos, sin calibración de campo):
 *  - Conservación de masa en cada nodo: caudal de entrada = demanda local + fugas en el nodo + suma de las entradas de los hijos.
 *  - Pérdida de carga en tuberías con Hazen-Williams (SI): hf = 10.67·L·Q^1.852 / (C^1.852 · D^4.8704).
 *  - El tanque es un nodo de carga fija: aguas abajo la presión es la carga del tanque menos las pérdidas y la cota.
 *    Aguas arriba del tanque hay bombeo; su presión no se modela y se mantiene en la línea base.
 *  - Las fugas son emisores dependientes de la presión: q = q_nominal · sqrt(P / P_base).
 *  - Una fuga en la tubería a→b se sitúa en el lado a (justo después del medidor de a): su caudal entra por el medidor de a
 *    y no por el de b. Una fuga a mitad de tubería entre dos medidores es indistinguible desde los medidores.
 *
 * Validación: src/sim/epanetValidation.test.ts compara este solver con EPANET 2.2 (epanet-js) como referencia independiente.
 */

export const M_PER_BAR = 10.1972;
export const DEFAULT_HAZEN_C = 140;

export function hazenWilliamsHeadLossM(flowLs: number, lengthM: number, diameterMm: number, c: number = DEFAULT_HAZEN_C): number {
  const q = Math.abs(flowLs) / 1000;
  const d = diameterMm / 1000;
  const hf = (10.67 * lengthM * Math.pow(q, 1.852)) / (Math.pow(c, 1.852) * Math.pow(d, 4.8704));
  return flowLs < 0 ? -hf : hf;
}

export interface Leak {
  /** Tubería a→b; la fuga se sitúa en el lado a. */
  pipeId: string;
  /** Caudal de la fuga a la presión de la línea base (L/s). */
  nominalFlowLs: number;
}

export interface SolveInput {
  nodes: NetworkNode[];
  pipes: PipeSegment[];
  /** Factor global sobre todas las demandas locales (1 = línea base). */
  demandFactor?: number;
  /** Factor adicional por nodo (demanda NO uniforme). */
  demandFactorByNode?: Record<string, number>;
  leaks?: Leak[];
  /** Variación de la carga del tanque (m), p. ej. por cambio de nivel. */
  tankHeadShiftM?: number;
}

export interface SolveResult {
  inflowLs: Record<string, number>;
  pressureBar: Record<string, number>;
  hglM: Record<string, number>;
  pipeFlowLs: Record<string, number>;
  /** Caudal real de cada fuga tras el acople con la presión. */
  leakFlowLs: Record<string, number>;
  iterations: number;
}

export interface Topology {
  rootId: string;
  childrenOf: Map<string, PipeSegment[]>;
  parentPipeOf: Map<string, PipeSegment>;
  /** Orden topológico (padres antes que hijos). */
  order: string[];
}

export function buildTopology(nodes: Array<{ id: string }>, pipes: PipeSegment[]): Topology {
  const childrenOf = new Map<string, PipeSegment[]>();
  const parentPipeOf = new Map<string, PipeSegment>();
  for (const n of nodes) childrenOf.set(n.id, []);
  for (const p of pipes) {
    childrenOf.get(p.from)?.push(p);
    if (parentPipeOf.has(p.to)) throw new Error(`La red no es un árbol: ${p.to} tiene más de una tubería entrante.`);
    parentPipeOf.set(p.to, p);
  }
  const roots = nodes.filter((n) => !parentPipeOf.has(n.id));
  if (roots.length !== 1) throw new Error(`Se esperaba una única raíz y hay ${roots.length}.`);
  const order: string[] = [];
  const queue = [roots[0].id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const p of childrenOf.get(id) ?? []) queue.push(p.to);
  }
  if (order.length !== nodes.length) throw new Error('La red tiene nodos desconectados o ciclos.');
  return { rootId: roots[0].id, childrenOf, parentPipeOf, order };
}

/** Demanda local de cada nodo implícita en la línea base: caudal de entrada menos lo que reparte a sus hijos. */
export function baselineLocalDemands(nodes: NetworkNode[], pipes: PipeSegment[]): Record<string, number> {
  const topo = buildTopology(nodes, pipes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const demands: Record<string, number> = {};
  for (const n of nodes) {
    const children = topo.childrenOf.get(n.id) ?? [];
    const out = children.reduce((a, p) => a + byId.get(p.to)!.baseline.flowLs, 0);
    demands[n.id] = Math.max(0, Number((n.baseline.flowLs - out).toFixed(6)));
  }
  return demands;
}

export function solveSteadyState(input: SolveInput): SolveResult {
  const { nodes, pipes } = input;
  const topo = buildTopology(nodes, pipes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const baseDemand = baselineLocalDemands(nodes, pipes);
  const f = input.demandFactor ?? 1;
  const leaks = input.leaks ?? [];
  const leakFlow: Record<string, number> = Object.fromEntries(leaks.map((l) => [l.pipeId, l.nominalFlowLs]));

  const tank = nodes.find((n) => n.kind === 'tank');
  const tankHgl = tank ? tank.elevationM + tank.baseline.pressureBar * M_PER_BAR + (input.tankHeadShiftM ?? 0) : null;

  const inflow: Record<string, number> = {};
  const hgl: Record<string, number> = {};
  const pressure: Record<string, number> = {};
  let iterations = 0;

  for (; iterations < 50; iterations++) {
    // Caudales: de las hojas hacia la raíz.
    for (const id of [...topo.order].reverse()) {
      const local = baseDemand[id] * f * (input.demandFactorByNode?.[id] ?? 1);
      const leakHere = leaks.filter((l) => pipes.find((p) => p.id === l.pipeId)?.from === id).reduce((a, l) => a + leakFlow[l.pipeId], 0);
      const fromChildren = (topo.childrenOf.get(id) ?? []).reduce((a, p) => a + inflow[p.to], 0);
      inflow[id] = local + leakHere + fromChildren;
    }
    // Cargas: del tanque hacia las hojas.
    for (const n of nodes) {
      pressure[n.id] = n.baseline.pressureBar;
      delete hgl[n.id];
    }
    if (tank && tankHgl !== null) {
      hgl[tank.id] = tankHgl;
      pressure[tank.id] = tank.baseline.pressureBar + (input.tankHeadShiftM ?? 0) / M_PER_BAR;
      for (const id of topo.order) {
        if (hgl[id] === undefined) continue;
        for (const p of topo.childrenOf.get(id) ?? []) {
          const child = byId.get(p.to)!;
          hgl[p.to] = hgl[id] - hazenWilliamsHeadLossM(inflow[p.to], p.lengthM, p.diameterMm, p.hazenC ?? DEFAULT_HAZEN_C);
          pressure[p.to] = (hgl[p.to] - child.elevationM) / M_PER_BAR;
        }
      }
    }
    // Acople presión-fuga.
    let delta = 0;
    for (const l of leaks) {
      const from = byId.get(pipes.find((p) => p.id === l.pipeId)!.from)!;
      const p = Math.max(0.05, pressure[from.id]);
      const next = l.nominalFlowLs * Math.sqrt(p / Math.max(0.05, from.baseline.pressureBar));
      delta = Math.max(delta, Math.abs(next - leakFlow[l.pipeId]));
      leakFlow[l.pipeId] = next;
    }
    if (delta < 1e-9) break;
  }

  const pipeFlow: Record<string, number> = {};
  for (const p of pipes) pipeFlow[p.id] = inflow[p.to];
  return { inflowLs: inflow, pressureBar: pressure, hglM: hgl, pipeFlowLs: pipeFlow, leakFlowLs: leakFlow, iterations };
}

/**
 * Cotas coherentes con las presiones y caudales de la línea base: para cada nodo aguas abajo del tanque,
 * cota = carga hidráulica (a caudal base) − presión base. Evita la inconsistencia original (11 bar de carga estática
 * frente a 4.5 bar declarados) sin cambiar ninguna presión ni caudal de línea base.
 */
export function calibrateDownstreamElevations(nodes: NetworkNode[], pipes: PipeSegment[]): Record<string, number> {
  const topo = buildTopology(nodes, pipes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tank = nodes.find((n) => n.kind === 'tank');
  if (!tank) return {};
  const hgl: Record<string, number> = { [tank.id]: tank.elevationM + tank.baseline.pressureBar * M_PER_BAR };
  const out: Record<string, number> = {};
  for (const id of topo.order) {
    if (hgl[id] === undefined) continue;
    for (const p of topo.childrenOf.get(id) ?? []) {
      const child = byId.get(p.to)!;
      hgl[p.to] = hgl[id] - hazenWilliamsHeadLossM(child.baseline.flowLs, p.lengthM, p.diameterMm, p.hazenC ?? DEFAULT_HAZEN_C);
      out[p.to] = Number((hgl[p.to] - child.baseline.pressureBar * M_PER_BAR).toFixed(1));
    }
  }
  return out;
}
