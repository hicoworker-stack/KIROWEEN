import React, { useState } from 'react';
import { t } from '../ui/i18n';
import { TelemetryReading } from '../core/types';

export type MetricKey = 'pressureBar' | 'flowLs' | 'turbidityNtu' | 'chlorineMgL' | 'levelPct' | 'ph';

interface TimeSeriesChartProps {
  series: TelemetryReading[];
  baselineValue: number;
  metric: MetricKey;
  label: string;
  unit: string;
  /** Banda operativa aceptable (p. ej. pH 6.5–8.5). Se dibuja como referencia, no como alarma. */
  normalRange?: { min: number; max: number; label: string };
}

export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  series,
  baselineValue,
  metric,
  label,
  unit,
  normalRange,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (series.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center border border-[#18364A] rounded-lg bg-[#071824] text-xs text-slate-400">
        Sin datos de serie temporal para este nodo.
      </div>
    );
  }

  const width = 680;
  const height = 220;
  const padLeft = 48;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const values = series.map((r) => r[metric]);
  const allVals = [...values, baselineValue, ...(normalRange ? [normalRange.min, normalRange.max] : [])];
  let minVal = Math.min(...allVals);
  let maxVal = Math.max(...allVals);
  if (Math.abs(maxVal - minVal) < 0.4) {
    minVal -= 0.5;
    maxVal += 0.5;
  } else {
    const margin = (maxVal - minVal) * 0.15;
    minVal -= margin;
    maxVal += margin;
  }

  const xAt = (i: number) =>
    series.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (series.length - 1)) * plotW;
  const yAt = (v: number) => padTop + ((maxVal - v) / (maxVal - minVal)) * plotH;

  const polylinePoints = values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  const baselineY = yAt(baselineValue);

  const activeIdx = hoverIdx !== null ? hoverIdx : series.length - 1;
  const activeReading = series[activeIdx];
  const activeVal = activeReading[metric];
  const deltaPct =
    Math.abs(baselineValue) < 0.001
      ? 0
      : (((activeVal - baselineValue) / Math.abs(baselineValue)) * 100).toFixed(1);

  return (
    <div className="bg-[#071824] border border-[#18364A] rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold text-white">{label}</h4>
          <p className="text-xs text-slate-400">
            {t('Línea sólida: telemetría actual · Línea discontinua: línea base', 'Solid line: current telemetry · Dashed line: baseline')} ({baselineValue} {unit})
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
          <span className="text-cyan-300">
            Valor: {activeVal.toFixed(2)} {unit}
          </span>
          <span
            className={
              Math.abs(Number(deltaPct)) >= 20 ? 'text-rose-400' : 'text-slate-400'
            }
          >
            Δ {Number(deltaPct) >= 0 ? `+${deltaPct}%` : `${deltaPct}%`}
          </span>
          <span className="text-slate-400">
            {new Date(activeReading.timestamp).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t(`${label}: ${series.length} lecturas sintéticas, último valor ${series[series.length - 1][metric].toFixed(2)} ${unit}, línea base ${baselineValue} ${unit}`, `${label}: ${series.length} synthetic readings, latest value ${series[series.length - 1][metric].toFixed(2)} ${unit}, baseline ${baselineValue} ${unit}`)}
        className="w-full h-auto block cursor-crosshair"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Horizontal Y grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padTop + t * plotH;
          const val = maxVal - t * (maxVal - minVal);
          return (
            <g key={t}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#123042"
                strokeWidth="1"
              />
              <text
                x={padLeft - 8}
                y={y + 3}
                textAnchor="end"
                fill="#7899AB"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                {val.toFixed(1)}
              </text>
            </g>
          );
        })}

        {normalRange && (
          <g>
            <rect
              x={padLeft}
              y={yAt(normalRange.max)}
              width={plotW}
              height={Math.max(0, yAt(normalRange.min) - yAt(normalRange.max))}
              fill="#10B981"
              fillOpacity="0.07"
            />
            <text x={width - padRight - 4} y={yAt(normalRange.max) + 11} textAnchor="end" fill="#34D399" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {normalRange.label}
            </text>
          </g>
        )}

        {/* Historical baseline dashed line */}
        <line
          x1={padLeft}
          y1={baselineY}
          x2={width - padRight}
          y2={baselineY}
          stroke="#10B981"
          strokeWidth="1.5"
          strokeDasharray="5 4"
          strokeOpacity="0.8"
        />

        {/* Telemetry series */}
        <polyline
          fill="none"
          stroke="#22D3EE"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polylinePoints}
        />

        {/* Interactive hover targets and dots */}
        {series.map((r, i) => {
          const cx = xAt(i);
          const cy = yAt(r[metric]);
          const isHovered = i === activeIdx;
          const isOutlier =
            Math.abs(baselineValue) > 0.01 &&
            Math.abs((r[metric] - baselineValue) / baselineValue) > 0.22;

          return (
            <g key={r.id}>
              {isHovered && (
                <line
                  x1={cx}
                  y1={padTop}
                  x2={cx}
                  y2={height - padBottom}
                  stroke="#38BDF8"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? 5 : 3}
                fill={isOutlier ? '#F43F5E' : '#22D3EE'}
                stroke="#06131C"
                strokeWidth="1.5"
              />
              <rect
                x={cx - 14}
                y={padTop}
                width="28"
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
            </g>
          );
        })}

        {/* X Axis start/end labels */}
        <text
          x={padLeft}
          y={height - 8}
          fill="#7899AB"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          {new Date(series[0].timestamp).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </text>
        <text
          x={width - padRight}
          y={height - 8}
          textAnchor="end"
          fill="#7899AB"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          {new Date(series[series.length - 1].timestamp).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </text>
      </svg>
    </div>
  );
};

