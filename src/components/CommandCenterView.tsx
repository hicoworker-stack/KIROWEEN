import React, { useState } from 'react';
import { RotateCcw, ArrowRight, Eye, Cpu, AlertTriangle } from 'lucide-react';
import { analyzeNetworkHydraulics } from '../core/graphHydrology';
import {
  AnomalyEvent,
  NetworkNode,
  PipeSegment,
  ScenarioDefinition,
  ScenarioId,
} from '../core/types';
import { NetworkMap } from './NetworkMap';
import { HydraulicPanel } from './EvidencePanels';
import { HydraulicDiagnosis } from '../core/hydraulicDiagnosis';

interface CommandCenterViewProps {
  nodes: NetworkNode[];
  pipes: PipeSegment[];
  anomalies: AnomalyEvent[];
  hydraulic?: HydraulicDiagnosis | null;
  scenarios: ScenarioDefinition[];
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onTriggerScenario: (id: ScenarioId) => Promise<void>;
  onResetDemo: () => Promise<void>;
  onNavigateToView: (view: 'sensors' | 'vision' | 'aqua-brain' | 'work-orders') => void;
  isBusy: boolean;
}

export const CommandCenterView: React.FC<CommandCenterViewProps> = ({
  nodes,
  pipes,
  anomalies,
  hydraulic = null,
  scenarios,
  selectedNodeId,
  onSelectNode,
  onTriggerScenario,
  onResetDemo,
  onNavigateToView,
  isBusy,
}) => {
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'active' | 'resolved'>('all');

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];
  const activeAnomalies = anomalies.filter((a) => a.status === 'active');
  const resolvedAnomalies = anomalies.filter((a) => a.status === 'resolved');
  const hydraulics = analyzeNetworkHydraulics(nodes, pipes, anomalies);
  const selectedPropagatedRisk = hydraulics.propagatedByNode[selectedNode.id];
  const selectedMassBalance = hydraulics.massBalances.find((m) => m.nodeId === selectedNode.id);

  const filteredAnomalies = anomalies.filter((a) =>
    incidentFilter === 'all' ? true : a.status === incidentFilter
  );

  const avgPressure =
    nodes.reduce((acc, n) => acc + n.current.pressureBar, 0) / Math.max(1, nodes.length);
  const intakeFlow = nodes.find((n) => n.kind === 'intake')?.current.flowLs ?? 0;
  const maxTurbidity = Math.max(...nodes.map((n) => n.current.turbidityNtu));
  const nominalCount = nodes.filter((n) => n.status === 'nominal').length;

  const operationStateLabel =
    activeAnomalies.some((a) => a.priority.priority === 'Crítica')
      ? '✖ Atención Crítica Requerida'
      : activeAnomalies.length > 0
        ? '▲ Operación con Alertas Activas'
        : '● Operación Nominal';

  const operationStateColor =
    activeAnomalies.some((a) => a.priority.priority === 'Crítica')
      ? 'text-rose-400'
      : activeAnomalies.length > 0
        ? 'text-amber-400'
        : 'text-emerald-400';

  return (
    <div className="space-y-6">
      {/* Operational Header & 4 Differential Scenario Triggers */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold text-white">Centro de Comando Operativo</h2>
              <span aria-hidden="true" className="hidden sm:inline text-[#234C66]">·</span>
              <span className={`text-xs font-mono font-semibold ${operationStateColor}`}>
                {isBusy ? '◌ Procesando escenario...' : operationStateLabel}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Escenario interactivo con datos sintéticos simulados. Activa una incidencia para
              ejecutar detección determinista, visión multimodal, diagnóstico y registro SHA-256.
            </p>
          </div>

          <button
            type="button"
            onClick={onResetDemo}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-slate-300 border border-[#18364A] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restablecer Red Nominal
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 pt-1">
          {scenarios.map((scen) => (
            <button
              key={scen.id}
              type="button"
              disabled={isBusy}
              onClick={() => onTriggerScenario(scen.id)}
              className="text-left p-3.5 rounded-lg bg-[#06131C] hover:bg-[#0F2736] border border-[#18364A] hover:border-cyan-500/50 transition-colors cursor-pointer disabled:opacity-50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-cyan-300 whitespace-nowrap">
                  {scen.label}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </div>
              <p className="text-xs text-slate-400 mt-1.5 line-clamp-2 leading-relaxed">
                {scen.shortTitle}
              </p>
            </button>
          ))}
        </div>
      </section>

      {hydraulic && hydraulic.level !== 'no_anomaly' && <HydraulicPanel diagnosis={hydraulic} nodes={nodes} />}

      {/* 4-column Telemetry KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-4">
          <p className="text-xs text-slate-400">Presión Media de Red</p>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-mono font-semibold text-white tabular-nums">
              {avgPressure.toFixed(2)}
            </span>
            <span className="text-xs font-mono text-slate-400">bar</span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
            {nominalCount}/{nodes.length} nodos nominales
          </p>
        </div>

        <div className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-4">
          <p className="text-xs text-slate-400">Caudal de Captación</p>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-mono font-semibold text-white tabular-nums">
              {intakeFlow.toFixed(1)}
            </span>
            <span className="text-xs font-mono text-slate-400">L/s</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">Bocatoma Quebrada Alta</p>
        </div>

        <div className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-4">
          <p className="text-xs text-slate-400">Turbidez Máxima en Red</p>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span
              className={`text-2xl font-mono font-semibold tabular-nums ${
                maxTurbidity > 4 ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {maxTurbidity.toFixed(1)}
            </span>
            <span className="text-xs font-mono text-slate-400">NTU</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">Umbral operativo &le; 4.0 NTU</p>
        </div>

        <div className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-4">
          <p className="text-xs text-slate-400">Incidencias Priorizadas</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className={`text-2xl font-mono font-semibold tabular-nums ${
                activeAnomalies.length > 0 ? 'text-amber-400' : 'text-white'
              }`}
            >
              {activeAnomalies.length}
            </span>
            <span className="text-xs font-mono text-slate-400">
              activas · {resolvedAnomalies.length} resueltas
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">Motor determinista sin LLM</p>
        </div>
      </section>

      {/* Main Split: Interactive Map + Node Inspector */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8">
          <NetworkMap
            nodes={nodes}
            pipes={pipes}
            anomalies={anomalies}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
        </div>

        {/* Selected Node Operational Inspector */}
        <aside className="xl:col-span-4 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 border-b border-[#18364A] pb-3">
            <div>
              <p className="text-xs font-mono text-cyan-400">{selectedNode.id} · {selectedNode.assetCode}</p>
              <h3 className="text-base font-semibold text-white mt-0.5">{selectedNode.name}</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {selectedNode.sector} · Cota {selectedNode.elevationM} m · {selectedNode.populationServed.toLocaleString('es-ES')} hab.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
              <span className="text-slate-400">Presión</span>
              <p className="text-base font-mono font-semibold text-white tabular-nums mt-0.5">
                {selectedNode.current.pressureBar.toFixed(2)} bar
              </p>
              <span className="text-slate-400 font-mono">
                Base: {selectedNode.baseline.pressureBar.toFixed(2)} bar
              </span>
            </div>

            <div className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
              <span className="text-slate-400">Caudal</span>
              <p className="text-base font-mono font-semibold text-white tabular-nums mt-0.5">
                {selectedNode.current.flowLs.toFixed(1)} L/s
              </p>
              <span className="text-slate-400 font-mono">
                Base: {selectedNode.baseline.flowLs.toFixed(1)} L/s
              </span>
            </div>

            <div className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
              <span className="text-slate-400">Turbidez</span>
              <p
                className={`text-base font-mono font-semibold tabular-nums mt-0.5 ${
                  selectedNode.current.turbidityNtu > 4 || selectedNode.current.turbidityNtu < 0
                    ? 'text-rose-400'
                    : 'text-white'
                }`}
              >
                {selectedNode.current.turbidityNtu.toFixed(2)} NTU
              </p>
              <span className="text-slate-400 font-mono">
                Base: {selectedNode.baseline.turbidityNtu.toFixed(2)} NTU
              </span>
            </div>

            <div className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
              <span className="text-slate-400">Cloro / pH</span>
              <p className="text-base font-mono font-semibold text-white tabular-nums mt-0.5">
                {selectedNode.current.chlorineMgL.toFixed(2)} mg/L
              </p>
              <span className="text-slate-400 font-mono">
                pH {selectedNode.current.ph.toFixed(1)} · Base {selectedNode.baseline.chlorineMgL}
              </span>
            </div>
          </div>

          <div className="text-xs text-slate-400 space-y-1 pt-1">
            <p>Material: <span className="text-slate-200">{selectedNode.material}</span></p>
            <p>Diámetro nominal: <span className="text-slate-200 font-mono">{selectedNode.diameterMm} mm</span></p>
            {selectedMassBalance && (
              <p>
                Balance nodal:{' '}
                <span className={`font-mono ${selectedMassBalance.flagged ? 'text-amber-300' : 'text-slate-200'}`}>
                  {selectedMassBalance.inflowLs} → {selectedMassBalance.outflowSumLs} L/s (Δ{' '}
                  {selectedMassBalance.deviationLs >= 0
                    ? `+${selectedMassBalance.deviationLs}`
                    : selectedMassBalance.deviationLs}{' '}
                  L/s)
                </span>
              </p>
            )}
            {selectedPropagatedRisk && (
              <p className="text-amber-300 pt-1">
                ▲ {selectedPropagatedRisk.reason}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-[#18364A]">
            <button
              type="button"
              onClick={() => onNavigateToView('sensors')}
              className="flex-1 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-cyan-300 border border-[#18364A] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Ver Series
            </button>
            <button
              type="button"
              onClick={() => onNavigateToView('vision')}
              className="inline-flex items-center justify-center gap-1.5 flex-1 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-slate-200 border border-[#18364A] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              Evidencia
            </button>
            <button
              type="button"
              onClick={() => onNavigateToView('aqua-brain')}
              className="inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              Abrir Razonamiento en Aqua Brain
            </button>
          </div>
        </aside>
      </section>

      {/* Prioritized Alerts & Incidents Table */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-white">Cola de Incidencias Priorizadas</h3>
            <p className="text-xs text-slate-400">
              Ordenadas por puntuación determinista de riesgo (hidráulica, población y calidad).
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#06131C] border border-[#18364A] rounded-lg">
            {(['all', 'active', 'resolved'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setIncidentFilter(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  incidentFilter === tab
                    ? 'bg-[#0F2736] text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab === 'all' ? 'Todas' : tab === 'active' ? 'Activas' : 'Resueltas'}
              </button>
            ))}
          </div>
        </div>

        {filteredAnomalies.length === 0 ? (
          <div className="py-10 text-center border border-dashed border-[#18364A] rounded-lg space-y-2">
            <AlertTriangle className="w-5 h-5 text-slate-400 mx-auto" />
            <p className="text-sm text-slate-300">
              No hay incidencias en esta vista. Red operando en línea base nominal.
            </p>
            <p className="text-xs text-slate-400">
              Selecciona cualquiera de los 4 escenarios superiores para observar el ciclo completo.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#18364A] text-slate-400 font-medium">
                  <th className="py-2.5 pr-4">Prioridad</th>
                  <th className="py-2.5 pr-4">Nodo / Sector</th>
                  <th className="py-2.5 pr-4">Anomalía Detectada</th>
                  <th className="py-2.5 pr-4">Evidencia Cuantitativa</th>
                  <th className="py-2.5 pr-4">Estado</th>
                  <th className="py-2.5 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#132C3D]">
                {filteredAnomalies.map((anom) => {
                  const firstRule = anom.rulesTriggered[0];
                  const prioColor =
                    anom.priority.priority === 'Crítica'
                      ? 'text-rose-400'
                      : anom.priority.priority === 'Alta'
                        ? 'text-amber-400'
                        : 'text-sky-400';

                  return (
                    <tr key={anom.id} className="hover:bg-[#0F2736]/50 transition-colors">
                      <td className="py-3 pr-4 font-mono tabular-nums whitespace-nowrap">
                        <span className={`font-semibold ${prioColor}`}>
                          {anom.priority.priority} ({anom.priority.totalScore}/100)
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-medium text-white">{anom.nodeName}</div>
                        <div className="text-slate-400">{anom.sector} · {anom.nodeId}</div>
                      </td>
                      <td className="py-3 pr-4 text-slate-200 max-w-xs">{anom.title}</td>
                      <td className="py-3 pr-4 font-mono text-cyan-300 tabular-nums">
                        {firstRule
                          ? `${firstRule.metric}: ${firstRule.observedValue} vs ${firstRule.baselineValue} (${firstRule.deltaPct}%)`
                          : 'N/A'}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <span
                          className={
                            anom.status === 'active' ? 'text-rose-300' : 'text-emerald-400'
                          }
                        >
                          {anom.status === 'active' ? '● Activa' : '✓ Resuelta'}
                        </span>
                      </td>
                      <td className="py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectNode(anom.nodeId);
                            onNavigateToView('aqua-brain');
                          }}
                          className="px-3 py-1.5 text-xs font-medium bg-[#06131C] hover:bg-cyan-500 hover:text-[#041018] text-cyan-300 border border-[#234C66] rounded-md transition-colors cursor-pointer"
                        >
                          Inspeccionar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

