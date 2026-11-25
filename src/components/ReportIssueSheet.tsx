import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2 } from 'lucide-react';
import { prepareImage } from '../client/image';
import { buildOfflineIdempotencyKey } from '../core/offlineStore';
import { AnomalyCategory, NetworkNode, OfflineReportRecord } from '../core/types';
import { t } from '../ui/i18n';
import { Button, Notice, ProvenanceBadge } from './ui';

interface ReportIssueSheetProps {
  open: boolean;
  nodes: NetworkNode[];
  reporterName: string;
  online: boolean;
  defaultNodeId?: string;
  onSave: (record: OfflineReportRecord) => Promise<void>;
  onClose: () => void;
}

const kinds = (): Array<{ value: AnomalyCategory; label: string; hint: string }> => [
  { value: 'leak', label: t('Fuga de agua', 'Water leak'), hint: t('Agua saliendo de un tubo o una conexión', 'Water coming out of a pipe or a connection') },
  { value: 'contamination', label: t('Agua turbia o con olor', 'Cloudy or smelly water'), hint: t('Cambio de color, olor o sabor', 'A change in color, smell or taste') },
  { value: 'obstruction', label: t('Poca agua o bloqueo', 'Low water or a blockage'), hint: t('Llega menos agua de lo normal', 'Less water than usual is arriving') },
  { value: 'sensor_fault', label: t('Equipo dañado', 'Damaged equipment'), hint: t('Un medidor, válvula o bomba falla', 'A meter, valve or pump is failing') },
];

/**
 * Reporte de campo en tres pasos cortos: dónde, qué, y una foto opcional. Se guarda en este dispositivo y se envía cuando hay conexión.
 * Lo que se escribe aquí es DECLARADO: queda registrado como lo dijo una persona, sin verificar por ningún sensor.
 */
export const ReportIssueSheet: React.FC<ReportIssueSheetProps> = ({ open, nodes, reporterName, online, defaultNodeId, onSave, onClose }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nodeId, setNodeId] = useState(defaultNodeId ?? nodes[0]?.id ?? '');
  const [category, setCategory] = useState<AnomalyCategory>('leak');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setDone(false);
      setError(null);
      if (defaultNodeId) setNodeId(defaultNodeId);
      d.showModal?.();
    }
    if (!open && d.open) d.close?.();
  }, [open, defaultNodeId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await onSave({
        id: `OFF-${Date.now().toString(36).toUpperCase()}`,
        idempotencyKey: buildOfflineIdempotencyKey(nodeId, category, description, now),
        createdAt: now,
        nodeId,
        category,
        reporterName: reporterName || t('Operador de campo', 'Field operator'),
        description: description.trim(),
        photoDataUrl: photo,
        syncStatus: 'pending',
      });
      setDescription('');
      setPhoto(undefined);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('No se pudo guardar el reporte.', 'The report could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="report-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[92vh] w-[min(94vw,32rem)] overflow-y-auto rounded-xl border border-line-strong bg-surface p-0 text-ink backdrop:bg-black/60"
    >
      {open && (
        <div className="space-y-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="report-title" className="font-display text-xl font-semibold">
                {t('Reportar un problema', 'Report a problem')}
              </h2>
              <p className="mt-1 text-sm text-soft">{t('Lo que escribas queda registrado como', 'What you write is recorded as')} <ProvenanceBadge kind="declarado" />{t(', a nombre de ', ', under the name of ')}{reporterName}.</p>
            </div>
          </div>

          {done ? (
            <div className="space-y-4">
              <Notice tone="ok" title={t('Reporte guardado en este dispositivo', 'Report saved on this device')}>
                {online ? t('Aún no se envió al servidor. Pulsa «Enviar ahora» en Inicio para que el equipo lo vea.', 'It has not been sent to the server yet. Press Send now on Home so the team can see it.') : t('Se enviará cuando vuelva la conexión. Puedes seguir reportando.', 'It will be sent when the connection returns. You can keep reporting.')}
              </Notice>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setDone(false)}>
                  {t('Hacer otro reporte', 'Make another report')}
                </Button>
                <Button variant="primary" onClick={onClose}>
                  {t('Listo', 'Done')}
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <label htmlFor="rep-node" className="mb-1.5 block text-sm font-semibold text-ink">
                  {t('1. ¿Dónde?', '1. Where?')}
                </label>
                <select id="rep-node" value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-base text-ink">
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset>
                <legend className="mb-1.5 text-sm font-semibold text-ink">{t('2. ¿Qué viste?', '2. What did you see?')}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {kinds().map((k) => (
                    <label key={k.value} className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-lg border px-3 py-2 ${category === k.value ? 'border-accent bg-accent/10' : 'border-line-strong hover:bg-raised'}`}>
                      <input type="radio" name="kind" value={k.value} checked={category === k.value} onChange={() => setCategory(k.value)} className="sr-only" />
                      <span className="text-sm font-semibold text-ink">{k.label}</span>
                      <span className="text-xs text-quiet">{k.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor="rep-desc" className="mb-1.5 block text-sm font-semibold text-ink">
                  {t('Cuéntalo en una frase', 'Tell it in one sentence')}
                </label>
                <textarea id="rep-desc" rows={3} required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('Ej.: sale agua por la unión del tubo junto a la escuela', 'E.g. water is coming out of the pipe joint next to the school')} className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-base text-ink placeholder:text-quiet" />
              </div>

              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="sr-only"
                  aria-label={t('Tomar o elegir una foto', 'Take or choose a photo')}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      setPhoto(await prepareImage(f));
                      setError(null);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : t('No se pudo preparar la foto.', 'The photo could not be prepared.'));
                    }
                  }}
                />
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={() => fileRef.current?.click()} icon={<Camera className="h-4 w-4" />}>
                    {photo ? t('Cambiar la foto', 'Change the photo') : t('Añadir una foto (opcional)', 'Add a photo (optional)')}
                  </Button>
                  {photo && (
                    <span className="flex items-center gap-2 text-sm text-ok">
                      <img src={photo} alt={t('Vista previa de la foto adjunta', 'Preview of the attached photo')} className="h-11 w-11 rounded-md border border-line object-cover" />
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {t('Foto lista', 'Photo ready')}
                    </span>
                  )}
                </div>
              </div>

              {error && <Notice tone="critical" live="assertive">{error}</Notice>}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={onClose} disabled={saving}>
                  {t('Cancelar', 'Cancel')}
                </Button>
                <Button type="submit" variant="primary" busy={saving} disabled={!description.trim()}>
                  {t('Guardar reporte', 'Save report')}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </dialog>
  );
};
