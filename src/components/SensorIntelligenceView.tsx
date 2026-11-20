import React, { useState } from 'react';
import { Upload, Play, Pause, FileSpreadsheet, AlertCircle } from 'lucide-react';
import { SAMPLE_CSV_PAYLOAD } from '../core/networkData';
import { AnomalyEvent, NetworkNode, TelemetryReading } from '../core/types';
import { MetricKey, TimeSeriesChart } from './TimeSeriesChart';

interface SensorIntelligenceViewProps {
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  anomalies: AnomalyEvent[];
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onIngestCsv: (csvText: string) => Promise<{ ingestedCount: number; errors: string[] }>;
  isSimulatorRunning: boolean;
  onToggleSimulator: () => void;
  /** Solo OPERATOR y ADMIN pueden enviar lecturas; el servidor lo exige igualmente. */
  canIngest?: boolean;
}

const METRIC_OPTIONS: Array<{
  key: MetricKey;
  label: string;
  unit: string;
  normalRange?: { min: number; max: number; label: string };
  tankOnly?: boolean;
}> = [
  { key: 'pressureBar', label: 'Presión Hidráulica', unit: 'bar' },
  { key: 'flowLs', label: 'Caudal Volumétrico', unit: 'L/s' },
  { key: 'turbidityNtu', label: 'Turbidez del Agua', unit: 'NTU' },
  { key: 'chlorineMgL', label: 'Cloro Libre Residual', unit: 'mg/L', normalRange: { min: 0.3, max: 2.5, label: 'Rango 0.3–2.5 mg/L' } },
  { key: 'levelPct', label: 'Nivel de Tanque', unit: '%', tankOnly: true },
  { key: 'ph', label: 'pH', unit: 'pH', normalRange: { min: 6.5, max: 8.5, label: 'Rango 6.5–8.5' } },
];

export const SensorIntelligenceView: React.FC<SensorIntelligenceViewProps> = ({
  nodes,
  seriesByNode,
  anomalies,
  selectedNodeId,
  onSelectNode,
  onIngestCsv,
  isSimulatorRunning,
  onToggleSimulator,
  canIngest = true,
}) => {
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('pressureBar');
  const [csvInput, setCsvInput] = useState<string>(SAMPLE_CSV_PAYLOAD);
  const [ingestFeedback, setIngestFeedback] = useState<string | null>(null);
  const [ingestErrors, setIngestErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];
  const series = seriesByNode[selectedNode.id] ?? [];
  const metricMeta = METRIC_OPTIONS.find((m) => m.key === selectedMetric)!;
  const hasLevelSensor = selectedNode.baseline.levelPct > 0;
  const metricUnavailable = metricMeta.tankOnly === true && !hasLevelSensor;
  const nodeAnomalies = anomalies.filter((a) => a.nodeId === selectedNode.id);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCsvInput(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const handleIngestSubmit = async () => {
    setSubmitting(true);
    setIngestFeedback(null);
    setIngestErrors([]);
    try {
      const res = await onIngestCsv(csvInput);
      setIngestFeedback(
        `Ingesta completada: ${res.ingestedCount} lectura(s) evaluadas por el motor determinista.`
      );
      setIngestErrors(res.errors);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Inteligencia de Sensores e Ingesta IoT</h2>
          <p className="text-xs text-slate-400 mt-1">
            Comparación de series temporales sintéticas contra línea base y evaluación determinista
            en tiempo real.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="sensor-node-select" className="sr-only">
            Seleccionar nodo de sensor
          </label>
          <select
            id="sensor-node-select"
            value={selectedNode.id}
            onChange={(e) => onSelectNode(e.target.value)}
            className="px-3 py-2 text-xs bg-[#06131C] text-slate-100 border border-[#234C66] rounded-lg focus:outline-none focus:border-cyan-400"
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.id})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onToggleSimulator}
            disabled={!canIngest}
            title={canIngest ? undefined : 'Tu rol solo permite consultar'}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              isSimulatorRunning
                ? 'bg-amber-500 hover:bg-amber-400 text-[#06131C]'
                : 'bg-cyan-500 hover:bg-cyan-400 text-[#041018]'
            }`}
          >
            {isSimulatorRunning ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                Pausar Simulador IoT
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Iniciar Simulador IoT
              </>
            )}
          </button>
        </div>
      </section>

      {/* Metric Tabs & Time-Series Chart */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#06131C] border border-[#18364A] rounded-lg">
            {METRIC_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                aria-pressed={selectedMetric === opt.key}
                onClick={() => setSelectedMetric(opt.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedMetric === opt.key
                    ? 'bg-[#0F2736] text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <span className="text-xs font-mono text-slate-400">
            Muestras en ventana: {series.length} · Datos sintéticos simulados
          </span>
        </div>

        {metricUnavailable ? (
          <div className="h-56 flex items-center justify-center text-center px-6 border border-dashed border-[#18364A] rounded-lg bg-[#071824] text-xs text-slate-400">
            {selectedNode.name} no tiene sensor de nivel. Selecciona un tanque, una bocatoma o la planta para ver esta métrica.
          </div>
        ) : (
          <TimeSeriesChart
            series={series}
            baselineValue={selectedNode.baseline[selectedMetric]}
            metric={selectedMetric}
            label={`${metricMeta.label} — ${selectedNode.name}`}
            unit={metricMeta.unit}
            normalRange={metricMeta.normalRange}
          />
        )}
      </section>

      {/* Split: Deterministic Anomaly Explanation + CSV Ingestion */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <h3 className="text-base font-semibold text-white">
            Evidencia Cuantificable del Motor Determinista
          </h3>
          {nodeAnomalies.length === 0 ? (
            <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] text-xs text-slate-400 leading-relaxed">
              No se han disparado reglas de anomalía en <strong className="text-slate-200">{selectedNode.name}</strong>.
              Todas las variables permanecen dentro de los umbrales hidráulicos y sanitarios
              esperados.
            </div>
          ) : (
            <div className="space-y-3">
              {nodeAnomalies.map((anom) => (
                <div
                  key={anom.id}
                  className="p-4 rounded-lg bg-[#06131C] border border-[#234C66] space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-white">{anom.title}</span>
                    <span className="font-mono text-rose-400">
                      Score {anom.priority.totalScore}/100
                    </span>
                  </div>
                  <div className="space-y-2">
                    {anom.rulesTriggered.map((rule) => (
                      <div key={rule.ruleId} className="text-xs text-slate-300 space-y-1">
                        <div className="font-mono text-cyan-300">
                          Regla {rule.ruleId} · Observado: {rule.observedValue} vs Base:{' '}
                          {rule.baselineValue} ({rule.deltaPct >= 0 ? `+${rule.deltaPct}%` : `${rule.deltaPct}%`})
                        </div>
                        <p className="text-slate-400 leading-relaxed">{rule.explanation}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-6 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-white">Ingesta Manual / Archivo CSV</h3>
              <p className="text-xs text-slate-400">
                Pega filas CSV o carga un archivo local para inyectar telemetría al motor.
              </p>
            </div>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer whitespace-nowrap shrink-0">
              <Upload className="w-3.5 h-3.5" />
              Subir .CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileUpload}
                className="sr-only"
              />
            </label>
          </div>

          <textarea
            aria-label="Contenido CSV de telemetría"
            rows={5}
            value={csvInput}
            onChange={(e) => setCsvInput(e.target.value)}
            className="w-full p-3 text-xs font-mono bg-[#06131C] text-slate-200 border border-[#18364A] rounded-lg focus:outline-none focus:border-cyan-400"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setCsvInput(SAMPLE_CSV_PAYLOAD)}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-300 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Cargar plantilla de ejemplo
            </button>

            <button
              type="button"
              disabled={submitting || !canIngest}
              title={canIngest ? undefined : 'Tu rol solo permite consultar'}
              onClick={handleIngestSubmit}
              className="px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {submitting ? 'Procesando...' : 'Ingestar y Evaluar CSV'}
            </button>
          </div>

          {ingestFeedback && (
            <p className="text-xs text-emerald-400 bg-[#06131C] border border-emerald-500/30 rounded-lg p-3">
              {ingestFeedback}
            </p>
          )}
          {ingestErrors.length > 0 && (
            <div className="text-xs text-rose-300 bg-[#06131C] border border-rose-500/30 rounded-lg p-3 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertCircle className="w-3.5 h-3.5" />
                Errores de validación CSV:
              </div>
              {ingestErrors.map((err, idx) => (
                <p key={idx} className="font-mono">
                  {err}
                </p>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

