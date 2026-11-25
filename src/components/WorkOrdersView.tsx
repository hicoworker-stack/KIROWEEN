import { tr, trList } from '../ui/engineText';
import React, { useRef, useState } from 'react';
import { ArrowLeft, Camera, CheckCircle2, ClipboardList, Download, Hourglass, PlayCircle, ShieldCheck, UserCog } from 'lucide-react';
import { prepareImage } from '../client/image';
import { can, Role } from '../core/permissions';
import { closureBlockers, ensureChecklist } from '../core/workOrders';
import { NetworkNode, SmartWorkOrder, TelemetryReading, TrustLedgerEntry, WorkOrderStatus } from '../core/types';
import { t } from '../ui/i18n';
import { repairPill, repairView } from '../ui/repairView';
import { roleLabel, timeAgo, urgency } from '../ui/vocab';
import { RepairVerificationPanel, SimulatedMeasurementMode } from './RepairVerificationPanel';
import { Button, ConfirmDialog, Disclosure, EmptyState, Notice, Question, Skeleton, StatusPill } from './ui';

export interface WorkOrdersViewProps {
  workOrders: SmartWorkOrder[];
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  /** Trust Ledger: de aquí sale el veredicto sellado de la reparación (VERIFIED o REOPENED). */
  ledger?: TrustLedgerEntry[];
  role: Role;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpdateOrder: (orderId: string, payload: { status: WorkOrderStatus; closureNotes?: string; closureEvidenceLabel?: string }) => Promise<void>;
  onAssignOrder: (orderId: string, assignee: string) => Promise<void>;
  onToggleChecklist: (orderId: string, itemId: string, done: boolean) => Promise<void>;
  onUploadEvidence: (orderId: string, fileName: string, dataUrl: string) => Promise<void>;
  onDownloadDossier: (orderId: string) => Promise<void>;
  onOpenLedger: () => void;
  onOpenIncident: (anomalyId: string) => void;
  /** Solo con permiso de escenarios: inyecta mediciones simuladas posteriores al cierre. */
  onSimulateMeasurements?: (orderId: string, mode: SimulatedMeasurementMode) => Promise<void>;
}

const statusLabel = (s: WorkOrderStatus) => (s === 'Abierta' ? t('Por iniciar', 'Not started') : s === 'En Progreso' ? t('En curso', 'In progress') : t('Cerrada', 'Closed'));

export const WorkOrdersView: React.FC<WorkOrdersViewProps> = (p) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [assignee, setAssignee] = useState('');
  const [changingAssignee, setChangingAssignee] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // Marcas optimistas: la casilla responde al instante y se revierte si el servidor rechaza el cambio.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const rank = (o: SmartWorkOrder) => (o.status === 'Cerrada' ? 1 : 0);
  const sorted = [...p.workOrders].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
  const selectedRaw = p.workOrders.find((o) => o.id === p.selectedId) ?? null;
  const order = selectedRaw ? ensureChecklist(selectedRaw) : null;
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
      <div className="space-y-4" aria-busy="true" aria-label={t('Cargando órdenes de trabajo', 'Loading work orders')}>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const mayWrite = can(p.role, 'order:write');
  const mayPhoto = can(p.role, 'order:evidence');
  const mayExport = can(p.role, 'dossier:export');

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">{t('Órdenes de trabajo', 'Work orders')}</h1>
        <p className="text-base text-soft">{t('Cada orden nace de una recomendación aceptada. Se cierra con la lista de tareas completa y una foto.', 'Each order comes from an accepted recommendation. It is closed with every task done and a photo.')}</p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
        <section aria-label={t('Lista de órdenes', 'Order list')} className={order ? 'hidden lg:block' : ''}>
          {sorted.length === 0 ? (
            <EmptyState icon={<ClipboardList className="h-8 w-8" />} title={t('Todavía no hay órdenes de trabajo', 'There are no work orders yet')}>
              {t('Se crean al aceptar la recomendación de un incidente.', 'They are created when you accept an incident’s recommendation.')}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {sorted.map((raw) => {
                const o = ensureChecklist(raw);
                const done = o.checklist!.filter((c) => c.done).length;
                const rv = repairView(o, p.nodes.find((n) => n.id === o.nodeId), p.seriesByNode[o.nodeId], p.ledger);
                const u = urgency(o.priority);
                const pill = o.status === 'Cerrada' && rv ? repairPill(rv.outcome) : { tone: u.tone, label: u.label };
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      aria-current={o.id === p.selectedId ? 'true' : undefined}
                      onClick={() => {
                        p.onSelect(o.id);
                        setError(null);
                        setChangingAssignee(false);
                      }}
                      className={`flex min-h-16 w-full cursor-pointer flex-col gap-1.5 px-4 py-3.5 text-left hover:bg-raised/60 ${o.id === p.selectedId ? 'bg-raised' : ''}`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-base font-medium text-ink">{o.location.split(' · ')[0]}</span>
                        <StatusPill tone={pill.tone} label={pill.label} className="shrink-0" />
                      </span>
                      <span className="text-sm text-quiet">
                        {o.id} · {statusLabel(o.status)} · {o.assignee}
                      </span>
                      {o.status !== 'Cerrada' && (
                        <span className="text-sm text-soft">
                          {t(`Tareas ${done} de ${o.checklist!.length}`, `Tasks ${done} of ${o.checklist!.length}`)}
                          {o.closureEvidence ? t(' · foto lista', ' · photo ready') : t(' · falta la foto', ' · photo missing')}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label={t('Detalle de la orden', 'Order details')} className={order ? '' : 'hidden lg:block'}>
          {!order ? (
            <EmptyState icon={<ClipboardList className="h-8 w-8" />} title={t('Elige una orden', 'Choose an order')}>
              {t('Verás qué hay que hacer, quién es responsable y qué falta para cerrarla.', 'You will see what has to be done, who is responsible and what is missing to close it.')}
            </EmptyState>
          ) : (
            (() => {
              const o = order;
              const checklist = o.checklist ?? [];
              const done = checklist.filter((c) => c.done).length;
              const closed = o.status === 'Cerrada';
              const blockers = closureBlockers(o);
              const node = p.nodes.find((n) => n.id === o.nodeId);
              const rv = repairView(o, node, p.seriesByNode[o.nodeId], p.ledger);
              const u = urgency(o.priority);
              const pendingTasks = checklist.length - done;

              /** Tareas, responsable y foto: se muestran a quien trabaja la orden y, plegadas, como constancia de lo hecho al cerrarla. */
              const tasks = (
                <ul className="space-y-2">
                  {checklist.map((item) => (
                    <li key={item.id}>
                      <label className={`flex min-h-12 items-start gap-3 rounded-lg border px-3 py-3 ${item.done ? 'border-ok/30 bg-ok/5' : 'border-line bg-surface'} ${closed || !mayWrite ? '' : 'cursor-pointer hover:border-line-strong'}`}>
                        <input
                          type="checkbox"
                          checked={optimistic[item.id] ?? item.done}
                          disabled={closed || !mayWrite || item.id in optimistic}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setOptimistic((m) => ({ ...m, [item.id]: next }));
                            void run(`ck-${item.id}`, () => p.onToggleChecklist(o.id, item.id, next)).finally(() =>
                              setOptimistic((m) => {
                                const { [item.id]: _gone, ...rest } = m;
                                return rest;
                              })
                            );
                          }}
                          className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500"
                        />
                        <span className="min-w-0 flex-1 text-base text-ink">
                          {tr(item.label)}
                          {item.done && item.doneAt && (
                            <span className="mt-0.5 block text-xs text-quiet">
                              {t('Hecho', 'Done')} {timeAgo(item.doneAt)} · {item.doneBy}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              );
              const photo = o.closureEvidence ? (
                <div className="flex flex-wrap items-start gap-4">
                  <img src={`/api/evidence/${o.closureEvidence.sha256}`} alt={t(`Foto de cierre de ${o.id}: ${o.closureEvidence.fileName}`, `Closing photo of ${o.id}: ${o.closureEvidence.fileName}`)} className="h-28 w-40 rounded-lg border border-line-strong bg-surface object-cover" />
                  <p className="text-sm text-soft">
                    {t(`Adjuntada ${timeAgo(o.closureEvidence.attachedAt)} por ${o.closureEvidence.attachedBy}.`, `Attached ${timeAgo(o.closureEvidence.attachedAt)} by ${o.closureEvidence.attachedBy}.`)}
                    <br />
                    <span className="text-quiet">{t('Queda guardada y sellada, pero el sistema no analiza su contenido.', 'It is stored and sealed, but the system does not analyze its content.')}</span>
                  </p>
                </div>
              ) : (
                <p className="text-base text-soft">{t('Todavía no hay foto. Es obligatoria para cerrar la orden.', 'There is no photo yet. It is required to close the order.')}</p>
              );

              return (
                <article className="space-y-8" aria-labelledby="ord-title">
                  <div className="space-y-3">
                    <button type="button" onClick={() => p.onSelect(null)} className="-ml-2 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-soft hover:text-ink lg:hidden">
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('Volver a la lista', 'Back to the list')}
                    </button>
                    {!closed && (
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={u.tone} label={`${u.label} · ${statusLabel(o.status).toLowerCase()}`} />
                      </div>
                    )}
                    <h2 id="ord-title" className="font-display text-2xl font-semibold leading-tight text-ink">
                      {o.location.split(' · ')[0]}
                    </h2>
                    <p className="text-sm text-quiet">
                      {o.id} · {o.assetName} · {t('actualizada', 'updated')} {timeAgo(o.updatedAt)}
                    </p>
                    <button type="button" onClick={() => p.onOpenIncident(o.anomalyId)} className="-ml-1 inline-flex min-h-11 cursor-pointer items-center px-1 text-sm text-accent underline">
                      {t('Ver el incidente que originó esta orden', 'See the incident that started this order')}
                    </button>
                  </div>

                  {error && (
                    <Notice tone="critical" live="assertive">
                      {error}
                    </Notice>
                  )}
                  {!mayWrite && !closed && <Notice tone="neutral">{t(`Tu rol (${roleLabel(p.role)}) permite consultar la orden, no modificarla.`, `Your role (${roleLabel(p.role)}) lets you view the order, not change it.`)}</Notice>}

                  {closed ? (
                    <>
                      {/* Lo primero que importa de una orden cerrada: ¿funcionó la reparación? */}
                      <Question q={t('¿Se recuperó la infraestructura?', 'Was the infrastructure restored?')} id="q-ord-verify">
                        {rv && <RepairVerificationPanel view={rv} busy={busy === 'simulate'} onSimulate={p.onSimulateMeasurements && !rv.sealed ? (mode) => void run('simulate', () => p.onSimulateMeasurements!(o.id, mode)) : undefined} />}
                        <div className="flex flex-col gap-2 sm:flex-row">
                          {mayExport && (
                            <Button variant="secondary" busy={busy === 'dossier'} onClick={() => void run('dossier', () => p.onDownloadDossier(o.id))} icon={<Download className="h-4 w-4" />}>
                              {t('Descargar el expediente verificable', 'Download the verifiable dossier')}
                            </Button>
                          )}
                          <Button variant="ghost" onClick={p.onOpenLedger} icon={<ShieldCheck className="h-4 w-4" />}>
                            {t('Ver el registro (Trust Ledger)', 'See the record (Trust Ledger)')}
                          </Button>
                        </div>
                        {o.seal && (
                          <Disclosure summary={t('Sello del expediente', 'Dossier seal')}>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                              <dt className="text-quiet">{t('Huella', 'Digest')}</dt>
                              <dd className="break-all font-mono text-soft">sha256:{o.seal.dossierDigest}</dd>
                              <dt className="text-quiet">{t('Bloque', 'Block')}</dt>
                              <dd className="text-soft">#{o.seal.closedLedgerIndex}</dd>
                              <dt className="text-quiet">{t('Firma', 'Signature')}</dt>
                              <dd className="text-soft">{o.seal.receipt ? t(`Recibo firmado Ed25519 (clave ${o.seal.receipt.payload.keyId.slice(0, 16)}…)`, `Ed25519-signed receipt (key ${o.seal.receipt.payload.keyId.slice(0, 16)}…)`) : t('Sin firma', 'Unsigned')}</dd>
                              {o.closureEvidence && (
                                <>
                                  <dt className="text-quiet">{t('Foto (SHA-256)', 'Photo (SHA-256)')}</dt>
                                  <dd className="break-all font-mono text-soft">{o.closureEvidence.sha256}</dd>
                                </>
                              )}
                            </dl>
                            <p className="flex items-center gap-2 text-xs text-quiet">
                              <Hourglass className="h-3.5 w-3.5" aria-hidden="true" /> {t('Verifica el archivo descargado sin conexión con: npm run verify:dossier', 'Verify the downloaded file offline with: npm run verify:dossier')}
                            </p>
                          </Disclosure>
                        )}
                      </Question>

                      {/* Constancia de lo que se hizo: plegada, para no repetir lo que ya se sabe. */}
                      <Disclosure summary={t(`Qué se hizo: ${done} de ${checklist.length} tareas y foto de cierre`, `What was done: ${done} of ${checklist.length} tasks and a closing photo`)}>
                        {o.closureNotes && <p className="text-sm text-soft">{o.closureNotes}</p>}
                        <p className="text-sm text-soft">
                          <span className="font-semibold text-ink">{t('Responsable:', 'Responsible:')}</span> {o.assignee}
                        </p>
                        {tasks}
                        {photo}
                      </Disclosure>
                    </>
                  ) : (
                    <>
                      <Question q={t('Qué hay que hacer', 'What needs to be done')} id="q-ord-todo">
                        <p className="text-base leading-relaxed text-ink">{tr(o.probableCause)}</p>
                        <p className="text-sm text-quiet">{t('Causa probable: es una hipótesis del diagnóstico, no un hecho confirmado.', 'Probable cause: a hypothesis from the diagnosis, not a confirmed fact.')}</p>
                        {o.requiredResources.length > 0 && (
                          <p className="text-sm text-soft">
                            <span className="font-semibold">{t('Llevar:', 'Bring:')}</span> {trList(o.requiredResources).join(' · ')}
                          </p>
                        )}
                      </Question>

                      <Question q={t(`Lista de tareas (${done} de ${checklist.length})`, `Task list (${done} of ${checklist.length})`)} id="q-ord-checks">
                        <div className="h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={checklist.length} aria-valuenow={done} aria-label={t('Avance de las tareas', 'Task progress')}>
                          <div className="h-full bg-ok transition-all" style={{ width: `${checklist.length ? (done / checklist.length) * 100 : 0}%` }} />
                        </div>
                        {tasks}
                      </Question>

                      <Question q={t('Responsable', 'Responsible')} id="q-ord-who">
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="text-base text-ink">{o.assignee}</p>
                          {mayWrite && !changingAssignee && (
                            <Button variant="ghost" onClick={() => setChangingAssignee(true)} icon={<UserCog className="h-4 w-4" />}>
                              {t('Cambiar', 'Change')}
                            </Button>
                          )}
                        </div>
                        {changingAssignee && (
                          <form
                            className="flex flex-wrap items-end gap-3"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const value = assignee.trim();
                              if (value.length < 2) return;
                              void run('assign', async () => {
                                await p.onAssignOrder(o.id, value);
                                setAssignee('');
                                setChangingAssignee(false);
                              });
                            }}
                          >
                            <div className="min-w-[14rem] flex-1">
                              <label htmlFor="wo-assignee" className="mb-1 block text-sm font-semibold text-ink">
                                {t('Nuevo responsable (persona o cuadrilla)', 'New owner (person or crew)')}
                              </label>
                              <input id="wo-assignee" value={assignee} maxLength={80} onChange={(e) => setAssignee(e.target.value)} placeholder={o.assignee} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink placeholder:text-quiet" />
                            </div>
                            <Button type="submit" variant="primary" busy={busy === 'assign'} disabled={assignee.trim().length < 2}>
                              {t('Asignar', 'Assign')}
                            </Button>
                            <Button variant="ghost" onClick={() => setChangingAssignee(false)}>
                              {t('Cancelar', 'Cancel')}
                            </Button>
                          </form>
                        )}
                        <p className="text-xs text-quiet">{t('El responsable es una etiqueta de la orden. Quién hace cada cambio queda registrado con su usuario.', 'The owner is a label on the order. Who makes each change is recorded with their user account.')}</p>
                      </Question>

                      <Question q={t('Foto de cierre', 'Closing photo')} id="q-ord-photo">
                        {photo}
                        {mayPhoto && (
                          <div>
                            <input
                              ref={fileRef}
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              capture="environment"
                              className="sr-only"
                              aria-label={t('Tomar o elegir la foto de cierre', 'Take or choose the closing photo')}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                if (!f) return;
                                void run('photo', async () => p.onUploadEvidence(o.id, f.name, await prepareImage(f)));
                              }}
                            />
                            <Button variant="secondary" busy={busy === 'photo'} onClick={() => fileRef.current?.click()} icon={<Camera className="h-4 w-4" />}>
                              {o.closureEvidence ? t('Cambiar la foto', 'Change the photo') : t('Tomar o añadir la foto', 'Take or add the photo')}
                            </Button>
                          </div>
                        )}
                      </Question>

                      <Question q={mayWrite ? t('Cerrar la orden', 'Close the order') : t('Qué falta para cerrar', 'What is missing to close')} id="q-ord-close">
                        {blockers.length > 0 && (
                          <ul className="space-y-1 text-sm text-attention" aria-label={t('Qué falta para cerrar', 'What is missing to close')}>
                            {pendingTasks > 0 && (
                              <li className="flex gap-2">
                                <span aria-hidden="true">•</span> {t(`Faltan ${pendingTasks} ${pendingTasks === 1 ? 'tarea' : 'tareas'} por completar.`, `${pendingTasks} ${pendingTasks === 1 ? 'task is' : 'tasks are'} still to be completed.`)}
                              </li>
                            )}
                            {!o.closureEvidence && (
                              <li className="flex gap-2">
                                <span aria-hidden="true">•</span> {t('Falta la foto de cierre.', 'The closing photo is missing.')}
                              </li>
                            )}
                          </ul>
                        )}
                        {mayWrite && (
                          <>
                            <div>
                              <label htmlFor="wo-notes" className="mb-1 block text-sm font-semibold text-ink">
                                {t('Qué se hizo (opcional)', 'What was done (optional)')}
                              </label>
                              <input id="wo-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder={t('Ej.: se cambió la brida del tramo norte', 'E.g. the flange on the north reach was replaced')} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink placeholder:text-quiet" />
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                              {o.status === 'Abierta' && (
                                <Button variant="secondary" busy={busy === 'start'} onClick={() => void run('start', () => p.onUpdateOrder(o.id, { status: 'En Progreso' }))} icon={<PlayCircle className="h-4 w-4" />}>
                                  {t('Empezar la intervención', 'Start the intervention')}
                                </Button>
                              )}
                              <Button variant="primary" disabled={blockers.length > 0} onClick={() => setConfirmClose(true)} icon={<CheckCircle2 className="h-4 w-4" />}>
                                {t('Cerrar la orden', 'Close the order')}
                              </Button>
                            </div>
                          </>
                        )}
                        <ConfirmDialog
                          open={confirmClose}
                          title={t('¿Cerrar esta orden?', 'Close this order?')}
                          confirmLabel={t('Sí, cerrar la orden', 'Yes, close the order')}
                          busy={busy === 'close'}
                          onCancel={() => setConfirmClose(false)}
                          onConfirm={() =>
                            void run('close', async () => {
                              await p.onUpdateOrder(o.id, { status: 'Cerrada', closureNotes: notes.trim() || t('Cierre registrado desde la interfaz, sin verificación con mediciones posteriores.', 'Closing recorded from the interface, without verification by later measurements.'), closureEvidenceLabel: o.closureEvidenceLabel });
                              setNotes('');
                              setConfirmClose(false);
                            })
                          }
                        >
                          {t('La orden queda sellada en el registro y ya no se puede reabrir. El punto ', 'The order is sealed in the record and can no longer be reopened. The point ')}
                          <strong>{t('no se dará por recuperado', 'will not be treated as recovered')}</strong>
                          {t(': quedará pendiente de verificación hasta que lleguen mediciones posteriores al cierre.', ': it stays pending verification until measurements arrive after the closing.')}
                        </ConfirmDialog>
                      </Question>
                    </>
                  )}
                </article>
              );
            })()
          )}
        </section>
      </div>
    </div>
  );
};
