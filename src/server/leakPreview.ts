import { evaluateTelemetryReading } from '../core/deterministicEngine';
import { diagnoseHydraulics, HydraulicDiagnosis } from '../core/hydraulicDiagnosis';
import { clampPreviewLeak, LeakPreview, PreviewEngine, PreviewNodeReading, PreviewRepairMode, PreviewSnapshot, PreviewTone } from '../core/leakPreview';
import { createBaselineNodes, NETWORK_PIPES } from '../core/networkData';
import { assessRepair } from '../core/repairVerification';
import { NetworkNode, TelemetryReading } from '../core/types';
import { applyFrameToNodes, buildRepairFrames, DEMO_NOISE, DEMO_SEED, GeneratedFrame, generateFrames } from '../sim/scenarioGenerator';

/**
 * REQ-SIM-02: vista previa de una fuga para la maqueta 3D. Ejecuta los motores reales con datos sintéticos de semilla fija:
 *   solver hidráulico → lecturas con ruido → diagnóstico hidráulico (con su racha de evaluaciones) y reglas de cada nodo →
 *   cierre de la orden → mediciones posteriores → veredicto de reparación.
 * Es de solo lectura y determinista: no toca el estado del servidor, así que puede servirse al visitante público.
 */
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const STEP_MS = 5_000;
const LEAK_STEPS = 4;
const METER_NODE = 'N-TRON-04';
const LEAK_PIPE = 'P-05';
const REQUIRED_CONSECUTIVE = 2;

const baseNodes = createBaselineNodes();
const byId = new Map(baseNodes.map((n) => [n.id, n]));

/** Evalúa fotogramas en orden, manteniendo la racha de excesos igual que el servidor (runNetworkEvaluation). */
function diagnoseSequence(frames: GeneratedFrame[], streak: Record<string, number>): HydraulicDiagnosis {
  let last!: HydraulicDiagnosis;
  for (const f of frames) {
    last = diagnoseHydraulics(applyFrameToNodes(baseNodes, f), NETWORK_PIPES, { streak, requiredConsecutive: REQUIRED_CONSECUTIVE });
    for (const b of last.balances) {
      if (b.state === 'excess') streak[b.nodeId] = (streak[b.nodeId] ?? 0) + 1;
      else if (b.state !== 'not_evaluable') streak[b.nodeId] = 0;
    }
  }
  return last;
}

function toneFor(node: NetworkNode, reading: TelemetryReading, diag: HydraulicDiagnosis): { tone: PreviewTone; rule?: string } {
  const finding = diag.findings.find((f) => f.nodeId === node.id);
  if (finding) return { tone: finding.level === 'flow_anomaly' ? 'attention' : 'critical', rule: `balance hidráulico: ${finding.level}` };
  const hit = evaluateTelemetryReading(reading, node, []);
  if (hit) return { tone: hit.category === 'leak' || hit.category === 'contamination' ? 'critical' : 'attention', rule: hit.rulesTriggered[0]?.ruleId };
  return { tone: 'ok' };
}

function snapshotOf(frame: GeneratedFrame, diag: HydraulicDiagnosis): PreviewSnapshot {
  const nodes: Record<string, PreviewNodeReading> = {};
  for (const r of frame.readings) {
    const node = byId.get(r.nodeId)!;
    const t = toneFor(node, r, diag);
    nodes[r.nodeId] = { pressureBar: r.pressureBar, flowLs: r.flowLs, baselinePressureBar: node.baseline.pressureBar, baselineFlowLs: node.baseline.flowLs, ...t };
  }
  return { nodes, truthLeakLps: Number((frame.truth.leakFlowLs[LEAK_PIPE] ?? 0).toFixed(2)) };
}

function engineOf(diag: HydraulicDiagnosis): PreviewEngine {
  const finding = diag.findings.find((f) => f.nodeId === METER_NODE) ?? diag.findings[0];
  const bal = diag.balances.find((b) => b.nodeId === (finding?.nodeId ?? METER_NODE));
  return {
    level: diag.level,
    nodeId: finding?.nodeId ?? bal?.nodeId,
    candidatePipeIds: finding?.candidates.map((c) => c.pipeId) ?? [],
    balance: bal
      ? { inflowLs: bal.inflowLs, outflowLs: bal.outflowSumLs, expectedLocalLs: bal.expectedResidualLs, excessLs: bal.deviationLs, sigmaLs: bal.sigmaLs, detectionLimitLs: bal.detectionLimitLs }
      : undefined,
    pressureVerdict: finding?.pressure.verdict,
    pressureDetail: finding?.pressure.detail,
    rationale: finding?.rationale ?? [],
    limits: diag.limits,
  };
}

function compute(leakLps: number, mode: PreviewRepairMode): LeakPreview {
  const events = leakLps > 0 ? [{ type: 'leak' as const, pipeId: LEAK_PIPE, flowLs: leakLps, startStep: 0, rampSteps: 1 }] : [];
  const gen = (startMs: number, steps: number, ev: typeof events) => generateFrames({ seed: DEMO_SEED, startMs, stepMs: STEP_MS, steps, noise: DEMO_NOISE, events: ev });

  const normalFrames = gen(T0, LEAK_STEPS, []);
  const normalDiag = diagnoseSequence(normalFrames, {});
  const leakFrames = gen(T0, LEAK_STEPS, events);
  const streak: Record<string, number> = {};
  const leakDiag = diagnoseSequence(leakFrames, streak);

  // La orden se cierra tras la fase de detección; solo cuentan las mediciones más nuevas que todo lo conocido al cerrar.
  const closedMs = T0 + LEAK_STEPS * STEP_MS + 30_000;
  const repairFrames = buildRepairFrames(mode, 'leak', closedMs, leakLps > 0 ? leakLps : undefined);
  const afterDiag = diagnoseSequence(repairFrames, streak);

  const meter = byId.get(METER_NODE)!;
  const series = [...leakFrames, ...repairFrames].map((f) => f.readings.find((r) => r.nodeId === METER_NODE)!);
  const gateFinding = afterDiag.findings.find((f) => f.nodeId === METER_NODE);
  const repair = assessRepair({ node: meter, closedAt: new Date(closedMs).toISOString(), series, hydraulic: gateFinding ? { level: gateFinding.level, excessLs: gateFinding.excessLs } : null });

  return {
    synthetic: true,
    leakLps,
    repairMode: mode,
    closedAt: new Date(closedMs).toISOString(),
    normal: snapshotOf(normalFrames[normalFrames.length - 1], normalDiag),
    leak: snapshotOf(leakFrames[leakFrames.length - 1], leakDiag),
    after: snapshotOf(repairFrames[repairFrames.length - 1], afterDiag),
    engine: engineOf(leakDiag),
    repair,
  };
}

const cache = new Map<string, LeakPreview>();
export function buildLeakPreview(leakInput: unknown, modeInput: PreviewRepairMode): LeakPreview {
  const leakLps = clampPreviewLeak(leakInput);
  const key = `${leakLps}|${modeInput}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = compute(leakLps, modeInput);
    if (cache.size >= 200) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}
