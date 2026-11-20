import React from 'react';
import { CheckCircle2, CircleSlash, HelpCircle, MinusCircle, Droplets } from 'lucide-react';
import { ChannelVerdict, ConcordanceReport, EVIDENCE_LEVEL_LABEL } from '../core/evidenceConcordance';
import { HydraulicDiagnosis, HydraulicLevel } from '../core/hydraulicDiagnosis';
import { NetworkNode } from '../core/types';

const VERDICT_META: Record<ChannelVerdict, { label: string; className: string; Icon: React.FC<{ className?: string }> }> = {
  supports: { label: 'Respalda', className: 'text-emerald-400', Icon: CheckCircle2 },
  contradicts: { label: 'Contradice', className: 'text-rose-400', Icon: CircleSlash },
  neutral: { label: 'No concluyente', className: 'text-amber-300', Icon: MinusCircle },
  missing: { label: 'Sin dato', className: 'text-slate-400', Icon: HelpCircle },
};

export const ConcordancePanel: React.FC<{ report: ConcordanceReport }> = ({ report }) => {
  const levelClass =
    report.level === 'alta' ? 'text-emerald-400' : report.level === 'en_conflicto' ? 'text-rose-400' : report.level === 'media' ? 'text-cyan-300' : 'text-amber-300';
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-3" aria-label="Concordancia de evidencia">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">Concordancia de evidencia</h4>
        <span className={`text-xs font-mono font-semibold ${levelClass}`}>Respaldo: {EVIDENCE_LEVEL_LABEL[report.level]}</span>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {report.channels.map((ch) => {
          const meta = VERDICT_META[ch.verdict];
          return (
            <li key={ch.channel} className="p-2.5 rounded-lg bg-[#071824] border border-[#18364A] text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-200 capitalize">{ch.channel}</span>
                <span className={`inline-flex items-center gap-1 font-mono ${meta.className}`}>
                  <meta.Icon className="w-3.5 h-3.5" />
                  {meta.label}
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed">{ch.detail}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-slate-300">
        {report.statement}{' '}
        <span className="text-slate-400">Es un nivel cualitativo por número de canales que coinciden; no es una probabilidad ni está calibrado.</span>
      </p>
    </div>
  );
};

export const HYDRAULIC_LEVEL_LABEL: Record<HydraulicLevel, string> = {
  insufficient_data: 'Datos insuficientes',
  no_anomaly: 'Balance sin anomalías',
  flow_anomaly: 'Anomalía de caudal (sin corroboración)',
  possible_leak: 'Posible fuga',
  localized_leak: 'Fuga localizada en un tramo entre medidores',
};

const levelClass = (l: HydraulicLevel) =>
  l === 'localized_leak' ? 'text-rose-300' : l === 'possible_leak' ? 'text-amber-300' : l === 'flow_anomaly' ? 'text-cyan-300' : 'text-slate-300';

export const HydraulicPanel: React.FC<{ diagnosis: HydraulicDiagnosis; nodes: NetworkNode[] }> = ({ diagnosis, nodes }) => {
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-cyan-500/30 space-y-3" aria-label="Diagnóstico hidráulico">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Droplets className="w-4 h-4 text-cyan-400" />
          Diagnóstico hidráulico
        </div>
        <span className={`text-xs font-mono font-semibold ${levelClass(diagnosis.level)}`}>{HYDRAULIC_LEVEL_LABEL[diagnosis.level]}</span>
      </div>

      {diagnosis.demandFactor && (
        <p className="text-xs text-slate-400">
          Factor de demanda estimado con los consumos medidos: <span className="font-mono text-slate-200">{diagnosis.demandFactor.value}</span> (dispersión {diagnosis.demandFactor.spread}). Un cambio general de demanda no se interpreta como fuga.
        </p>
      )}

      {diagnosis.findings.map((f) => (
        <div key={f.nodeId} className="p-3 rounded-lg bg-[#071824] border border-[#18364A] text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-100">
              {f.nodeName}: exceso de caudal de {f.excessLs} ± {f.sigmaLs} L/s <span className="text-slate-400">(z = {f.z})</span>
            </span>
            <span className={`font-mono ${levelClass(f.level)}`}>{HYDRAULIC_LEVEL_LABEL[f.level]}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded bg-[#06131C] border border-[#18364A]">
              <div className="text-slate-400">Pérdida estimada si se mantiene</div>
              <div className="font-mono text-rose-300 tabular-nums">{f.estimatedLossM3PerDay} m³/día</div>
              <div className="text-slate-500">extrapolación del balance, sin validación de campo</div>
            </div>
            <div className="p-2 rounded bg-[#06131C] border border-[#18364A]">
              <div className="text-slate-400">Límite de detección en este nodo</div>
              <div className="font-mono text-slate-200 tabular-nums">{f.detectionLimitLs} L/s</div>
              <div className="text-slate-500">3σ de la incertidumbre propagada</div>
            </div>
          </div>
          <p className="text-slate-300">
            <span className="text-slate-400">Tramo(s) candidato(s): </span>
            {f.candidates.map((c) => `${c.pipeId} (${nameOf(c.fromNodeId)} → ${nameOf(c.toNodeId)}, ${c.lengthM} m)`).join(' · ')}
          </p>
          <ul className="list-disc pl-4 text-slate-400 space-y-0.5">
            {f.rationale.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="text-slate-500">Alternativas no descartadas: {f.alternatives.join(' ')}</p>
        </div>
      ))}

      {diagnosis.meterInconsistencies.map((m) => (
        <p key={m} className="text-xs text-amber-300">⚠ {m}</p>
      ))}

      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer text-slate-300">Límites y supuestos de este diagnóstico</summary>
        <ul className="list-disc pl-4 mt-2 space-y-1">
          {diagnosis.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};
