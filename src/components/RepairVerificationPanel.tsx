import React from 'react';
import { CheckCircle2, Clock3, FlaskConical, OctagonAlert } from 'lucide-react';
import { explainRepair, RepairView } from '../ui/repairView';
import { t } from '../ui/i18n';
import { timeAgo } from '../ui/vocab';
import { Button, Notice, ProvenanceBadge } from './ui';

export type SimulatedMeasurementMode = 'repaired' | 'unresolved' | 'sparse';

const modes = (): Array<{ id: SimulatedMeasurementMode; label: string; help: string }> => [
  { id: 'repaired', label: t('La reparación funcionó', 'The repair worked'), help: t('3 mediciones normales', '3 normal measurements') },
  { id: 'unresolved', label: t('El problema persiste', 'The problem persists'), help: t('2 mediciones anómalas', '2 anomalous measurements') },
  { id: 'sparse', label: t('Llega solo una medición', 'Only one measurement arrives'), help: t('1 medición normal', '1 normal measurement') },
];

/**
 * Resultado de la verificación posterior a una reparación, en un solo bloque: qué dice el motor, con qué evidencia y qué falta.
 * Solo el veredicto sellado en el Trust Ledger puede decir que la reparación quedó verificada o reabierta.
 */
export const RepairVerificationPanel: React.FC<{
  view: RepairView;
  /** Con permiso de escenarios: permite inyectar mediciones simuladas posteriores (siempre rotuladas como simuladas). */
  onSimulate?: (mode: SimulatedMeasurementMode) => void;
  busy?: boolean;
}> = ({ view, onSimulate, busy }) => {
  const shown = Math.min(view.measuredAfter, view.required);
  const why = explainRepair(view);
  const seal = view.block !== undefined ? t(` Sellado en el Trust Ledger (bloque #${view.block}) junto con las lecturas que lo sustentan.`, ` Sealed in the Trust Ledger (block #${view.block}) together with the readings behind it.`) : '';
  return (
    <div className="space-y-4" data-repair-outcome={view.outcome}>
      {view.outcome === 'VERIFIED' && (
        <Notice tone="ok" title={t('Reparación verificada con mediciones posteriores', 'Repair verified with later measurements')}>
          {why}
          {seal} {view.synthetic && t('Los datos son simulados: demuestra el método, no un resultado de campo.', 'The data is simulated: this shows the method, not a field result.')}
        </Notice>
      )}
      {view.outcome === 'REOPENED' && (
        <Notice tone="critical" title={t('La reparación no resolvió el problema', 'The repair did not fix the problem')}>
          {why} {t('El punto no se da por recuperado y el caso vuelve a estar abierto.', 'The point is not treated as recovered and the case is open again.')}
          {seal}
        </Notice>
      )}
      {view.outcome === 'PENDING' && (
        <Notice tone="verifying" title={t('Pendiente de verificación', 'Pending verification')}>
          {t(`La orden se cerró ${timeAgo(view.closedAt)}, pero todavía no hay mediciones posteriores: no se puede confirmar la recuperación. Las cifras del punto son de antes del cierre.`, `The order was closed ${timeAgo(view.closedAt)}, but there are no later measurements yet, so recovery cannot be confirmed. The point’s figures predate the closing.`)}
        </Notice>
      )}
      {view.outcome === 'INCONCLUSIVE' && (
        <Notice tone="verifying" title={t('Todavía no hay evidencia suficiente', 'Not enough evidence yet')}>
          {why} {t('Mientras tanto el punto no se presenta como recuperado.', 'Until then the point is not shown as recovered.')}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm text-soft" role="img" aria-label={t(`Mediciones normales seguidas: ${shown} de ${view.required}`, `Consecutive normal measurements: ${shown} of ${view.required}`)}>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {Array.from({ length: view.required }, (_, i) => (
            <span key={i} className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${i < shown ? 'border-ok bg-ok/15 text-ok' : 'border-line-strong text-quiet'}`}>
              {i < shown ? <CheckCircle2 className="h-3.5 w-3.5" /> : view.outcome === 'REOPENED' ? <OctagonAlert className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
            </span>
          ))}
        </span>
        <span aria-hidden="true">
          {shown}/{view.required}
        </span>
        {view.synthetic && view.measuredAfter > 0 && <ProvenanceBadge kind="simulado" />}
      </div>

      {onSimulate && !view.sealed && (
        <div className="space-y-2 rounded-xl border border-dashed border-line-strong p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            <FlaskConical className="h-4 w-4 text-accent" aria-hidden="true" /> {t('Simular las mediciones que llegarían después', 'Simulate the measurements that would arrive afterwards')} <ProvenanceBadge kind="simulado" />
          </p>
          <p className="text-xs text-quiet">{t('Las lecturas las genera el solver hidráulico y pasan por el mismo motor que las reales. No hay resultados prefabricados: el veredicto lo calcula el motor.', 'The readings come from the hydraulic solver and go through the same engine as real ones. Nothing is prefabricated: the engine computes the verdict.')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {modes().map((m) => (
              <Button key={m.id} variant="secondary" busy={busy} disabled={busy} onClick={() => onSimulate(m.id)} className="flex-1 flex-col !items-start gap-0 py-2 text-left">
                <span>{m.label}</span>
                <span className="text-xs font-normal text-quiet">{m.help}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
