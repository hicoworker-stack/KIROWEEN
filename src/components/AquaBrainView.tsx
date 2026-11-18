import React, { useEffect, useRef, useState } from 'react';
import { Check, Edit3, XCircle, Cpu, ArrowRight } from 'lucide-react';
import { AnomalyEvent, AquaBrainDiagnosis, NetworkNode, PipeSegment, VisionAnalysisResult } from '../core/types';
import { calibratedConfidence, evaluateConcordance } from '../core/evidenceConcordance';
import { localizeLeak } from '../core/leakForensics';
import { ConcordancePanel } from './EvidencePanels';

interface AquaBrainViewProps {
  diagnoses: AquaBrainDiagnosis[];
  anomalies: AnomalyEvent[];
  nodes?: NetworkNode[];
  pipes?: PipeSegment[];
  visionAnalyses?: VisionAnalysisResult[];
  selectedNodeId: string;
  onGenerateDiagnosis: (anomalyId: string) => Promise<void>;
  onDecideDiagnosis: (
    diagnosisId: string,
    payload: {
      decision: 'accepted' | 'modified' | 'rejected';
      operatorNote?: string;
      modifiedAction?: string;
      modifiedPriority?: AquaBrainDiagnosis['priority'];
    }
  ) => Promise<void>;
  onNavigateToWorkOrders: () => void;
}

export const AquaBrainView: React.FC<AquaBrainViewProps> = ({
  diagnoses,
  anomalies,
  nodes = [],
  pipes = [],
  visionAnalyses = [],
  selectedNodeId,
  onGenerateDiagnosis,
  onDecideDiagnosis,
  onNavigateToWorkOrders,
}) => {
  const [selectedDiagnosisId, setSelectedDiagnosisId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedAction, setEditedAction] = useState('');
  const [editedPriority, setEditedPriority] = useState<AquaBrainDiagnosis['priority']>('Alta');
  const [operatorNote, setOperatorNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const prevNodeIdRef = useRef(selectedNodeId);
  const prevTopDiagIdRef = useRef<string | undefined>(diagnoses[0]?.id);

  useEffect(() => {
    const nodeChanged = prevNodeIdRef.current !== selectedNodeId;
    const newTopArrived = diagnoses[0]?.id && diagnoses[0].id !== prevTopDiagIdRef.current;

    if (nodeChanged) {
      const nodeMatch = diagnoses.find((d) => d.nodeId === selectedNodeId);
      setSelectedDiagnosisId(nodeMatch?.id ?? diagnoses[0]?.id ?? null);
    } else if (newTopArrived) {
      setSelectedDiagnosisId(diagnoses[0].id);
    } else if (selectedDiagnosisId && !diagnoses.some((d) => d.id === selectedDiagnosisId)) {
      const nodeMatch = diagnoses.find((d) => d.nodeId === selectedNodeId);
      setSelectedDiagnosisId(nodeMatch?.id ?? diagnoses[0]?.id ?? null);
    }

    prevNodeIdRef.current = selectedNodeId;
    prevTopDiagIdRef.current = diagnoses[0]?.id;
  }, [selectedNodeId, diagnoses, selectedDiagnosisId]);

  const activeDiagnosis =
    (selectedDiagnosisId ? diagnoses.find((d) => d.id === selectedDiagnosisId) : undefined) ??
    diagnoses.find((d) => d.nodeId === selectedNodeId) ??
    diagnoses[0] ??
    null;

  const activeAnomaly = activeDiagnosis ? anomalies.find((a) => a.id === activeDiagnosis.anomalyId) ?? null : null;
  const activeVision = activeDiagnosis
    ? visionAnalyses.find((v) => v.id === activeDiagnosis.visionAnalysisId) ?? visionAnalyses.find((v) => v.nodeId === activeDiagnosis.nodeId) ?? null
    : null;
  const concordance = activeAnomaly
    ? evaluateConcordance({
        anomaly: activeAnomaly,
        vision: activeVision,
        forensics: activeAnomaly.category === 'leak' && nodes.length > 0 ? localizeLeak(nodes, pipes, { photoNodeIds: activeVision ? [activeVision.nodeId] : [] }) : null,
      })
    : null;
  const calibratedPct = activeDiagnosis && concordance ? calibratedConfidence(activeDiagnosis.confidencePct, concordance) : activeDiagnosis?.confidencePct ?? 0;

  const pendingAnomaliesWithoutDiagnosis = anomalies.filter(
    (a) => a.status === 'active' && !diagnoses.some((d) => d.anomalyId === a.id)
  );

  const handleDecision = async (
    diag: AquaBrainDiagnosis,
    decision: 'accepted' | 'modified' | 'rejected'
  ) => {
    setSubmitting(true);
    try {
      await onDecideDiagnosis(diag.id, {
        decision,
        operatorNote:
          operatorNote ||
          (decision === 'accepted'
            ? 'Aprobado por operador central tras revisión de evidencias.'
            : decision === 'modified'
              ? 'Acción ajustada por criterio operativo local.'
              : 'Descartado por el operador.'),
        modifiedAction: decision === 'modified' ? editedAction : undefined,
        modifiedPriority: decision === 'modified' ? editedPriority : undefined,
      });
      setEditingId(null);
      setOperatorNote('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Aqua Brain — Motor Híbrido de Decisión</h2>
          <p className="text-xs text-slate-400 mt-1">
            Integra reglas deterministas, correlación multimodal y agente IA explicable. El operador
            humano conserva autoridad final para aprobar, modificar o rechazar.
          </p>
        </div>

        {pendingAnomaliesWithoutDiagnosis.length > 0 && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => onGenerateDiagnosis(pendingAnomaliesWithoutDiagnosis[0].id)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Cpu className="w-3.5 h-3.5" />
            Diagnosticar Anomalía Pendiente
          </button>
        )}
      </section>

      {!activeDiagnosis ? (
        <section className="bg-[#0A1D29] border border-dashed border-[#18364A] rounded-xl p-12 text-center space-y-3">
          <Cpu className="w-7 h-7 text-cyan-400 mx-auto" />
          <h3 className="text-base font-semibold text-white">Sin diagnósticos activos en cola</h3>
          <p className="text-xs text-slate-400 max-w-lg mx-auto">
            Activa uno de los 4 escenarios en el Command Center o ingesta datos anómalos en Sensores
            para observar cómo Aqua Brain correlaciona evidencias y formula hipótesis.
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Diagnosis Queue Sidebar */}
          <aside className="xl:col-span-4 bg-[#0A1D29] border border-[#18364A] rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-white px-1">Diagnósticos Recientes</h3>
            <div className="space-y-2">
              {diagnoses.map((d) => {
                const isSelected = d.id === activeDiagnosis.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedDiagnosisId(d.id);
                      setEditingId(null);
                      setOperatorNote('');
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#0F2736] border-cyan-400'
                        : 'bg-[#06131C] border-[#18364A] hover:border-[#234C66] hover:bg-[#0A1F2D]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-white">{d.nodeName}</span>
                      <span className="font-mono text-cyan-300 tabular-nums">
                        {d.priorityScore}/100
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1 line-clamp-2">{d.detectedProblem}</p>
                    <div className="mt-2 flex items-center justify-between text-xs font-mono">
                      <span
                        className={
                          d.operatorDecision === 'accepted' || d.operatorDecision === 'modified'
                            ? 'text-emerald-400'
                            : d.operatorDecision === 'rejected'
                              ? 'text-rose-400'
                              : 'text-amber-400'
                        }
                      >
                        {d.operatorDecision === 'pending'
                          ? '● Pendiente de decisión'
                          : d.operatorDecision === 'accepted'
                            ? '✓ Aprobado'
                            : d.operatorDecision === 'modified'
                              ? '✓ Modificado'
                              : '✖ Rechazado'}
                      </span>
                      <span className="text-slate-400">{d.confidencePct}% conf.</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Main Explainable Reasoning Panel */}
          <section className="xl:col-span-8 bg-[#0A1D29] border border-[#18364A] rounded-xl p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#18364A] pb-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400">
                  <span className="text-cyan-400">{activeDiagnosis.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{activeDiagnosis.nodeId}</span>
                  <span aria-hidden="true">·</span>
                  <span>{activeDiagnosis.providerUsed}</span>
                </div>
                <h3 className="text-lg font-semibold text-white">{activeDiagnosis.detectedProblem}</h3>
              </div>

              <div className="text-right font-mono tabular-nums shrink-0">
                <div className="text-sm font-semibold text-rose-400">
                  Prioridad {activeDiagnosis.priority} ({activeDiagnosis.priorityScore}/100)
                </div>
                <div className="text-xs text-cyan-300 mt-0.5">
                  Confianza calibrada: {calibratedPct}%
                </div>
              </div>
            </div>

            {concordance && (
              <ConcordancePanel report={concordance} rawConfidencePct={activeDiagnosis.confidencePct} calibratedPct={calibratedPct} />
            )}

            {/* Primary Hypothesis & Impact */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">
                  Hipótesis Primaria
                </h4>
                <p className="text-sm text-slate-100 leading-relaxed">
                  {activeDiagnosis.primaryHypothesis}
                </p>
              </div>
              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
                  Impacto Potencial
                </h4>
                <p className="text-sm text-slate-200 leading-relaxed">
                  {activeDiagnosis.potentialImpact}
                </p>
              </div>
            </div>

            {/* Available Evidences & Uncertainty */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                  Evidencias Correlacionadas
                </h4>
                <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                  {activeDiagnosis.availableEvidences.map((ev, i) => (
                    <li key={i}>{ev}</li>
                  ))}
                </ul>
              </div>

              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-rose-300 uppercase tracking-wider">
                  Incertidumbre y Datos Faltantes
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {activeDiagnosis.uncertaintyStatement}
                </p>
                <ul className="space-y-1 text-xs text-slate-400 list-disc pl-4 pt-1">
                  {activeDiagnosis.missingData.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Alternative Hypotheses */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Hipótesis y Causas Alternativas Evaluadas
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeDiagnosis.alternativeHypotheses.map((alt, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-lg bg-[#06131C] border border-[#18364A] space-y-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-100">{alt.title}</span>
                      <span className="font-mono text-slate-400">Prob. {alt.likelihood}</span>
                    </div>
                    <p className="text-slate-400">A favor: {alt.supportingEvidence}</p>
                    <p className="text-slate-400">Descarte / faltante: {alt.contradictingOrMissing}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Recommended Action & Operator Decision */}
            <div className="p-4 rounded-lg bg-[#071B28] border border-cyan-500/40 space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">
                  Acción Operativa Recomendada
                </h4>
                <p className="text-sm text-white mt-1 leading-relaxed">
                  {activeDiagnosis.recommendedAction}
                </p>
              </div>

              {editingId === activeDiagnosis.id && (
                <div className="space-y-3 pt-2 border-t border-[#18364A]">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs text-slate-300 mb-1">
                        Acción modificada por operador
                      </label>
                      <input
                        type="text"
                        value={editedAction}
                        onChange={(e) => setEditedAction(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#234C66] rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-300 mb-1">Prioridad ajustada</label>
                      <select
                        value={editedPriority}
                        onChange={(e) =>
                          setEditedPriority(e.target.value as AquaBrainDiagnosis['priority'])
                        }
                        className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#234C66] rounded-lg"
                      >
                        <option value="Crítica">Crítica</option>
                        <option value="Alta">Alta</option>
                        <option value="Media">Media</option>
                        <option value="Baja">Baja</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {activeDiagnosis.operatorDecision === 'pending' ? (
                <div className="space-y-3 pt-2 border-t border-[#18364A]">
                  <input
                    type="text"
                    placeholder="Nota opcional del operador para el Trust Ledger (motivo o instrucción)..."
                    value={operatorNote}
                    onChange={(e) => setOperatorNote(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#06131C] text-slate-100 border border-[#18364A] rounded-lg focus:outline-none focus:border-cyan-400"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleDecision(activeDiagnosis, 'accepted')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-[#04140E] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Aceptar y Generar Orden de Trabajo
                    </button>

                    {editingId === activeDiagnosis.id ? (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleDecision(activeDiagnosis, 'modified')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Confirmar Modificación y Emitir Orden
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(activeDiagnosis.id);
                          setEditedAction(activeDiagnosis.recommendedAction);
                          setEditedPriority(activeDiagnosis.priority);
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-slate-200 border border-[#234C66] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Modificar Recomendación
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleDecision(activeDiagnosis, 'rejected')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#06131C] hover:bg-rose-950/50 text-rose-300 border border-rose-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Rechazar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="pt-2 border-t border-[#18364A] flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-300">
                    Decisión registrada:{' '}
                    <span className="font-semibold text-emerald-400">
                      {activeDiagnosis.operatorDecision.toUpperCase()}
                    </span>
                    {activeDiagnosis.operatorNote ? ` · ${activeDiagnosis.operatorNote}` : ''}
                  </div>
                  {(activeDiagnosis.operatorDecision === 'accepted' ||
                    activeDiagnosis.operatorDecision === 'modified') && (
                    <button
                      type="button"
                      onClick={onNavigateToWorkOrders}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      Ir a Órdenes de Trabajo
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

