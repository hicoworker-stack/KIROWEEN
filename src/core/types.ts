export type NodeKind = 'intake' | 'tank' | 'pump' | 'valve' | 'junction' | 'distribution';

export type HealthStatus = 'nominal' | 'warning' | 'critical' | 'fault';

export type AnomalyCategory =
  | 'leak'
  | 'obstruction'
  | 'sensor_fault'
  | 'contamination'
  | 'quality_drift'
  | 'nominal';

export type PriorityLevel = 'Crítica' | 'Alta' | 'Media' | 'Baja';

export type WorkOrderStatus = 'Abierta' | 'En Progreso' | 'Cerrada';

export type ScenarioId = 'leak' | 'obstruction' | 'sensor_fault' | 'contamination';

export interface TelemetryReading {
  id: string;
  timestamp: string;
  nodeId: string;
  pressureBar: number;
  flowLs: number;
  levelPct: number;
  turbidityNtu: number;
  chlorineMgL: number;
  ph: number;
  valveState?: 'open' | 'closed' | 'throttled';
  synthetic: boolean;
}

export interface NodeBaseline {
  pressureBar: number;
  flowLs: number;
  levelPct: number;
  turbidityNtu: number;
  chlorineMgL: number;
  ph: number;
}

export interface NetworkNode {
  id: string;
  name: string;
  sector: string;
  kind: NodeKind;
  x: number;
  y: number;
  elevationM: number;
  populationServed: number;
  status: HealthStatus;
  baseline: NodeBaseline;
  current: TelemetryReading;
  assetCode: string;
  material: string;
  diameterMm: number;
}

export interface PipeSegment {
  id: string;
  from: string;
  to: string;
  diameterMm: number;
  lengthM: number;
  material: string;
  status: HealthStatus;
}

export interface DeterministicRuleHit {
  ruleId:
    | 'PRESSURE_DROP_LEAK'
    | 'FLOW_OBSTRUCTION'
    | 'SENSOR_PHYSICAL_IMPLAUSIBILITY'
    | 'SENSOR_STUCK_AT_VALUE'
    | 'QUALITY_PARAMETER_ANOMALY'
    | 'HYDRAULIC_MASS_IMBALANCE';
  title: string;
  category: AnomalyCategory;
  severityScore: number;
  metric: string;
  observedValue: number;
  baselineValue: number;
  deltaPct: number;
  explanation: string;
}

export interface PriorityBreakdown {
  totalScore: number;
  priority: PriorityLevel;
  hydraulicWeight: number;
  populationWeight: number;
  qualityWeight: number;
  evidenceWeight: number;
  formulaNote: string;
}

export interface AnomalyEvent {
  id: string;
  timestamp: string;
  nodeId: string;
  nodeName: string;
  sector: string;
  category: AnomalyCategory;
  title: string;
  status: 'active' | 'resolved';
  rulesTriggered: DeterministicRuleHit[];
  priority: PriorityBreakdown;
  telemetrySnapshot: TelemetryReading;
  baselineSnapshot: NodeBaseline;
  correlatedUpstreamNodeId?: string;
  downstreamAffectedNodeIds?: string[];
  downstreamPopulationAffected?: number;
  massBalanceDeltaLs?: number;
  scenarioId?: ScenarioId;
  synthetic: boolean;
}

export interface MassBalanceReport {
  nodeId: string;
  nodeName: string;
  inflowLs: number;
  outflowSumLs: number;
  baselineResidualLs: number;
  currentResidualLs: number;
  deviationLs: number;
  imbalancePct: number;
  flagged: boolean;
}

export interface PropagatedNodeRisk {
  nodeId: string;
  sourceNodeId: string;
  sourceNodeName: string;
  sourceCategory: AnomalyCategory;
  impactLevel: 'high' | 'moderate';
  reason: string;
}

export interface HydraulicNetworkSummary {
  massBalances: MassBalanceReport[];
  propagatedByNode: Record<string, PropagatedNodeRisk>;
  affectedPipeIds: string[];
  totalAffectedPopulation: number;
}

export type AIEnrichmentStatus = 'pending' | 'live' | 'fallback';
export type AIFallbackReason = 'missing_key' | 'timeout' | 'api_error' | 'no_image';

export interface VisionAnalysisResult {
  id: string;
  timestamp: string;
  nodeId: string;
  imageUrl: string;
  imageTitle: string;
  providerUsed: string;
  providerMode: 'gemini-live' | 'fallback-adapter';
  enrichmentStatus?: AIEnrichmentStatus;
  fallbackReason?: AIFallbackReason;
  observed: string[];
  inferred: string[];
  cannotDetermine: string[];
  missingData: string[];
  sensorCorrelationSummary: string;
  confidenceLabel: string;
  /** Categoría que la imagen respalda por sí sola; 'inconclusive' si no discrimina. */
  visualCategory?: AnomalyCategory | 'inconclusive';
}

export interface AlternativeHypothesis {
  title: string;
  likelihood: 'Alta' | 'Media' | 'Baja';
  supportingEvidence: string;
  contradictingOrMissing: string;
}

export interface AquaBrainDiagnosis {
  id: string;
  anomalyId: string;
  timestamp: string;
  nodeId: string;
  nodeName: string;
  detectedProblem: string;
  availableEvidences: string[];
  primaryHypothesis: string;
  alternativeHypotheses: AlternativeHypothesis[];
  confidencePct: number;
  uncertaintyStatement: string;
  missingData: string[];
  potentialImpact: string;
  priority: PriorityLevel;
  priorityScore: number;
  recommendedAction: string;
  requiredResources: string[];
  interventionSteps: string[];
  operatorDecision: 'pending' | 'accepted' | 'modified' | 'rejected';
  operatorNote?: string;
  providerUsed: string;
  providerMode: 'gemini-live' | 'fallback-adapter';
  enrichmentStatus?: AIEnrichmentStatus;
  fallbackReason?: AIFallbackReason;
  visionAnalysisId?: string;
}

export interface SmartWorkOrder {
  id: string;
  diagnosisId: string;
  anomalyId: string;
  createdAt: string;
  updatedAt: string;
  location: string;
  nodeId: string;
  assetName: string;
  evidenceSummary: string[];
  probableCause: string;
  priority: PriorityLevel;
  requiredResources: string[];
  interventionSteps: string[];
  assignee: string;
  status: WorkOrderStatus;
  closureNotes?: string;
  closureEvidenceLabel?: string;
  /** M-10: checklist interactivo derivado de interventionSteps. */
  checklist?: ChecklistItem[];
  /** M-10: evidencia fotográfica de cierre (el archivo vive en el almacén de evidencias; aquí solo metadatos + SHA-256). */
  closureEvidence?: ClosureEvidence;
  ledgerHash?: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  doneAt?: string;
  doneBy?: string;
}

export interface ClosureEvidence {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  attachedAt: string;
  attachedBy: string;
}

export interface TrustLedgerEntry {
  id: string;
  index: number;
  timestamp: string;
  action: string;
  actor: string;
  assetId: string;
  evidenceSummary: string;
  previousState: string;
  newState: string;
  evidenceHash: string;
  previousHash: string;
  hash: string;
  /** Datos que respaldan evidenceHash (SHA-256 de su JSON). Permite verificar el contenido, no solo el resumen. */
  evidenceData?: unknown;
}

export interface ChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  brokenIndex: number | null;
  reason?: string;
  verifiedAt: string;
}

export interface OfflineReportRecord {
  id: string;
  idempotencyKey: string;
  createdAt: string;
  nodeId: string;
  category: AnomalyCategory;
  reporterName: string;
  description: string;
  photoDataUrl?: string;
  syncStatus: 'pending' | 'synced' | 'duplicate' | 'conflict';
  syncNote?: string;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  shortTitle: string;
  nodeId: string;
  category: AnomalyCategory;
  summary: string;
  imageUrl?: string;
  imageTitle?: string;
  injectedReading: Omit<TelemetryReading, 'id' | 'timestamp'>;
}

export interface CsvParseResult {
  readings: TelemetryReading[];
  errors: string[];
  rowCount: number;
}



