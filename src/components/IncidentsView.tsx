import { tr } from '../ui/engineText';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, CheckCircle2, CircleSlash, Cpu, FilePlus2, HelpCircle, MinusCircle, Pencil, ShieldCheck, XCircle } from 'lucide-react';
import { prepareImage } from '../client/image';
import { can, Role } from '../core/permissions';
import { ConcordanceReport, evaluateConcordance } from '../core/evidenceConcordance';
import { selectVisionForAnomaly } from '../core/evidenceLinking';
import { HydraulicDiagnosis, toHydraulicEvidence } from '../core/hydraulicDiagnosis';
import { AnomalyEvent, AquaBrainDiagnosis, NetworkNode, PriorityLevel, SmartWorkOrder, VisionAnalysisResult } from '../core/types';
import {
  byUrgency,
  channelLabel,
  channelProvenance,
  diagnosisProvenance,
  EVIDENCE_LEVEL_PLAIN,
  evidenceBasisLabels,
  HYDRAULIC_PLAIN,
  incidentProvenance,
  incidentTitle,
  incidentWhatHappens,
  likelihoodPlain,
  roleLabel,
  timeAgo,
  urgency,
} from '../ui/vocab';
import { t } from '../ui/i18n';
import { ConcordancePanel, HydraulicPanel } from './EvidencePanels';
import { Button, ConfirmDialog, Disclosure, EmptyState, Notice, ProvenanceBadge, ProvenanceRow, Question, Skeleton, StatusPill, TONE } from './ui';

export interface IncidentsViewProps {
  nodes: NetworkNode[];
  anomalies: AnomalyEvent[];
  diagnoses: AquaBrainDiagnosis[];
  visionAnalyses: VisionAnalysisResult[];
  workOrders: SmartWorkOrder[];
  hydraulic: HydraulicDiagnosis | null;
  role: Role;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGenerateDiagnosis: (anomalyId: string) => Promise<void>;
  onDecide: (
    diagnosisId: string,
    payload: { decision: 'accepted' | 'modified' | 'rejected'; operatorNote?: string; modifiedAction?: string; modifiedPriority?: PriorityLevel }
  ) => Promise<void>;
  onAddPhoto: (nodeId: string, dataUrl: string, title: string) => Promise<void>;
  onOpenOrder: (orderId: string) => void;
  onReport: () => void;
  onOpenAdvanced: () => void;
}

const verdictOf = (v: string): { label: string; className: string; Icon: React.FC<{ className?: string }> } =>
  ({
    supports: { label: t('Respalda', 'Supports'), className: 'text-ok', Icon: CheckCircle2 },
    contradicts: { label: t('Contradice', 'Contradicts'), className: 'text-critical', Icon: CircleSlash },
    neutral: { label: t('No concluyente', 'Inconclusive'), className: 'text-attention', Icon: MinusCircle },
    missing: { label: t('Sin datos', 'No data'), className: 'text-quiet', Icon: HelpCircle },
  })[v] ?? { label: v, className: 'text-quiet', Icon: HelpCircle };

const URGENCY_OPTIONS: PriorityLevel[] = ['Crítica', 'Alta', 'Media', 'Baja'];

/** Estado de un incidente en una frase corta, para la lista. */
function incidentStatus(a: AnomalyEvent, d: AquaBrainDiagnosis | undefined, order: SmartWorkOrder | undefined): { label: string; tone: 'ok' | 'attention' | 'neutral' | 'verifying' } {
  if (a.status === 'resolved') return { label: t('Resuelto', 'Resolved'), tone: 'ok' };
  if (order) return { label: order.status === 'Abierta' ? t('Orden sin iniciar', 'Order not started') : t('Orden en curso', 'Order in progress'), tone: 'neutral' };
  if (!d) return { label: t('Falta el diagnóstico', 'Diagnosis missing'), tone: 'attention' };
  if (d.operatorDecision === 'pending') return { label: t('Esperando decisión', 'Waiting for a decision'), tone: 'attention' };
  if (d.operatorDecision === 'rejected') return { label: t('Recomendación descartada', 'Recommendation dismissed'), tone: 'neutral' };
  return { label: t('Decidido', 'Decided'), tone: 'neutral' };
}

export const IncidentsView: React.FC<IncidentsViewProps> = (p) => {
  const [filter, setFilter] = useState<'active' | 'resolved'>('active');
  const [editing, setEditing] = useState(false);
  const [editedAction, setEditedAction] = useState('');
  const [editedPriority, setEditedPriority] = useState<PriorityLevel>('Alta');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  const sorted = [...p.anomalies].sort((a, b) => (a.status === b.status ? byUrgency(a, b) : a.status === 'active' ? -1 : 1));
  const shown = sorted.filter((a) => a.status === filter);
  const diagFor = (id: string) => p.diagnoses.find((d) => d.anomalyId === id);
  const orderFor = (id: string) => p.workOrders.find((o) => o.anomalyId === id);

  // En pantallas grandes se abre el más urgente automáticamente; en el móvil se muestra primero la lista.
  useEffect(() => {
    if (p.selectedId || typeof window === 'undefined' || !window.matchMedia?.('(min-width: 1024px)').matches) return;
    if (shown[0]) p.onSelect(shown[0].id);
  }, [p.selectedId, shown[0]?.id]);
  useEffect(() => {
    setEditing(false);
    setNote('');
    setError(null);
  }, [p.selectedId]);

  const selected = p.anomalies.find((a) => a.id === p.selectedId) ?? null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('No se pudo completar la acción.', 'The action could not be completed.'));
    } finally {
      setBusy(null);
    }
  };

  if (p.loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t('Cargando incidentes', 'Loading incidents')}>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold text-ink">{t('Incidentes', 'Incidents')}</h1>
          <p className="text-base text-soft">{t('Lo que el sistema detectó, ordenado por urgencia.', 'What the system detected, ordered by urgency.')}</p>
        </div>
        {can(p.role, 'offline:sync') && (
          <Button variant="secondary" onClick={p.onReport} icon={<FilePlus2 className="h-4 w-4" />}>
            {t('Reportar un problema', 'Report a problem')}
          </Button>
        )}
      </header>

      <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
        {/* Lista */}
        <section aria-label={t('Lista de incidentes', 'Incident list')} className={selected ? 'hidden lg:block' : ''}>
          <div role="group" aria-label={t('Filtrar incidentes', 'Filter incidents')} className="mb-3 flex gap-2">
            {(['active', 'resolved'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`min-h-11 cursor-pointer rounded-lg border px-4 text-sm font-medium ${filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-line text-soft hover:text-ink'}`}
              >
                {f === 'active' ? t(`Activos (${p.anomalies.filter((a) => a.status === 'active').length})`, `Active (${p.anomalies.filter((a) => a.status === 'active').length})`) : t(`Resueltos (${p.anomalies.filter((a) => a.status === 'resolved').length})`, `Resolved (${p.anomalies.filter((a) => a.status === 'resolved').length})`)}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="h-8 w-8" />} title={filter === 'active' ? t('No hay incidentes activos', 'There are no active incidents') : t('Aún no hay incidentes resueltos', 'There are no resolved incidents yet')}>
              {filter === 'active' ? t('Cuando el sistema detecte algo fuera de lo normal, aparecerá aquí con una recomendación.', 'When the system detects something out of range, it will appear here with a recommendation.') : t('Los incidentes se marcan como resueltos al cerrar su orden de trabajo.', 'Incidents are marked as resolved when their work order is closed.')}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {shown.map((a) => {
                const u = urgency(a.priority.priority);
                const st = incidentStatus(a, diagFor(a.id), orderFor(a.id));
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      aria-current={a.id === p.selectedId ? 'true' : undefined}
                      onClick={() => p.onSelect(a.id)}
                      className={`flex min-h-16 w-full cursor-pointer flex-col gap-1.5 px-4 py-3.5 text-left hover:bg-raised/60 ${a.id === p.selectedId ? 'bg-raised' : ''}`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-base font-medium leading-snug text-ink">{incidentTitle(a)}</span>
                        {a.status === 'active' && <StatusPill tone={u.tone} label={u.label} className="shrink-0" />}
                      </span>
                      <span className="text-sm text-quiet">
                        {a.sector} · {timeAgo(a.timestamp)}
                      </span>
                      <span className={`text-sm ${TONE[st.tone].text}`}>{st.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Detalle */}
        <section aria-label={t('Detalle del incidente', 'Incident details')} className={selected ? '' : 'hidden lg:block'}>
          {!selected ? (
            <EmptyState icon={<Cpu className="h-8 w-8" />} title={t('Elige un incidente', 'Choose an incident')}>
              {t('Verás qué está pasando, qué significa y qué hacer.', 'You will see what is happening, what it means and what to do.')}
            </EmptyState>
          ) : (
            (() => {
              const a = selected;
              const d = diagFor(a.id);
              const order = orderFor(a.id);
              const vision = selectVisionForAnomaly(p.visionAnalyses, a);
              const hydroEvidence = p.hydraulic ? toHydraulicEvidence(p.hydraulic, a.nodeId) : null;
              const concordance: ConcordanceReport = evaluateConcordance({ anomaly: a, vision, hydraulic: hydroEvidence });
              const basis = evidenceBasisLabels(a, d ?? null);
              const u = urgency(d?.priority ?? a.priority.priority);
              const level = EVIDENCE_LEVEL_PLAIN[concordance.level];
              const mayDecide = can(p.role, 'diagnosis:decide');
              const mayDiagnose = can(p.role, 'ai:use');
              const visionIsAi = Boolean(vision && vision.analysisStatus === 'analyzed' && vision.providerMode === 'gemini-live');

              const decide = (decision: 'accepted' | 'modified' | 'rejected') =>
                run(decision, async () => {
                  await p.onDecide(d!.id, {
                    decision,
                    operatorNote: note.trim() || (decision === 'accepted' ? t('Aceptada desde la interfaz.', 'Accepted from the interface.') : decision === 'modified' ? t('Recomendación modificada desde la interfaz.', 'Recommendation modified from the interface.') : t('Descartada desde la interfaz.', 'Dismissed from the interface.')),
                    modifiedAction: decision === 'modified' ? editedAction : undefined,
                    modifiedPriority: decision === 'modified' ? editedPriority : undefined,
                  });
                  setEditing(false);
                  setNote('');
                  setConfirmReject(false);
                });

              return (
                <article className="space-y-8" aria-labelledby="inc-title">
                  <div className="space-y-3">
                    <button type="button" onClick={() => p.onSelect(null)} className="-ml-2 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-soft hover:text-ink lg:hidden">
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('Volver a la lista', 'Back to the list')}
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      {a.status === 'active' ? <StatusPill tone={u.tone} label={u.label} /> : <StatusPill tone="ok" label={t('Resuelto', 'Resolved')} />}
                      <ProvenanceRow kinds={incidentProvenance(a)} />
                    </div>
                    <h2 id="inc-title" className="font-display text-2xl font-semibold leading-tight text-ink">
                      {incidentTitle(a)}
                    </h2>
                    <p className="text-sm text-quiet">
                      {a.nodeName} · {a.sector} · {t('detectado', 'detected')} {timeAgo(a.timestamp)}
                    </p>
                  </div>

                  {error && (
                    <Notice tone="critical" live="assertive">
                      {error}
                    </Notice>
                  )}

                  <Question q={t('Qué está pasando', 'What is happening')} id="q-what">
                    <p className="text-base leading-relaxed text-ink">{incidentWhatHappens(a)}</p>
                  </Question>

                  <Question q={t('Qué significa', 'What it means')} id="q-meaning">
                    {d ? (
                      <div className="space-y-4">
                        <p className="text-base leading-relaxed text-ink">{tr(d.potentialImpact)}</p>
                        {typeof a.downstreamPopulationAffected === 'number' && a.downstreamPopulationAffected > 0 && (
                          <p className="text-sm text-soft">{t(`Podría afectar a hasta ${a.downstreamPopulationAffected.toLocaleString('es-ES')} personas (estimación según la población que abastece cada punto).`, `It could affect up to ${a.downstreamPopulationAffected.toLocaleString('en-US')} people (estimate based on the population each point serves).`)}</p>
                        )}
                        <div className="space-y-1.5">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-soft">
                            {t('Causa más probable', 'Most likely cause')} <ProvenanceBadge kind={diagnosisProvenance(d)} />
                          </p>
                          <p className="text-base leading-relaxed text-ink">{tr(d.primaryHypothesis)}</p>
                          <p className="text-sm text-quiet">{t('Es una hipótesis para decidir mejor, no un hecho confirmado.', 'It is a hypothesis to help decide, not a confirmed fact.')}</p>
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-sm font-semibold text-soft">
                            {t('Qué tan respaldado está:', 'How well supported it is:')}{' '}
                            <span className={concordance.level === 'en_conflicto' ? 'text-critical' : concordance.level === 'alta' ? 'text-ok' : 'text-attention'}>{level.label}</span>
                          </p>
                          <p className="text-sm text-soft">{level.help}</p>
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-sm font-semibold text-soft">{t('Qué no sabemos', 'What we do not know')}</p>
                          <p className="text-sm leading-relaxed text-soft">{tr(d.uncertaintyStatement)}</p>
                          {d.missingData.length > 0 && (
                            <ul className="list-disc space-y-0.5 pl-5 text-sm text-quiet">
                              {d.missingData.slice(0, 3).map((m, i) => (
                                <li key={i}>{tr(m)}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-base leading-relaxed text-soft">{t('Todavía no hay diagnóstico. Un diagnóstico propone la causa más probable y la acción a tomar.', 'There is no diagnosis yet. A diagnosis proposes the most likely cause and the action to take.')}</p>
                    )}
                  </Question>

                  <Question q={t('Qué debo hacer', 'What should I do')} id="q-todo">
                    {order ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                        <p className="text-base text-ink">
                          {t('Ya existe la orden de trabajo', 'Work order')} <strong>{order.id}</strong>{t('', ' already exists')} ({order.status === 'Abierta' ? t('sin iniciar', 'not started') : order.status === 'En Progreso' ? t('en curso', 'in progress') : t('cerrada', 'closed')}).
                        </p>
                        <Button variant="primary" onClick={() => p.onOpenOrder(order.id)} icon={<ArrowRight className="h-4 w-4" />}>
                          {t('Abrir la orden', 'Open the order')}
                        </Button>
                      </div>
                    ) : !d ? (
                      mayDiagnose ? (
                        <Button variant="primary" busy={busy === 'diagnose'} onClick={() => run('diagnose', () => p.onGenerateDiagnosis(a.id))} icon={<Cpu className="h-4 w-4" />}>
                          {t('Pedir el diagnóstico', 'Request the diagnosis')}
                        </Button>
                      ) : (
                        <p className="text-sm text-quiet">{t(`Un operador debe pedir el diagnóstico. Tu rol (${roleLabel(p.role)}) permite consultar.`, `An operator must request the diagnosis. Your role (${roleLabel(p.role)}) lets you view.`)}</p>
                      )
                    ) : d.operatorDecision === 'rejected' ? (
                      <p className="text-base text-soft">{t('Se descartó la recomendación', 'The recommendation was dismissed')}{d.operatorNote ? `: ${d.operatorNote}` : '.'}</p>
                    ) : (
                      <div className="space-y-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
                        <p className="text-base leading-relaxed text-ink">{tr(d.recommendedAction)}</p>
                        {d.operatorDecision === 'pending' &&
                          (mayDecide ? (
                            <div className="space-y-4">
                              {editing && (
                                <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                                  <div>
                                    <label htmlFor="edit-action" className="mb-1 block text-sm font-semibold text-ink">
                                      {t('Qué hacer, según tu criterio', 'What to do, in your judgment')}
                                    </label>
                                    <input id="edit-action" value={editedAction} onChange={(e) => setEditedAction(e.target.value)} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink" />
                                  </div>
                                  <div>
                                    <label htmlFor="edit-urgency" className="mb-1 block text-sm font-semibold text-ink">
                                      {t('Urgencia', 'Urgency')}
                                    </label>
                                    <select id="edit-urgency" value={editedPriority} onChange={(e) => setEditedPriority(e.target.value as PriorityLevel)} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink">
                                      {URGENCY_OPTIONS.map((o) => (
                                        <option key={o} value={o}>
                                          {urgency(o).label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              )}
                              <div>
                                <label htmlFor="inc-note" className="mb-1 block text-sm font-semibold text-ink">
                                  {t('Nota para el registro (opcional)', 'Note for the record (optional)')}
                                </label>
                                <input id="inc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t('Ej.: avisar a la escuela antes de cortar el agua', 'E.g. warn the school before shutting off the water')} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink placeholder:text-quiet" />
                              </div>
                              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                                {editing ? (
                                  <Button variant="primary" busy={busy === 'modified'} disabled={editedAction.trim().length < 3} onClick={() => decide('modified')} icon={<Check className="h-4 w-4" />}>
                                    {t('Crear la orden con este cambio', 'Create the order with this change')}
                                  </Button>
                                ) : (
                                  <>
                                    <Button variant="primary" busy={busy === 'accepted'} onClick={() => decide('accepted')} icon={<Check className="h-4 w-4" />}>
                                      {t('Aceptar y crear la orden de trabajo', 'Accept and create the work order')}
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      onClick={() => {
                                        setEditing(true);
                                        setEditedAction(d.recommendedAction);
                                        setEditedPriority(d.priority);
                                      }}
                                      icon={<Pencil className="h-4 w-4" />}
                                    >
                                      {t('Cambiar la recomendación', 'Change the recommendation')}
                                    </Button>
                                  </>
                                )}
                                {editing && (
                                  <Button variant="ghost" onClick={() => setEditing(false)}>
                                    {t('Volver a la recomendación original', 'Back to the original recommendation')}
                                  </Button>
                                )}
                                <Button variant="danger" onClick={() => setConfirmReject(true)} icon={<XCircle className="h-4 w-4" />}>
                                  {t('No aplicar', 'Do not apply')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-quiet">{t(`Tu rol (${roleLabel(p.role)}) permite consultar, no decidir. Un operador debe aceptar o descartar la recomendación.`, `Your role (${roleLabel(p.role)}) lets you view, not decide. An operator must accept or dismiss the recommendation.`)}</p>
                          ))}
                      </div>
                    )}
                  </Question>

                  <Question q={t('Evidencias', 'Evidence')} id="q-evidence">
                    {basis.warning && (
                      <Notice tone="attention" title={t('Ojo con el origen', 'Mind the source')}>
                        {basis.warning}
                      </Notice>
                    )}
                    <ul className="divide-y divide-line/70 rounded-xl border border-line bg-surface">
                      {concordance.channels.map((ch) => {
                        const v = verdictOf(ch.verdict);
                        return (
                          <li key={ch.channel} className="space-y-1.5 px-4 py-3.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="flex flex-wrap items-center gap-2 text-base font-medium text-ink">
                                {channelLabel(a, ch.channel)}
                                <ProvenanceRow kinds={channelProvenance(a, ch.channel, visionIsAi && ch.channel === 'fotografía')} />
                              </span>
                              <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${v.className}`}>
                                <v.Icon className="h-4 w-4" aria-hidden="true" />
                                {v.label}
                              </span>
                            </div>
                            <p className="text-sm leading-relaxed text-soft">{ch.channel === 'sensores' && a.origin === 'offline-report' ? t('Una persona lo reportó en campo. Ningún sensor lo ha confirmado.', 'A person reported it in the field. No sensor has confirmed it.') : tr(ch.detail)}</p>
                          </li>
                        );
                      })}
                    </ul>

                    {vision && (
                      <div className="flex flex-wrap items-start gap-4 rounded-xl border border-line bg-surface p-4">
                        <img src={vision.imageUrl} alt={t(`Fotografía vinculada a este incidente: ${vision.imageTitle}`, `Photo linked to this incident: ${tr(vision.imageTitle)}`)} className="h-24 w-36 rounded-lg border border-line-strong bg-canvas object-cover" onError={(e) => ((e.currentTarget.style.visibility = 'hidden'))} />
                        <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                          <p className="font-medium text-ink">{tr(vision.imageTitle)}</p>
                          {vision.analysisStatus === 'analyzed' ? (
                            <>
                              <p className="flex flex-wrap items-center gap-2 text-soft">
                                {t('Lo que la IA cree ver', 'What the AI thinks it sees')} <ProvenanceBadge kind={visionIsAi ? 'hipotesis_ia' : 'inferido'} />
                              </p>
                              <ul className="list-disc pl-5 text-soft">
                                {vision.observed.slice(0, 3).map((o, i) => (
                                  <li key={i}>{tr(o)}</li>
                                ))}
                              </ul>
                            </>
                          ) : (
                            <p className="text-soft">{t('La foto está guardada, pero nadie la analizó: no hay un servicio de visión conectado. No se usa como evidencia.', 'The photo is stored, but nobody analyzed it: no vision service is connected. It is not used as evidence.')}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {a.status === 'active' && can(p.role, 'ai:use') && (
                      <div>
                        <input
                          ref={photoRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          className="sr-only"
                          aria-label={t('Añadir una foto a este incidente', 'Add a photo to this incident')}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            void run('photo', async () => p.onAddPhoto(a.nodeId, await prepareImage(f), t(`Foto del incidente en ${a.nodeName}`, `Photo of the incident at ${a.nodeName}`)));
                          }}
                        />
                        <Button variant="secondary" busy={busy === 'photo'} onClick={() => photoRef.current?.click()} icon={<Camera className="h-4 w-4" />}>
                          {vision ? t('Añadir otra foto', 'Add another photo') : t('Añadir una foto', 'Add a photo')}
                        </Button>
                      </div>
                    )}
                  </Question>

                  <Disclosure summary={t('Detalles técnicos', 'Technical details')}>
                    {hydroEvidence && p.hydraulic && a.category === 'leak' && (
                      <>
                        <p className="text-sm text-soft">{HYDRAULIC_PLAIN[hydroEvidence.level]}</p>
                        <HydraulicPanel diagnosis={p.hydraulic} nodes={p.nodes} />
                      </>
                    )}
                    <ConcordancePanel report={concordance} />
                    {d && d.alternativeHypotheses.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold text-ink">{t('Otras causas que se evaluaron', 'Other causes that were evaluated')}</h4>
                        <ul className="space-y-2">
                          {d.alternativeHypotheses.map((alt, i) => (
                            <li key={i} className="rounded-lg border border-line p-3 text-sm">
                              <p className="font-medium text-ink">
                                {tr(alt.title)} · <span className="text-soft">{likelihoodPlain(alt.likelihood)}</span>
                              </p>
                              <p className="mt-1 text-soft">{t('A favor:', 'For:')} {tr(alt.supportingEvidence)}</p>
                              <p className="text-soft">{t('En contra o faltante:', 'Against or missing:')} {tr(alt.contradictingOrMissing)}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-quiet">{t('Incidente', 'Incident')}</dt>
                      <dd className="break-all font-mono text-soft">{a.id}</dd>
                      {d && (
                        <>
                          <dt className="text-quiet">{t('Diagnóstico', 'Diagnosis')}</dt>
                          <dd className="break-all font-mono text-soft">
                            {d.id} · {tr(d.providerUsed)}
                          </dd>
                          <dt className="text-quiet">{t('Puntuación interna', 'Internal score')}</dt>
                          <dd className="text-soft">{d.priorityScore} {t('de 100 (solo ordena la lista; no es una probabilidad)', 'of 100 (it only orders the list; it is not a probability)')}</dd>
                        </>
                      )}
                    </dl>
                    <Button variant="ghost" onClick={p.onOpenAdvanced}>
                      {t('Ir al registro verificable (Trust Ledger)', 'Go to the verifiable record (Trust Ledger)')}
                    </Button>
                  </Disclosure>

                  <ConfirmDialog
                    open={confirmReject}
                    title={t('¿No aplicar esta recomendación?', 'Do not apply this recommendation?')}
                    confirmLabel={t('Sí, no aplicar', 'Yes, do not apply')}
                    tone="danger"
                    busy={busy === 'rejected'}
                    onCancel={() => setConfirmReject(false)}
                    onConfirm={() => d && decide('rejected')}
                  >
                    {t('El incidente seguirá activo y no se creará ninguna orden. La decisión queda registrada en el Trust Ledger con tu nombre.', 'The incident will stay active and no order will be created. The decision is recorded in the Trust Ledger under your name.')}
                  </ConfirmDialog>
                </article>
              );
            })()
          )}
        </section>
      </div>
    </div>
  );
};
