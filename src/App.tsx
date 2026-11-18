import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BrainCircuit,
  ClipboardList,
  Compass,
  Eye,
  Menu,
  Play,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  createBaselineNodes,
  DIFFERENTIAL_SCENARIOS,
  NETWORK_PIPES,
} from './core/networkData';
import { listOfflineReports, saveOfflineReport, updateOfflineReport } from './core/offlineStore';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  OfflineReportRecord,
  ScenarioId,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
  WorkOrderStatus,
} from './core/types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CommandCenterView } from './components/CommandCenterView';
import { SensorIntelligenceView } from './components/SensorIntelligenceView';
import { VisionIntelligenceView } from './components/VisionIntelligenceView';
import { AquaBrainView } from './components/AquaBrainView';
import { WorkOrdersView } from './components/WorkOrdersView';
import { TrustLedgerView } from './components/TrustLedgerView';
import { IntegrationsAndOfflineView } from './components/IntegrationsAndOfflineView';

type ActiveView =
  | 'command-center'
  | 'sensors'
  | 'vision'
  | 'aqua-brain'
  | 'work-orders'
  | 'ledger'
  | 'integrations';

const NAV_ITEMS: Array<{
  id: ActiveView;
  label: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'command-center', label: 'Command Center', icon: Compass },
  { id: 'sensors', label: 'Sensores IoT', icon: Activity },
  { id: 'vision', label: 'Visión Multimodal', icon: Eye },
  { id: 'aqua-brain', label: 'Aqua Brain', icon: BrainCircuit },
  { id: 'work-orders', label: 'Órdenes de Trabajo', icon: ClipboardList },
  { id: 'ledger', label: 'Trust Ledger', icon: ShieldCheck },
  { id: 'integrations', label: 'Offline e Integraciones', icon: Settings2 },
];

const GUIDED_STEPS: Array<{ step: number; view: ActiveView; title: string; hint: string }> = [
  {
    step: 1,
    view: 'command-center',
    title: 'Evento hidráulico y forense de fuga',
    hint: 'El nodo Troncal Norte está crítico. Lee el tramo sospechoso (P-05), el caudal perdido estimado y la población expuesta aguas abajo.',
  },
  {
    step: 2,
    view: 'sensors',
    title: 'Series temporales del evento',
    hint: 'Presión y caudal derivan minuto a minuto frente a la línea base. Cambia a pH o nivel para ver que el resto sigue estable.',
  },
  {
    step: 3,
    view: 'vision',
    title: 'Evidencia fotográfica',
    hint: 'La foto de la brida se correlaciona con los sensores. Separa lo observado de lo que no se puede confirmar.',
  },
  {
    step: 4,
    view: 'aqua-brain',
    title: 'Diagnóstico explicable y concordancia',
    hint: 'Revisa si sensores, foto y topología coinciden. La confianza se limita si hay conflicto. Aprueba para emitir la orden.',
  },
  {
    step: 5,
    view: 'work-orders',
    title: 'Ejecución: responsable, checklist y foto',
    hint: 'Asigna responsable, completa el checklist y adjunta la foto de cierre. Sin eso el sistema no deja cerrar.',
  },
  {
    step: 6,
    view: 'ledger',
    title: 'Trazabilidad verificable',
    hint: 'Verifica la cadena SHA-256. Prueba "Simular Alteración" y observa el bloque exacto que se rompe.',
  },
];
export default function App() {
  const [showWelcome, setShowWelcome] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const params = new URLSearchParams(window.location.search);
    return params.get('autostart') !== '1';
  });

  const [activeView, setActiveView] = useState<ActiveView>('command-center');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [nodes, setNodes] = useState<NetworkNode[]>(() => createBaselineNodes());
  const [seriesByNode, setSeriesByNode] = useState<Record<string, TelemetryReading[]>>({});
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [visionAnalyses, setVisionAnalyses] = useState<VisionAnalysisResult[]>([]);
  const [diagnoses, setDiagnoses] = useState<AquaBrainDiagnosis[]>([]);
  const [workOrders, setWorkOrders] = useState<SmartWorkOrder[]>([]);
  const [ledger, setLedger] = useState<TrustLedgerEntry[]>([]);
  const [providerStatus, setProviderStatus] = useState<{
    aiProvider: string;
    aiMode: 'gemini-live' | 'fallback-adapter';
    awsAdapters: Record<string, string>;
  }>({
    aiProvider: 'Cargando proveedor...',
    aiMode: 'fallback-adapter',
    awsAdapters: {},
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string>('N-TOMA-01');
  const [isBusy, setIsBusy] = useState(false);
  const [isSimulatorRunning, setIsSimulatorRunning] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [browserOnline, setBrowserOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [offlineReports, setOfflineReports] = useState<OfflineReportRecord[]>([]);
  const [guidedStepIdx, setGuidedStepIdx] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const effectiveOffline = !browserOnline || isOfflineMode;

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? null : prev));
    }, 4000);
  }, []);

  const hydrateState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data = await res.json();
      setNodes(data.nodes);
      setSeriesByNode(data.seriesByNode);
      setAnomalies(data.anomalies);
      setVisionAnalyses(data.visionAnalyses);
      setDiagnoses(data.diagnoses);
      setWorkOrders(data.workOrders);
      setLedger(data.ledger);
      if (data.provider) setProviderStatus(data.provider);
    } catch {
      // Backend unavailable: keep baseline state
    }
  }, []);

  useEffect(() => {
    hydrateState();
    listOfflineReports()
      .then(setOfflineReports)
      .catch(() => {});
  }, [hydrateState]);

  // Real browser connectivity listeners (M-04)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      setBrowserOnline(true);
      notify('Conectividad de red restaurada.');
    };
    const handleOffline = () => {
      setBrowserOnline(false);
      notify('Conexión de red perdida. Los reportes se guardarán en IndexedDB local.');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [notify]);

  // Live SSE updates for non-blocking AI enrichment (M-01)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined' || showWelcome) {
      return;
    }
    const source = new EventSource('/api/events');
    const handleUpdate = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data.nodes)) setNodes(data.nodes);
        if (data.seriesByNode) setSeriesByNode(data.seriesByNode);
        if (Array.isArray(data.anomalies)) setAnomalies(data.anomalies);
        if (Array.isArray(data.visionAnalyses)) setVisionAnalyses(data.visionAnalyses);
        if (Array.isArray(data.diagnoses)) setDiagnoses(data.diagnoses);
        if (Array.isArray(data.workOrders)) setWorkOrders(data.workOrders);
        if (Array.isArray(data.ledger)) setLedger(data.ledger);
        if (data.provider) setProviderStatus(data.provider);
      } catch {
        // ignore malformed SSE chunk
      }
    };
    source.addEventListener('state_update', handleUpdate);
    return () => {
      source.removeEventListener('state_update', handleUpdate);
      source.close();
    };
  }, [showWelcome]);

  // Real-time IoT simulator loop
  useEffect(() => {
    if (!isSimulatorRunning) return;
    const timer = setInterval(async () => {
      const targetNode = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];
      if (!targetNode) return;
      const jitter = (amp: number) => (Math.random() - 0.5) * 2 * amp;
      const simulatedReading: TelemetryReading = {
        id: `SIM-${targetNode.id}-${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        nodeId: targetNode.id,
        pressureBar: Number(Math.max(0.2, targetNode.current.pressureBar + jitter(0.08)).toFixed(2)),
        flowLs: Number(Math.max(0.5, targetNode.current.flowLs + jitter(0.6)).toFixed(2)),
        levelPct:
          targetNode.baseline.levelPct > 0
            ? Number(Math.min(100, Math.max(0, targetNode.current.levelPct + jitter(0.8))).toFixed(1))
            : 0,
        turbidityNtu: Number(Math.max(0.2, targetNode.current.turbidityNtu + jitter(0.05)).toFixed(2)),
        chlorineMgL: Number(Math.max(0.05, targetNode.current.chlorineMgL + jitter(0.02)).toFixed(2)),
        ph: Number((targetNode.current.ph + jitter(0.04)).toFixed(2)),
        synthetic: true,
      };

      try {
        const res = await fetch('/api/telemetry/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readings: [simulatedReading] }),
        });
        if (res.ok) {
          const data = await res.json();
          setNodes(data.nodes);
          setSeriesByNode(data.seriesByNode);
          setAnomalies(data.anomalies);
          setLedger(data.ledger);
        }
      } catch {
        // ignore transient tick errors
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [isSimulatorRunning, nodes, selectedNodeId]);

  const handleTriggerScenario = async (id: ScenarioId) => {
    setIsBusy(true);
    try {
      const res = await fetch(`/api/scenarios/${id}/trigger`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setNodes(data.nodes);
        setSeriesByNode(data.seriesByNode);
        setAnomalies(data.anomalies);
        setVisionAnalyses(data.visionAnalyses);
        setDiagnoses(data.diagnoses);
        setLedger(data.ledger);
        setSelectedNodeId(data.scenario.nodeId);
        notify(`Escenario "${data.scenario.label}" ejecutado y registrado en Trust Ledger.`);
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetDemo = async () => {
    setIsBusy(true);
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setNodes(data.nodes);
        setSeriesByNode(data.seriesByNode);
        setAnomalies(data.anomalies);
        setVisionAnalyses(data.visionAnalyses);
        setDiagnoses(data.diagnoses);
        setWorkOrders(data.workOrders);
        setLedger(data.ledger);
        setGuidedStepIdx(null);
        notify('Red comunitaria restablecida a línea base nominal.');
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartGuidedDemo = () => handleRunFrankensteinDemo();

  const handleIngestCsv = async (csvText: string) => {
    const res = await fetch('/api/telemetry/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText }),
    });
    const data = await res.json();
    if (res.ok) {
      setNodes(data.nodes);
      setSeriesByNode(data.seriesByNode);
      setAnomalies(data.anomalies);
      setLedger(data.ledger);
    }
    return {
      ingestedCount: data.ingestedCount ?? 0,
      errors: data.errors ?? [],
    };
  };

  const handleAnalyzeVision = async (payload: {
    nodeId: string;
    imageUrl: string;
    imageTitle: string;
    imageBase64?: string;
    imageMimeType?: string;
  }): Promise<VisionAnalysisResult> => {
    const res = await fetch('/api/ai/vision-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error en análisis visual');
    setVisionAnalyses(data.visionAnalyses);
    setLedger(data.ledger);
    notify('Análisis multimodal completado y registrado en Trust Ledger.');
    return data.analysis;
  };

  const handleGenerateDiagnosis = async (anomalyId: string) => {
    const res = await fetch('/api/ai/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anomalyId }),
    });
    const data = await res.json();
    if (res.ok) {
      setDiagnoses(data.diagnoses);
      setLedger(data.ledger);
      notify('Diagnóstico generado en Aqua Brain.');
    }
  };

  const handleDecideDiagnosis = async (
    diagnosisId: string,
    payload: {
      decision: 'accepted' | 'modified' | 'rejected';
      operatorNote?: string;
      modifiedAction?: string;
      modifiedPriority?: AquaBrainDiagnosis['priority'];
    }
  ) => {
    const res = await fetch(`/api/diagnoses/${diagnosisId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      setDiagnoses(data.diagnoses);
      setWorkOrders(data.workOrders);
      setLedger(data.ledger);
      if (data.createdOrder) {
        notify(`Orden ${data.createdOrder.id} emitida y sellada en Trust Ledger.`);
      } else {
        notify('Decisión de rechazo auditada en Trust Ledger.');
      }
    }
  };

  const applyWorkOrderResponse = (data: {
    workOrders: SmartWorkOrder[];
    anomalies: AnomalyEvent[];
    nodes: NetworkNode[];
    seriesByNode: Record<string, TelemetryReading[]>;
    ledger: TrustLedgerEntry[];
  }) => {
    setWorkOrders(data.workOrders);
    setAnomalies(data.anomalies);
    setNodes(data.nodes);
    setSeriesByNode(data.seriesByNode);
    setLedger(data.ledger);
  };

  /** Llama a la API de órdenes; si el servidor rechaza, lanza el mensaje real para mostrarlo en la UI. */
  const callWorkOrderApi = async (url: string, method: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Sin conexión con el servidor. La acción no se aplicó.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status} del servidor.`);
    applyWorkOrderResponse(data);
    return data;
  };

  const handleUpdateWorkOrder = async (
    orderId: string,
    payload: {
      status: WorkOrderStatus;
      closureNotes?: string;
      closureEvidenceLabel?: string;
    }
  ) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}`, 'PATCH', payload);
    notify(`Orden ${orderId} actualizada a ${payload.status}.`);
  };

  const handleAssignOrder = async (orderId: string, assignee: string) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/assignee`, 'PATCH', { assignee });
    notify(`Responsable de ${orderId}: ${assignee}. Registrado en Trust Ledger.`);
  };

  const handleToggleChecklist = async (orderId: string, itemId: string, done: boolean) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/checklist/${itemId}`, 'PATCH', { done });
  };

  const handleUploadEvidence = async (orderId: string, fileName: string, dataUrl: string) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/evidence`, 'POST', { fileName, dataUrl });
    notify('Foto de cierre almacenada y su SHA-256 sellado en Trust Ledger.');
  };

  const handleDownloadDossier = async (orderId: string) => {
    const res = await fetch(`/api/work-orders/${orderId}/dossier`);
    if (!res.ok) throw new Error('No se pudo generar el expediente.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-${orderId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Expediente descargado. Verifícalo offline con: npm run verify:dossier -- <archivo>');
  };

  const handleRunFrankensteinDemo = async () => {
    setShowWelcome(false);
    setIsBusy(true);
    try {
      const res = await fetch('/api/demo/frankenstein', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo iniciar el modo demo.');
      setNodes(data.nodes);
      setSeriesByNode(data.seriesByNode);
      setAnomalies(data.anomalies);
      setVisionAnalyses(data.visionAnalyses);
      setDiagnoses(data.diagnoses);
      setWorkOrders(data.workOrders ?? []);
      setLedger(data.ledger);
      setSelectedNodeId(data.scenario.nodeId);
      setActiveView('command-center');
      setGuidedStepIdx(0);
      notify('Modo demo reproducible iniciado. Todas las lecturas son sintéticas.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error al iniciar el modo demo.');
    } finally {
      setIsBusy(false);
    }
  };
  const handleCreateOfflineReport = async (record: OfflineReportRecord) => {
    await saveOfflineReport(record);
    const updated = await listOfflineReports();
    setOfflineReports(updated);
    notify(`Reporte ${record.id} guardado localmente en IndexedDB.`);
  };

  const handleSyncOfflineReports = async () => {
    const pending = offlineReports.filter((r) => r.syncStatus === 'pending');
    if (pending.length === 0) return;
    const res = await fetch('/api/sync/offline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reports: pending }),
    });
    const data = await res.json();
    if (res.ok) {
      for (const item of data.results as Array<{
        id: string;
        status: 'synced' | 'duplicate' | 'conflict';
        note: string;
      }>) {
        const match = offlineReports.find((r) => r.id === item.id);
        if (match) {
          await updateOfflineReport({
            ...match,
            syncStatus: item.status,
            syncNote: item.note,
          });
        }
      }
      const refreshed = await listOfflineReports();
      setOfflineReports(refreshed);
      setLedger(data.ledger);
      if (data.visionAnalyses) setVisionAnalyses(data.visionAnalyses);
      if (data.anomalies) setAnomalies(data.anomalies);
      if (data.diagnoses) setDiagnoses(data.diagnoses);
      if (data.nodes) setNodes(data.nodes);
      notify(
        `Sincronización completada (${data.results.length} reporte(s)) e integrada a Aqua Brain.`
      );
    }
  };

  if (showWelcome) {
    return (
      <WelcomeScreen
        onEnterCommandCenter={() => setShowWelcome(false)}
        onStartGuidedDemo={handleStartGuidedDemo}
      />
    );
  }

  const activeAlertsCount = anomalies.filter((a) => a.status === 'active').length;
  const pendingOfflineCount = offlineReports.filter((r) => r.syncStatus === 'pending').length;
  const activeGuidedStep = guidedStepIdx !== null ? GUIDED_STEPS[guidedStepIdx] : null;

  return (
    <div className="min-h-screen bg-[#06131C] text-[#E6F1F5] flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-[#06131C]/95 backdrop-blur border-b border-[#18364A] px-3 sm:px-4 lg:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4 lg:gap-8">
        {/* Zone 1: Brand Title */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Abrir menú de navegación"
            className="lg:hidden p-1.5 text-slate-300 hover:text-white rounded-md border border-[#18364A] shrink-0"
          >
            {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveView('command-center')}
            className="flex items-center gap-2 text-sm sm:text-base font-semibold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
              className="text-cyan-400 shrink-0"
            >
              <rect x="2" y="2" width="24" height="24" rx="6" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M14 7C14 7 9 13.2 9 16.5C9 19.26 11.24 21.5 14 21.5C16.76 21.5 19 19.26 19 16.5C19 13.2 14 7 14 7Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
            </svg>
            Aqua Sentinel
          </button>
          <span
            className="hidden sm:inline-flex items-center px-2 py-0.5 text-[11px] font-mono font-semibold text-amber-300 border border-amber-500/40 rounded-md whitespace-nowrap"
            title="Todas las lecturas de esta red son sintéticas, generadas para la demostración. No son mediciones reales."
          >
            DATOS SINTÉTICOS
          </span>
        </div>

        {/* Zone 2: 4 concise single-line nav links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-300">
          {(
            [
              ['command-center', 'Command Center'],
              ['sensors', 'Sensores'],
              ['aqua-brain', 'Aqua Brain'],
              ['ledger', 'Trust Ledger'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveView(id)}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                activeView === id
                  ? 'text-cyan-300 border-cyan-400'
                  : 'text-slate-400 border-transparent hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={handleStartGuidedDemo}
            className="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Demostración Guiada</span>
            <span className="sm:hidden">Demo Guiada</span>
          </button>
        </div>
      </header>

      <div className="flex-1 flex relative">
        {/* Left Navigation Sidebar */}
        <aside
          className={`${
            mobileMenuOpen ? 'fixed inset-y-14 left-0 z-20 block' : 'hidden'
          } lg:block w-60 shrink-0 bg-[#081722] border-r border-[#18364A] p-4 flex flex-col justify-between`}
        >
          <div className="space-y-6">
            <div className="space-y-1">
              <p className="px-2.5 pb-1 text-xs font-medium text-slate-400">Operación Hídrica</p>
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                const badgeCount =
                  item.id === 'command-center'
                    ? activeAlertsCount
                    : item.id === 'work-orders'
                      ? workOrders.filter((w) => w.status !== 'Cerrada').length
                      : item.id === 'integrations'
                        ? pendingOfflineCount
                        : 0;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveView(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-[#0F2736] text-cyan-300 border border-[#234C66]'
                        : 'text-slate-300 hover:bg-[#0B202E] hover:text-white border border-transparent'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 truncate">
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {badgeCount > 0 && (
                      <span className="font-mono text-xs text-cyan-300 tabular-nums">
                        {badgeCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="pt-4 border-t border-[#18364A] px-2 space-y-2 text-xs">
              <div className="text-slate-400">Red activa</div>
              <div className="font-medium text-slate-200">San Cristóbal de las Aguas</div>
              <div className="text-slate-400 font-mono">
                {effectiveOffline ? '▲ Modo Offline Local' : '● Enlace Activo'}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 min-w-0 p-4 lg:p-6 max-w-[1320px] w-full mx-auto space-y-5">
          {/* Guided Demo Interactive Stepper */}
          {activeGuidedStep && (
            <div className="bg-[#0A2231] border border-cyan-500/40 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5">
                <div className="text-xs font-mono text-cyan-300">
                  Demostración Guiada · Paso {activeGuidedStep.step} de {GUIDED_STEPS.length}:{' '}
                  {activeGuidedStep.title}
                </div>
                <p className="text-xs text-slate-200">{activeGuidedStep.hint}</p>
              </div>
              <div className="flex items-center gap-2">
                {guidedStepIdx! > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const prev = guidedStepIdx! - 1;
                      setGuidedStepIdx(prev);
                      setActiveView(GUIDED_STEPS[prev].view);
                    }}
                    className="px-3 py-1.5 text-xs font-medium bg-[#06131C] text-slate-200 border border-[#234C66] rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    Anterior
                  </button>
                )}
                {guidedStepIdx! < GUIDED_STEPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      const next = guidedStepIdx! + 1;
                      setGuidedStepIdx(next);
                      setActiveView(GUIDED_STEPS[next].view);
                    }}
                    className="px-3.5 py-1.5 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    Siguiente Paso
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setGuidedStepIdx(null)}
                    className="px-3.5 py-1.5 text-xs font-semibold bg-emerald-500 text-[#04140E] rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    Finalizar Guía
                  </button>
                )}
              </div>
            </div>
          )}

          {toastMsg && (
            <div
              role="status"
              className="px-4 py-2.5 rounded-lg bg-[#0B2636] border border-cyan-500/40 text-xs text-cyan-200 flex items-center justify-between gap-3"
            >
              <span>{toastMsg}</span>
              <button
                type="button"
                onClick={() => setToastMsg(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
                aria-label="Cerrar notificación"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {activeView === 'command-center' && (
            <CommandCenterView
              nodes={nodes}
              pipes={NETWORK_PIPES}
              anomalies={anomalies}
              visionAnalyses={visionAnalyses}
              scenarios={DIFFERENTIAL_SCENARIOS}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onTriggerScenario={handleTriggerScenario}
              onResetDemo={handleResetDemo}
              onNavigateToView={(v) => setActiveView(v)}
              isBusy={isBusy}
            />
          )}

          {activeView === 'sensors' && (
            <SensorIntelligenceView
              nodes={nodes}
              seriesByNode={seriesByNode}
              anomalies={anomalies}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onIngestCsv={handleIngestCsv}
              isSimulatorRunning={isSimulatorRunning}
              onToggleSimulator={() => setIsSimulatorRunning((v) => !v)}
            />
          )}

          {activeView === 'vision' && (
            <VisionIntelligenceView
              nodes={nodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              visionAnalyses={visionAnalyses}
              onAnalyzeVision={handleAnalyzeVision}
            />
          )}

          {activeView === 'aqua-brain' && (
            <AquaBrainView
              diagnoses={diagnoses}
              anomalies={anomalies}
              nodes={nodes}
              pipes={NETWORK_PIPES}
              visionAnalyses={visionAnalyses}
              selectedNodeId={selectedNodeId}
              onGenerateDiagnosis={handleGenerateDiagnosis}
              onDecideDiagnosis={handleDecideDiagnosis}
              onNavigateToWorkOrders={() => setActiveView('work-orders')}
            />
          )}

          {activeView === 'work-orders' && (
            <WorkOrdersView
              workOrders={workOrders}
              onUpdateOrder={handleUpdateWorkOrder}
              onAssignOrder={handleAssignOrder}
              onToggleChecklist={handleToggleChecklist}
              onUploadEvidence={handleUploadEvidence}
              onDownloadDossier={handleDownloadDossier}
              onNavigateToLedger={() => setActiveView('ledger')}
            />
          )}

          {activeView === 'ledger' && <TrustLedgerView ledger={ledger} />}

          {activeView === 'integrations' && (
            <IntegrationsAndOfflineView
              nodes={nodes}
              isOfflineMode={effectiveOffline}
              isSimulatedOffline={isOfflineMode}
              browserOnline={browserOnline}
              onToggleOfflineMode={() => setIsOfflineMode((v) => !v)}
              offlineReports={offlineReports}
              onCreateOfflineReport={handleCreateOfflineReport}
              onSyncOfflineReports={handleSyncOfflineReports}
              providerStatus={providerStatus}
              onRefreshState={hydrateState}
            />
          )}
        </main>
      </div>
    </div>
  );
}




