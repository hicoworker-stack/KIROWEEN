import React from 'react';
import { CheckCircle2, CircleSlash, HelpCircle, MinusCircle, Droplets } from 'lucide-react';
import { ConcordanceReport, ChannelVerdict } from '../core/evidenceConcordance';
import { LeakForensicsReport } from '../core/leakForensics';
import { NetworkNode } from '../core/types';

const VERDICT_META: Record<ChannelVerdict, { label: string; className: string; Icon: React.FC<{ className?: string }> }> = {
  supports: { label: 'Respalda', className: 'text-emerald-400', Icon: CheckCircle2 },
  contradicts: { label: 'Contradice', className: 'text-rose-400', Icon: CircleSlash },
  neutral: { label: 'No concluyente', className: 'text-amber-300', Icon: MinusCircle },
  missing: { label: 'Sin dato', className: 'text-slate-400', Icon: HelpCircle },
};

export const ConcordancePanel: React.FC<{ report: ConcordanceReport; rawConfidencePct: number; calibratedPct: number }> = ({
  report,
  rawConfidencePct,
  calibratedPct,
}) => {
  const statusLabel =
    report.status === 'concordant'
      ? 'Concordante'
      : report.status === 'partial'
        ? 'Parcial'
        : report.status === 'conflict'
          ? 'En conflicto'
          : 'Solo sensores';
  const statusClass =
    report.status === 'concordant'
      ? 'text-emerald-400'
      : report.status === 'conflict'
        ? 'text-rose-400'
        : 'text-amber-300';
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-3" aria-label="Concordancia multimodal">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">
          Concordancia Sensores · Foto · Topología
        </h4>
        <span className={`text-xs font-mono font-semibold ${statusClass}`}>
          {statusLabel} · {report.score}/100
        </span>
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
        <span className="font-mono text-slate-400">
          Confianza del modelo {rawConfidencePct}% → calibrada {calibratedPct}%.
        </span>
      </p>
    </div>
  );
};

export const ForensicsPanel: React.FC<{ report: LeakForensicsReport; nodes: NetworkNode[] }> = ({ report, nodes }) => {
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  if (!report.detected) {
    return (
      <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] text-xs text-slate-400 space-y-1">
        <div className="flex items-center gap-2 text-slate-200 font-semibold">
          <Droplets className="w-4 h-4 text-cyan-400" />
          Forense hidráulica
        </div>
        <p>{report.resolutionNote}</p>
        {report.meterInconsistencies.map((m) => (
          <p key={m} className="text-amber-300">⚠ {m}</p>
        ))}
      </div>
    );
  }
  return (
    <div className="p-4 rounded-lg bg-[#06131C] border border-cyan-500/30 space-y-3" aria-label="Forense hidráulica de fuga">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Droplets className="w-4 h-4 text-cyan-400" />
          Forense hidráulica: pérdida estimada
        </div>
        <span className="text-xs font-mono text-slate-400">Confianza de localización: {report.confidence}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-lg bg-[#071824] border border-[#18364A]">
          <div className="text-xs text-slate-400">Caudal perdido (estimado)</div>
          <div className="text-xl font-mono font-semibold text-rose-300 tabular-nums">{report.estimatedLossLs} L/s</div>
        </div>
        <div className="p-3 rounded-lg bg-[#071824] border border-[#18364A]">
          <div className="text-xs text-slate-400">Volumen si no se interviene</div>
          <div className="text-xl font-mono font-semibold text-rose-300 tabular-nums">{report.estimatedLossM3PerDay} m³/día</div>
        </div>
      </div>
      <ul className="space-y-2">
        {report.suspects.map((s) => (
          <li key={s.pipeId} className="p-3 rounded-lg bg-[#071824] border border-[#18364A] text-xs space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-cyan-300 font-semibold">
                {s.pipeId} · {nameOf(s.fromNodeId)} → {nameOf(s.toNodeId)} ({s.lengthM} m)
              </span>
              <span className="font-mono text-slate-200 tabular-nums">{Math.round(s.probability * 100)}% probabilidad</span>
            </div>
            <ul className="list-disc pl-4 text-slate-400 space-y-0.5">
              {s.rationale.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {report.meterInconsistencies.map((m) => (
        <p key={m} className="text-xs text-amber-300">⚠ {m}</p>
      ))}
      <p className="text-xs text-slate-400 leading-relaxed">{report.resolutionNote}</p>
    </div>
  );
};
