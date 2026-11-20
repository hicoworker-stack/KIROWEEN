import React, { useRef, useState } from 'react';
import { ArrowLeft, Camera, CheckCircle2, ClipboardList, Download, Hourglass, PlayCircle, ShieldCheck, UserCog } from 'lucide-react';
import { prepareImage } from '../client/image';
import { can, Role, ROLE_LABEL } from '../core/permissions';
import { closureBlockers, ensureChecklist } from '../core/workOrders';
import { NetworkNode, SmartWorkOrder, TelemetryReading, WorkOrderStatus } from '../core/types';
import { HEALTH_META, orderVerification, timeAgo, urgency } from '../ui/vocab';
import { Button, ConfirmDialog, Disclosure, EmptyState, Notice, Question, Skeleton, StatusPill, TONE } from './ui';

export interface WorkOrdersViewProps {
  workOrders: SmartWorkOrder[];
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
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
}

const STATUS_LABEL: Record<WorkOrderStatus, string> = { Abierta: 'Por iniciar', 'En Progreso': 'En curso', Cerrada: 'Cerrada' };

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
      setError(e instanceof Error ? e.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(null);
    }
  };

  if (p.loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Cargando órdenes de trabajo">
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
        <h1 className="font-display text-2xl font-semibold text-ink">Órdenes de trabajo</h1>
        <p className="text-base text-soft">Cada orden nace de una recomendación aceptada. Se cierra con la lista de tareas completa y una foto.</p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
        <section aria-label="Lista de órdenes" className={order ? 'hidden lg:block' : ''}>
          {sorted.length === 0 ? (
            <EmptyState icon={<ClipboardList className="h-8 w-8" />} title="Todavía no hay órdenes de trabajo">
              Se crean al aceptar la recomendación de un incidente.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {sorted.map((raw) => {
                const o = ensureChecklist(raw);
                const done = o.checklist!.filter((c) => c.done).length;
                const v = orderVerification(o, p.seriesByNode[o.nodeId]);
                const u = urgency(o.priority);
                return (
                  <li key={o.id}>
                    <button type="button" aria-current={o.id === p.selectedId ? 'true' : undefined} onClick={() => { p.onSelect(o.id); setError(null); setChangingAssignee(false); }} className={`flex min-h-16 w-full cursor-pointer flex-col gap-1.5 px-4 py-3.5 text-left hover:bg-raised/60 ${o.id === p.selectedId ? 'bg-raised' : ''}`}>
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-base font-medium text-ink">{o.location.split(' · ')[0]}</span>
                        {o.status !== 'Cerrada' ? <StatusPill tone={u.tone} label={u.label} className="shrink-0" /> : v.state === 'pending' ? <StatusPill tone="verifying" label="Por verificar" className="shrink-0" /> : <StatusPill tone="ok" label="Cerrada" className="shrink-0" />}
                      </span>
                      <span className="text-sm text-quiet">
                        {o.id} · {STATUS_LABEL[o.status]} · {o.assignee}
                      </span>
                      {o.status !== 'Cerrada' && (
                        <span className="text-sm text-soft">
                          Tareas {done} de {o.checklist!.length}
                          {o.closureEvidence ? ' · foto lista' : ' · falta la foto'}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Detalle de la orden" className={order ? '' : 'hidden lg:block'}>
          {!order ? (
            <EmptyState icon={<ClipboardList className="h-8 w-8" />} title="Elige una orden">
              Verás qué hay que hacer, quién es responsable y qué falta para cerrarla.
            </EmptyState>
          ) : (
            (() => {
              const o = order;
              const checklist = o.checklist ?? [];
              const done = checklist.filter((c) => c.done).length;
              const closed = o.status === 'Cerrada';
              const blockers = closureBlockers(o);
              const node = p.nodes.find((n) => n.id === o.nodeId);
              const v = orderVerification(o, p.seriesByNode[o.nodeId]);
              const u = urgency(o.priority);
              return (
                <article className="space-y-8" aria-labelledby="ord-title">
                  <div className="space-y-3">
                    <button type="button" onClick={() => p.onSelect(null)} className="-ml-2 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-soft hover:text-ink lg:hidden">
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Volver a la lista
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      {closed ? v.state === 'pending' ? <StatusPill tone="verifying" label={HEALTH_META.verifying.label} title={HEALTH_META.verifying.help} /> : <StatusPill tone="ok" label="Cerrada, con mediciones posteriores" /> : <StatusPill tone={u.tone} label={`${u.label} · ${STATUS_LABEL[o.status].toLowerCase()}`} />}
                    </div>
                    <h2 id="ord-title" className="font-display text-2xl font-semibold leading-tight text-ink">
                      {o.location.split(' · ')[0]}
                    </h2>
                    <p className="text-sm text-quiet">
                      {o.id} · {o.assetName} · actualizada {timeAgo(o.updatedAt)}
                    </p>
                    <button type="button" onClick={() => p.onOpenIncident(o.anomalyId)} className="cursor-pointer text-sm text-accent underline">
                      Ver el incidente que originó esta orden
                    </button>
                  </div>

                  {error && <Notice tone="critical" live="assertive">{error}</Notice>}
                  {!mayWrite && !closed && <Notice tone="neutral">Tu rol ({ROLE_LABEL[p.role]}) permite consultar la orden, no modificarla.</Notice>}

                  <Question q="Qué hay que hacer" id="q-ord-todo">
                    <p className="text-base leading-relaxed text-ink">{o.probableCause}</p>
                    <p className="text-sm text-quiet">Causa probable: es una hipótesis del diagnóstico, no un hecho confirmado.</p>
                    {o.requiredResources.length > 0 && (
                      <p className="text-sm text-soft">
                        <span className="font-semibold">Llevar:</span> {o.requiredResources.join(' · ')}
                      </p>
                    )}
                  </Question>

                  <Question q={`Lista de tareas (${done} de ${checklist.length})`} id="q-ord-checks">
                    <div className="h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={checklist.length} aria-valuenow={done} aria-label="Avance de las tareas">
                      <div className="h-full bg-ok transition-all" style={{ width: `${checklist.length ? (done / checklist.length) * 100 : 0}%` }} />
                    </div>
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
                              {item.label}
                              {item.done && item.doneAt && (
                                <span className="mt-0.5 block text-xs text-quiet">
                                  Hecho {timeAgo(item.doneAt)} · {item.doneBy}
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </Question>

                  <Question q="Responsable" id="q-ord-who">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-base text-ink">{o.assignee}</p>
                      {!closed && mayWrite && !changingAssignee && (
                        <Button variant="ghost" onClick={() => setChangingAssignee(true)} icon={<UserCog className="h-4 w-4" />}>
                          Cambiar
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
                            Nuevo responsable (persona o cuadrilla)
                          </label>
                          <input id="wo-assignee" value={assignee} maxLength={80} onChange={(e) => setAssignee(e.target.value)} placeholder={o.assignee} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink placeholder:text-quiet" />
                        </div>
                        <Button type="submit" variant="primary" busy={busy === 'assign'} disabled={assignee.trim().length < 2}>
                          Asignar
                        </Button>
                        <Button variant="ghost" onClick={() => setChangingAssignee(false)}>
                          Cancelar
                        </Button>
                      </form>
                    )}
                    <p className="text-xs text-quiet">El responsable es una etiqueta de la orden. Quién hace cada cambio queda registrado con su usuario.</p>
                  </Question>

                  <Question q="Foto de cierre" id="q-ord-photo">
                    {o.closureEvidence ? (
                      <div className="flex flex-wrap items-start gap-4">
                        <img src={`/api/evidence/${o.closureEvidence.sha256}`} alt={`Foto de cierre de ${o.id}: ${o.closureEvidence.fileName}`} className="h-28 w-40 rounded-lg border border-line-strong bg-surface object-cover" />
                        <p className="text-sm text-soft">
                          Adjuntada {timeAgo(o.closureEvidence.attachedAt)} por {o.closureEvidence.attachedBy}.<br />
                          <span className="text-quiet">Queda guardada y sellada, pero el sistema no analiza su contenido.</span>
                        </p>
                      </div>
                    ) : (
                      <p className="text-base text-soft">Todavía no hay foto. Es obligatoria para cerrar la orden.</p>
                    )}
                    {!closed && mayPhoto && (
                      <div>
                        <input
                          ref={fileRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          className="sr-only"
                          aria-label="Tomar o elegir la foto de cierre"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            void run('photo', async () => p.onUploadEvidence(o.id, f.name, await prepareImage(f)));
                          }}
                        />
                        <Button variant="secondary" busy={busy === 'photo'} onClick={() => fileRef.current?.click()} icon={<Camera className="h-4 w-4" />}>
                          {o.closureEvidence ? 'Cambiar la foto' : 'Tomar o añadir la foto'}
                        </Button>
                      </div>
                    )}
                  </Question>

                  {!closed ? (
                    <Question q={mayWrite ? 'Cerrar la orden' : 'Qué falta para cerrar'} id="q-ord-close">
                      {blockers.length > 0 && (
                        <ul className="space-y-1 text-sm text-attention" aria-label="Qué falta para cerrar">
                          {blockers.map((b) => (
                            <li key={b} className="flex gap-2">
                              <span aria-hidden="true">•</span> {b}
                            </li>
                          ))}
                        </ul>
                      )}
                      {mayWrite && (
                        <>
                          <div>
                            <label htmlFor="wo-notes" className="mb-1 block text-sm font-semibold text-ink">
                              Qué se hizo (opcional)
                            </label>
                            <input id="wo-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Ej.: se cambió la brida del tramo norte" className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink placeholder:text-quiet" />
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            {o.status === 'Abierta' && (
                              <Button variant="secondary" busy={busy === 'start'} onClick={() => void run('start', () => p.onUpdateOrder(o.id, { status: 'En Progreso' }))} icon={<PlayCircle className="h-4 w-4" />}>
                                Empezar la intervención
                              </Button>
                            )}
                            <Button variant="primary" disabled={blockers.length > 0} onClick={() => setConfirmClose(true)} icon={<CheckCircle2 className="h-4 w-4" />}>
                              Cerrar la orden
                            </Button>
                          </div>
                        </>
                      )}
                      <ConfirmDialog
                        open={confirmClose}
                        title="¿Cerrar esta orden?"
                        confirmLabel="Sí, cerrar la orden"
                        busy={busy === 'close'}
                        onCancel={() => setConfirmClose(false)}
                        onConfirm={() =>
                          void run('close', async () => {
                            await p.onUpdateOrder(o.id, { status: 'Cerrada', closureNotes: notes.trim() || 'Cierre registrado desde la interfaz, sin verificación con mediciones posteriores.', closureEvidenceLabel: o.closureEvidenceLabel });
                            setNotes('');
                            setConfirmClose(false);
                          })
                        }
                      >
                        La orden queda sellada en el registro y ya no se puede reabrir. El sistema marcará el punto como estable, <strong>aunque todavía no haya mediciones reales que lo confirmen</strong>: después tendrás que comprobar que se recuperó.
                      </ConfirmDialog>
                    </Question>
                  ) : (
                    <Question q="¿Se recuperó la infraestructura?" id="q-ord-verify">
                      {v.state === 'pending' ? (
                        <Notice tone="verifying" title="Aún no se puede confirmar">
                          La orden se cerró {timeAgo(v.closedAt)}, pero todavía no hay mediciones reales posteriores. Los valores «normales» que se ven en el punto los escribió el sistema al cerrar la orden: no son una medición. Cuando lleguen lecturas nuevas aparecerán aquí para que las compares.
                        </Notice>
                      ) : v.state === 'measured' ? (
                        <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
                          <p className="text-base text-ink">
                            Hay {v.measuredAfter} {v.measuredAfter === 1 ? 'medición posterior' : 'mediciones posteriores'} al cierre. La última:
                          </p>
                          <p className="text-sm text-soft">
                            Presión {v.last.pressureBar.toFixed(2)} bar{node ? ` (lo normal: ${node.baseline.pressureBar.toFixed(2)} bar)` : ''} · caudal {v.last.flowLs.toFixed(1)} L/s{node ? ` (lo normal: ${node.baseline.flowLs.toFixed(1)} L/s)` : ''}
                            {v.last.synthetic ? ' · dato simulado' : ''}.
                          </p>
                          <p className="text-sm text-quiet">Compáralas con lo normal. El sistema todavía no emite un veredicto de recuperación por sí mismo.</p>
                        </div>
                      ) : null}
                      <div className="rounded-xl border border-ok/30 bg-ok/5 p-4 text-sm text-soft">
                        <p className="flex items-center gap-2 font-semibold text-ok">
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Orden cerrada con tareas completas y foto sellada
                        </p>
                        {o.closureNotes && <p className="mt-1">{o.closureNotes}</p>}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {mayExport && (
                          <Button variant="secondary" busy={busy === 'dossier'} onClick={() => void run('dossier', () => p.onDownloadDossier(o.id))} icon={<Download className="h-4 w-4" />}>
                            Descargar el expediente verificable
                          </Button>
                        )}
                        <Button variant="ghost" onClick={p.onOpenLedger} icon={<ShieldCheck className="h-4 w-4" />}>
                          Ver el registro (Trust Ledger)
                        </Button>
                      </div>
                      {o.seal && (
                        <Disclosure summary="Sello del expediente">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                            <dt className="text-quiet">Huella</dt>
                            <dd className="break-all font-mono text-soft">sha256:{o.seal.dossierDigest}</dd>
                            <dt className="text-quiet">Bloque</dt>
                            <dd className="text-soft">#{o.seal.closedLedgerIndex}</dd>
                            <dt className="text-quiet">Firma</dt>
                            <dd className="text-soft">{o.seal.receipt ? `Recibo firmado Ed25519 (clave ${o.seal.receipt.payload.keyId.slice(0, 16)}…)` : 'Sin firma'}</dd>
                            {o.closureEvidence && (
                              <>
                                <dt className="text-quiet">Foto (SHA-256)</dt>
                                <dd className="break-all font-mono text-soft">{o.closureEvidence.sha256}</dd>
                              </>
                            )}
                          </dl>
                          <p className="flex items-center gap-2 text-xs text-quiet">
                            <Hourglass className="h-3.5 w-3.5" aria-hidden="true" /> Verifica el archivo descargado sin conexión con: npm run verify:dossier
                          </p>
                        </Disclosure>
                      )}
                    </Question>
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
