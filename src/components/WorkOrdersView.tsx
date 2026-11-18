import React, { useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  ClipboardList,
  Download,
  PlayCircle,
  ShieldCheck,
  UserCog,
} from 'lucide-react';
import { closureBlockers, ensureChecklist } from '../core/workOrders';
import { SmartWorkOrder, WorkOrderStatus } from '../core/types';

interface WorkOrdersViewProps {
  workOrders: SmartWorkOrder[];
  onUpdateOrder: (
    orderId: string,
    payload: { status: WorkOrderStatus; closureNotes?: string; closureEvidenceLabel?: string }
  ) => Promise<void>;
  onAssignOrder: (orderId: string, assignee: string) => Promise<void>;
  onToggleChecklist: (orderId: string, itemId: string, done: boolean) => Promise<void>;
  onUploadEvidence: (orderId: string, fileName: string, dataUrl: string) => Promise<void>;
  onDownloadDossier: (orderId: string) => Promise<void>;
  onNavigateToLedger: () => void;
}

const MAX_DIM = 1600;
const RESIZE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

/** Las fotos de celular pesan varios MB; se reducen a 1600 px (JPEG) antes de subirlas. El hash sellado es el de la imagen enviada. */
async function prepareEvidence(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('Formato no permitido. Usa JPEG, PNG o WebP.');
  }
  if (file.size <= RESIZE_THRESHOLD_BYTES) return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('No se pudo comprimir la imagen.');
  return readAsDataUrl(blob);
}

const statusColor = (s: WorkOrderStatus) =>
  s === 'Cerrada' ? 'text-emerald-400' : s === 'En Progreso' ? 'text-amber-400' : 'text-rose-400';

export const WorkOrdersView: React.FC<WorkOrdersViewProps> = ({
  workOrders,
  onUpdateOrder,
  onAssignOrder,
  onToggleChecklist,
  onUploadEvidence,
  onDownloadDossier,
  onNavigateToLedger,
}) => {
  const [filter, setFilter] = useState<'Todas' | WorkOrderStatus>('Todas');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [closureNotes, setClosureNotes] = useState('');
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = workOrders.filter((w) => (filter === 'Todas' ? true : w.status === filter));
  const selectedRaw =
    workOrders.find((w) => w.id === selectedOrderId) ?? filtered[0] ?? workOrders[0] ?? null;
  const selectedOrder = selectedRaw ? ensureChecklist(selectedRaw) : null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado.');
    } finally {
      setBusy(null);
    }
  };

  const blockers = selectedOrder ? closureBlockers(selectedOrder) : [];
  const checklist = selectedOrder?.checklist ?? [];
  const doneCount = checklist.filter((c) => c.done).length;
  const isClosed = selectedOrder?.status === 'Cerrada';

  return (
    <div className="space-y-6">
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Órdenes de Trabajo Inteligentes</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Cada orden nace de un diagnóstico aprobado. Se cierra solo con checklist completo y una
            fotografía de cierre; cada acción queda sellada en el Trust Ledger.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#06131C] border border-[#18364A] rounded-lg" role="group" aria-label="Filtrar órdenes por estado">
          {(['Todas', 'Abierta', 'En Progreso', 'Cerrada'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={filter === tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === tab ? 'bg-[#0F2736] text-cyan-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </section>

      {!selectedOrder ? (
        <section className="bg-[#0A1D29] border border-dashed border-[#18364A] rounded-xl p-12 text-center space-y-2">
          <ClipboardList className="w-7 h-7 text-cyan-400 mx-auto" />
          <h3 className="text-base font-semibold text-white">No hay órdenes de trabajo emitidas</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Aprueba una recomendación en Aqua Brain para generar una orden con checklist, responsable
            y cierre verificable.
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <aside className="xl:col-span-4 bg-[#0A1D29] border border-[#18364A] rounded-xl p-4 space-y-2" aria-label="Lista de órdenes">
            {filtered.length === 0 && (
              <p className="text-xs text-slate-400 p-2">Ninguna orden con estado «{filter}».</p>
            )}
            {filtered.map((order) => {
              const o = ensureChecklist(order);
              const done = o.checklist!.filter((c) => c.done).length;
              return (
                <button
                  key={order.id}
                  type="button"
                  aria-pressed={selectedOrder.id === order.id}
                  onClick={() => {
                    setSelectedOrderId(order.id);
                    setError(null);
                    setAssigneeDraft('');
                  }}
                  className={`w-full text-left p-3.5 rounded-lg border transition-colors cursor-pointer ${
                    selectedOrder.id === order.id
                      ? 'bg-[#0F2736] border-cyan-400'
                      : 'bg-[#06131C] border-[#18364A] hover:border-[#234C66]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono">
                    <span className="text-cyan-300 font-semibold">{order.id}</span>
                    <span className={statusColor(order.status)}>{order.status}</span>
                  </div>
                  <div className="text-sm font-medium text-white mt-1">{order.location}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    Prioridad {order.priority} · {order.assignee}
                  </div>
                  <div className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                    Checklist {done}/{o.checklist!.length}
                    {order.closureEvidence ? ' · foto ✓' : ''}
                  </div>
                </button>
              );
            })}
          </aside>

          <section className="xl:col-span-8 bg-[#0A1D29] border border-[#18364A] rounded-xl p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#18364A] pb-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
                  <span>{selectedOrder.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{selectedOrder.assetName}</span>
                </div>
                <h3 className="text-lg font-semibold text-white mt-1">{selectedOrder.location}</h3>
                <p className="text-xs text-slate-400 mt-1">
                  Responsable: <span className="text-slate-200">{selectedOrder.assignee}</span> ·
                  Prioridad: <span className="text-rose-400 font-semibold">{selectedOrder.priority}</span>
                </p>
              </div>
              <div className="text-right text-xs font-mono">
                <div className={`font-semibold ${statusColor(selectedOrder.status)}`}>
                  Estado: {selectedOrder.status}
                </div>
                <div className="text-slate-400 mt-1">
                  Actualizada: {new Date(selectedOrder.updatedAt).toLocaleTimeString('es-ES')}
                </div>
              </div>
            </div>

            {error && (
              <div role="alert" className="px-4 py-2.5 rounded-lg bg-[#2A0B14] border border-rose-500/50 text-xs text-rose-200">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">
                  Causa Probable y Evidencias
                </h4>
                <p className="text-xs text-slate-100 leading-relaxed">{selectedOrder.probableCause}</p>
                <ul className="space-y-1 text-xs text-slate-400 list-disc pl-4 pt-1">
                  {selectedOrder.evidenceSummary.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>

              <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                <h4 className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
                  Recursos Necesarios
                </h4>
                <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                  {selectedOrder.requiredResources.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* M-10: responsable */}
            {!isClosed && (
              <form
                className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = assigneeDraft.trim();
                  if (!value) return;
                  void run('assign', async () => {
                    await onAssignOrder(selectedOrder.id, value);
                    setAssigneeDraft('');
                  });
                }}
              >
                <div className="flex-1 min-w-[200px]">
                  <label htmlFor="wo-assignee" className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1.5">
                    <UserCog className="w-3.5 h-3.5 text-cyan-400" />
                    Reasignar responsable
                  </label>
                  <input
                    id="wo-assignee"
                    type="text"
                    maxLength={80}
                    value={assigneeDraft}
                    onChange={(e) => setAssigneeDraft(e.target.value)}
                    placeholder={selectedOrder.assignee}
                    className="w-full px-3 py-2 text-xs bg-[#071824] text-white border border-[#18364A] rounded-lg focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy !== null || assigneeDraft.trim().length < 2}
                  className="px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy === 'assign' ? 'Asignando…' : 'Asignar'}
                </button>
              </form>
            )}

            {/* M-10: checklist */}
            <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Checklist de Ejecución en Campo
                </h4>
                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  {doneCount}/{checklist.length} completados
                </span>
              </div>
              <div
                className="h-1.5 rounded-full bg-[#0F2736] overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={checklist.length}
                aria-valuenow={doneCount}
                aria-label="Avance del checklist"
              >
                <div
                  className="h-full bg-emerald-400 transition-all"
                  style={{ width: `${checklist.length ? (doneCount / checklist.length) * 100 : 0}%` }}
                />
              </div>
              <ul className="space-y-2">
                {checklist.map((item) => (
                  <li key={item.id}>
                    <label
                      className={`flex items-start gap-3 p-2.5 rounded-lg border text-xs transition-colors ${
                        item.done ? 'bg-[#07211D] border-emerald-500/30' : 'bg-[#071824] border-[#18364A]'
                      } ${isClosed ? 'opacity-80' : 'cursor-pointer hover:border-[#234C66]'}`}
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={isClosed || busy !== null}
                        onChange={(e) =>
                          void run(`ck-${item.id}`, () =>
                            onToggleChecklist(selectedOrder.id, item.id, e.target.checked)
                          )
                        }
                        className="mt-0.5 h-4 w-4 accent-emerald-500 shrink-0"
                      />
                      <span className="flex-1 min-w-0">
                        <span className={item.done ? 'text-slate-300' : 'text-slate-100'}>{item.label}</span>
                        {item.done && item.doneAt && (
                          <span className="block text-slate-400 font-mono mt-0.5">
                            ✓ {item.doneBy} · {new Date(item.doneAt).toLocaleTimeString('es-ES')}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            {/* M-10: evidencia fotográfica */}
            <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-3">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Evidencia Fotográfica de Cierre
              </h4>
              {selectedOrder.closureEvidence ? (
                <div className="flex flex-wrap items-start gap-4">
                  <img
                    src={`/api/evidence/${selectedOrder.closureEvidence.sha256}`}
                    alt={`Evidencia de cierre de ${selectedOrder.id}: ${selectedOrder.closureEvidence.fileName}`}
                    className="w-40 h-28 object-cover rounded-lg border border-[#234C66] bg-[#071824]"
                  />
                  <dl className="text-xs space-y-1 min-w-0">
                    <div><dt className="inline text-slate-400">Archivo: </dt><dd className="inline text-slate-200">{selectedOrder.closureEvidence.fileName}</dd></div>
                    <div><dt className="inline text-slate-400">Tamaño: </dt><dd className="inline text-slate-200">{(selectedOrder.closureEvidence.sizeBytes / 1024).toFixed(1)} KB</dd></div>
                    <div className="break-all"><dt className="inline text-slate-400">SHA-256: </dt><dd className="inline font-mono text-cyan-300">{selectedOrder.closureEvidence.sha256}</dd></div>
                    <div><dt className="inline text-slate-400">Adjuntada por: </dt><dd className="inline text-slate-200">{selectedOrder.closureEvidence.attachedBy} · {new Date(selectedOrder.closureEvidence.attachedAt).toLocaleTimeString('es-ES')}</dd></div>
                  </dl>
                </div>
              ) : (
                <p className="text-xs text-slate-400">Aún no hay foto de cierre. Es obligatoria para cerrar la orden.</p>
              )}
              {!isClosed && (
                <div>
                  <input
                    ref={fileRef}
                    id="wo-evidence-file"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      void run('evidence', async () => {
                        const dataUrl = await prepareEvidence(file);
                        await onUploadEvidence(selectedOrder.id, file.name, dataUrl);
                      });
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-40"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    {busy === 'evidence'
                      ? 'Subiendo y sellando…'
                      : selectedOrder.closureEvidence
                        ? 'Reemplazar foto'
                        : 'Adjuntar foto de cierre'}
                  </button>
                </div>
              )}
            </div>

            {/* Workflow */}
            {!isClosed ? (
              <div className="p-4 rounded-lg bg-[#071B28] border border-cyan-500/30 space-y-3">
                <h4 className="text-xs font-semibold text-white">Seguimiento y Cierre</h4>
                <label htmlFor="wo-closure-notes" className="sr-only">Notas de cierre</label>
                <input
                  id="wo-closure-notes"
                  type="text"
                  placeholder="Notas de cierre (ej. Brida reemplazada, presión 4.4 bar)"
                  value={closureNotes}
                  onChange={(e) => setClosureNotes(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#18364A] rounded-lg focus:outline-none focus:border-cyan-400"
                />
                {blockers.length > 0 && (
                  <ul className="text-xs text-amber-300 space-y-1 list-disc pl-4" aria-label="Requisitos pendientes para cerrar">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  {selectedOrder.status === 'Abierta' && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('progress', () => onUpdateOrder(selectedOrder.id, { status: 'En Progreso' }))
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-[#06131C] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-40"
                    >
                      <PlayCircle className="w-3.5 h-3.5" />
                      Iniciar Intervención
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy !== null || blockers.length > 0}
                    onClick={() =>
                      void run('close', async () => {
                        await onUpdateOrder(selectedOrder.id, {
                          status: 'Cerrada',
                          closureNotes:
                            closureNotes || 'Intervención completada y verificada en campo. Parámetros en rango nominal.',
                          closureEvidenceLabel: selectedOrder.closureEvidenceLabel,
                        });
                        setClosureNotes('');
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-[#04140E] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Cerrar Orden y Restaurar Nodo
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-[#06131C] border border-emerald-500/30 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 text-xs">
                  <div className="font-semibold text-emerald-400">✓ Orden cerrada con checklist completo y foto sellada</div>
                  <p className="text-slate-300">{selectedOrder.closureNotes}</p>
                  <p className="text-slate-400 font-mono break-all">Evidencia: {selectedOrder.closureEvidenceLabel}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run('dossier', () => onDownloadDossier(selectedOrder.id))}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-40"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Descargar expediente verificable
                  </button>
                  <button
                    type="button"
                    onClick={onNavigateToLedger}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Verificar en Trust Ledger
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
