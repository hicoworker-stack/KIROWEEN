import type { HydraulicLevel } from './hydraulicDiagnosis';
import type { RepairAssessment } from './repairVerification';

/**
 * REQ-SIM-01: contrato de la maqueta 3D de Inicio. Todo lo que la maqueta muestra sale de aquí, y esto lo calculan los motores
 * REALES del proyecto en el servidor (solver hidráulico → diagnóstico hidráulico → reglas de nodo → verificación de la reparación).
 * La interfaz no contiene ninguna regla ni umbral propios: solo dibuja estos resultados.
 *
 * Los datos son SINTÉTICOS (generador con semilla fija); la "verdad" de la fuga (truthLeakLps) solo existe porque es una simulación:
 * el motor nunca la ve, solo ve lecturas.
 */
export type PreviewTone = 'ok' | 'attention' | 'critical';
export type PreviewRepairMode = 'repaired' | 'unresolved' | 'sparse';
export const PREVIEW_REPAIR_MODES: readonly PreviewRepairMode[] = ['repaired', 'unresolved', 'sparse'];
export const PREVIEW_LEAK_RANGE = { min: 0, max: 16, step: 0.5, initial: 12 } as const;

export interface PreviewNodeReading {
  pressureBar: number;
  flowLs: number;
  baselinePressureBar: number;
  baselineFlowLs: number;
  /** Salida de los motores: regla de nodo (p. ej. caída de presión) o hallazgo del balance hidráulico. */
  tone: PreviewTone;
  /** Qué regla disparó el tono, si alguna. */
  rule?: string;
}

export interface PreviewSnapshot {
  nodes: Record<string, PreviewNodeReading>;
  /** Fuga REAL del escenario simulado (L/s). El motor no la conoce. */
  truthLeakLps: number;
}

export interface PreviewEngine {
  level: HydraulicLevel;
  /** Nodo medidor donde el balance hidráulico encuentra el exceso, si lo hay. */
  nodeId?: string;
  candidatePipeIds: string[];
  /** Balance de masa del nodo medidor (L/s). */
  balance?: { inflowLs: number; outflowLs: number; expectedLocalLs: number; excessLs: number; sigmaLs: number; detectionLimitLs: number };
  pressureVerdict?: string;
  pressureDetail?: string;
  rationale: string[];
  limits: string[];
}

export interface LeakPreview {
  synthetic: true;
  leakLps: number;
  repairMode: PreviewRepairMode;
  /** Instante de cierre de la orden en la simulación: solo cuentan mediciones posteriores. */
  closedAt: string;
  normal: PreviewSnapshot;
  leak: PreviewSnapshot;
  /** Estado tras la intervención: sin fuga si la reparación funcionó, con la fuga original si el problema persiste. */
  after: PreviewSnapshot;
  engine: PreviewEngine;
  repair: RepairAssessment;
}

export const clampPreviewLeak = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return PREVIEW_LEAK_RANGE.initial;
  const stepped = Math.round(n / PREVIEW_LEAK_RANGE.step) * PREVIEW_LEAK_RANGE.step;
  return Math.min(PREVIEW_LEAK_RANGE.max, Math.max(PREVIEW_LEAK_RANGE.min, stepped));
};
export const parsePreviewRepairMode = (v: unknown): PreviewRepairMode => (PREVIEW_REPAIR_MODES.includes(v as PreviewRepairMode) ? (v as PreviewRepairMode) : 'repaired');
