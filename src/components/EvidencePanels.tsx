import { tr, trList } from '../ui/engineText';
import React from 'react';
import { CheckCircle2, CircleSlash, HelpCircle, MinusCircle, Droplets } from 'lucide-react';
import { ChannelVerdict, ConcordanceReport, EVIDENCE_LEVEL_LABEL } from '../core/evidenceConcordance';
import { HydraulicDiagnosis, HydraulicLevel } from '../core/hydraulicDiagnosis';
import { NetworkNode } from '../core/types';
import { live, t, useLang } from '../ui/i18n';

const VERDICT_META: Record<ChannelVerdict, { label: string; className: string; Icon: React.FC<{ className?: string }> }> = live(() => ({
  supports: { label: t('Respalda', 'Supports'), className: 'text-emerald-400', Icon: CheckCircle2 },
  contradicts: { label: t('Contradice', 'Contradicts'), className: 'text-rose-400', Icon: CircleSlash },
  neutral: { label: t('No concluyente', 'Inconclusive'), className: 'text-amber-300', Icon: MinusCircle },
  missing: { label: t('Sin dato', 'No data'), className: 'text-slate-400', Icon: HelpCircle },
}));
/** Nivel de respaldo en el idioma activo. */
const supportLevel = (l: ConcordanceReport['level']): string => ({ baja: t('baja', 'low'), media: t('media', 'medium'), alta: t('alta', 'high'), en_conflicto: t('en conflicto', 'conflicting') })[l] ?? EVIDENCE_LEVEL_LABEL[l];
const channelName = (c: string): string => ({ sensores: t('sensores', 'sensors'), reporte: t('reporte', 'report'), hidráulica: t('hidráulica', 'hydraulics'), fotografía: t('fotografía', 'photo') })[c] ?? c;
/** Las frases del motor se guardan y se sellan en español; en inglés se traducen solo al mostrarlas, y la nota lo aclara. */
const EngineTextNote: React.FC = () => (useLang() === 'en' ? <p className="text-[11px] text-slate-500">The engine writes and seals its sentences in Spanish so the hashes never change; they are translated here for display only.</p> : null);

export const ConcordancePanel: React.FC<{ report: ConcordanceReport }> = ({ report }) => {
  const levelClass =
    report.level === 'alta' ? 'text-emerald-400' : report.level === 'en_conflicto' ? 'text-rose-400' : report.level === 'media' ? 'text-cyan-300' : 'text-amber-300';
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-3" aria-label={t('Concordancia de evidencia', 'Evidence concordance')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">{t('Concordancia de evidencia', 'Evidence concordance')}</h4>
        <span className={`text-xs font-mono font-semibold ${levelClass}`}>{t('Respaldo', 'Support')}: {supportLevel(report.level)}</span>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {report.channels.map((ch) => {
          const meta = VERDICT_META[ch.verdict];
          return (
            <li key={ch.channel} className="p-2.5 rounded-lg bg-[#071824] border border-[#18364A] text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-200 capitalize">{channelName(ch.channel)}</span>
                <span className={`inline-flex items-center gap-1 font-mono ${meta.className}`}>
                  <meta.Icon className="w-3.5 h-3.5" />
                  {meta.label}
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed">{tr(ch.detail)}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-slate-300">
        {tr(report.statement)}{' '}
        <span className="text-slate-400">{t('Es un nivel cualitativo por número de canales que coinciden; no es una probabilidad ni está calibrado.', 'It is a qualitative level based on how many channels agree; it is not a probability and is not calibrated.')}</span>
      </p>
      <EngineTextNote />
    </div>
  );
};

export const HYDRAULIC_LEVEL_LABEL: Record<HydraulicLevel, string> = live(() => ({
  insufficient_data: t('Datos insuficientes', 'Insufficient data'),
  no_anomaly: t('Balance sin anomalías', 'Balance without anomalies'),
  flow_anomaly: t('Anomalía de caudal (sin corroboración)', 'Flow anomaly (not corroborated)'),
  possible_leak: t('Posible fuga', 'Possible leak'),
  localized_leak: t('Fuga localizada en un tramo entre medidores', 'Leak localized to a reach between meters'),
}));

const levelClass = (l: HydraulicLevel) =>
  l === 'localized_leak' ? 'text-rose-300' : l === 'possible_leak' ? 'text-amber-300' : l === 'flow_anomaly' ? 'text-cyan-300' : 'text-slate-300';

export const HydraulicPanel: React.FC<{ diagnosis: HydraulicDiagnosis; nodes: NetworkNode[] }> = ({ diagnosis, nodes }) => {
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-cyan-500/30 space-y-3" aria-label={t('Diagnóstico hidráulico', 'Hydraulic diagnosis')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Droplets className="w-4 h-4 text-cyan-400" />
          {t('Diagnóstico hidráulico', 'Hydraulic diagnosis')}
        </div>
        <span className={`text-xs font-mono font-semibold ${levelClass(diagnosis.level)}`}>{HYDRAULIC_LEVEL_LABEL[diagnosis.level]}</span>
      </div>

      {diagnosis.demandFactor && (
        <p className="text-xs text-slate-400">
          {t('Factor de demanda estimado con los consumos medidos:', 'Demand factor estimated from the measured consumption:')} <span className="font-mono text-slate-200">{diagnosis.demandFactor.value}</span> ({t('dispersión', 'spread')} {diagnosis.demandFactor.spread}). {t('Un cambio general de demanda no se interpreta como fuga.', 'A general change in demand is not read as a leak.')}
        </p>
      )}

      {diagnosis.findings.map((f) => (
        <div key={f.nodeId} className="p-3 rounded-lg bg-[#071824] border border-[#18364A] text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-100">
              {f.nodeName}: {t('exceso de caudal de', 'excess flow of')} {f.excessLs} ± {f.sigmaLs} L/s <span className="text-slate-400">(z = {f.z})</span>
            </span>
            <span className={`font-mono ${levelClass(f.level)}`}>{HYDRAULIC_LEVEL_LABEL[f.level]}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded bg-[#06131C] border border-[#18364A]">
              <div className="text-slate-400">{t('Pérdida estimada si se mantiene', 'Estimated loss if it continues')}</div>
              <div className="font-mono text-rose-300 tabular-nums">{f.estimatedLossM3PerDay} {t('m³/día', 'm³/day')}</div>
              <div className="text-slate-500">{t('extrapolación del balance, sin validación de campo', 'extrapolated from the balance, not field-validated')}</div>
            </div>
            <div className="p-2 rounded bg-[#06131C] border border-[#18364A]">
              <div className="text-slate-400">{t('Límite de detección en este nodo', 'Detection limit at this node')}</div>
              <div className="font-mono text-slate-200 tabular-nums">{f.detectionLimitLs} L/s</div>
              <div className="text-slate-500">{t('3σ de la incertidumbre propagada', '3σ of the propagated uncertainty')}</div>
            </div>
          </div>
          <p className="text-slate-300">
            <span className="text-slate-400">{t('Tramo(s) candidato(s):', 'Candidate reach(es):')} </span>
            {f.candidates.map((c) => `${c.pipeId} (${nameOf(c.fromNodeId)} → ${nameOf(c.toNodeId)}, ${c.lengthM} m)`).join(' · ')}
          </p>
          <ul className="list-disc pl-4 text-slate-400 space-y-0.5">
            {f.rationale.map((r) => (
              <li key={r}>{tr(r)}</li>
            ))}
          </ul>
          <p className="text-slate-500">{t('Alternativas no descartadas:', 'Alternatives not ruled out:')} {trList(f.alternatives).join(' ')}</p>
        </div>
      ))}

      {diagnosis.meterInconsistencies.map((m) => (
        <p key={m} className="text-xs text-amber-300">⚠ {tr(m)}</p>
      ))}

      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer text-slate-300">{t('Límites y supuestos de este diagnóstico', 'Limits and assumptions of this diagnosis')}</summary>
        <ul className="list-disc pl-4 mt-2 space-y-1">
          {diagnosis.limits.map((l) => (
            <li key={l}>{tr(l)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};
