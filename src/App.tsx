import React, { useCallback, useEffect, useState } from 'react';
import { DIFFERENTIAL_SCENARIOS, NETWORK_PIPES, createBaselineNodes } from './core/networkData';
import { listOfflineReports, saveOfflineReport, updateOfflineReport } from './core/offlineStore';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  OfflineReportRecord,
  PriorityLevel,
  ScenarioId,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
  VisionAnalysisResult,
  WorkOrderStatus,
} from './core/types';
import { can } from './core/permissions';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HydraulicDiagnosis } from './core/hydraulicDiagnosis';
import { destructiveFetch, readServerMessage } from './client/adminFetch';
import { apiFetch, SessionUser } from './client/api';
import { AuthGate } from './client/AuthGate';
import { AppShell } from './components/AppShell';
import { HomeView } from './components/HomeView';
import { MapView } from './components/MapView';
import { IncidentsView } from './components/IncidentsView';
import { WorkOrdersView } from './components/WorkOrdersView';
import { AdvancedView, DemoPanel } from './components/AdvancedView';
import { SensorIntelligenceView } from './components/SensorIntelligenceView';
import { VisionIntelligenceView } from './components/VisionIntelligenceView';
import { TrustLedgerView } from './components/TrustLedgerView';
import { IntegrationsAndOfflineView } from './components/IntegrationsAndOfflineView';
import { ReportIssueSheet } from './components/ReportIssueSheet';
import { Button, Notice } from './components/ui';
import { AdvancedTab, hashFor, MainView, networkSummary, parseHash } from './ui/vocab';

/** Pasos de la demostración guiada, sobre los cuatro apartados de la aplicación. */
const GUIDED_STEPS: Array<{ view: MainView; tab?: AdvancedTab; title: string; hint: string }> = [
  { view: 'home', title: 'Qué está pasando', hint: 'Inicio resume el estado de la red y lo que requiere tu atención. Todas las lecturas son simuladas.' },
  { view: 'incidents', title: 'Entender el incidente', hint: 'Elige el incidente: verás qué pasa, qué significa y qué tan respaldado está. La causa es una hipótesis, no un hecho.' },
  { view: 'incidents', title: 'Decidir', hint: 'Acepta la recomendación para crear la orden de trabajo, cámbiala o descártala. Queda registrado con tu usuario.' },
  { view: 'orders', title: 'Registrar la intervención', hint: 'Completa las tareas, añade la foto y cierra la orden. Después comprueba si ya hay mediciones que confirmen la recuperación.' },
  { view: 'advanced', tab: 'ledger', title: 'Verificar el registro', hint: 'El Trust Ledger encadena cada decisión. Verifícalo o prueba a alterarlo para ver cómo se detecta.' },
];

export default function App() {
  return <AuthGate>{(session) => <AppInner user={session.user} onLogout={session.logout} />}</AuthGate>;
}

function AppInner({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const initial = typeof window !== 'undefined' ? parseHash(window.location.hash) : { view: 'home' as MainView, tab: 'sensores' as AdvancedTab };
  const [view, setView] = useState<MainView>(initial.view);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>(initial.tab);

  const [nodes, setNodes] = useState<NetworkNode[]>(() => createBaselineNodes());
  const [seriesByNode, setSeriesByNode] = useState<Record<string, TelemetryReading[]>>({});
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [visionAnalyses, setVisionAnalyses] = useState<VisionAnalysisResult[]>([]);
  const [diagnoses, setDiagnoses] = useState<AquaBrainDiagnosis[]>([]);
  const [workOrders, setWorkOrders] = useState<SmartWorkOrder[]>([]);
  const [ledger, setLedger] = useState<TrustLedgerEntry[]>([]);
  const [providerStatus, setProviderStatus] = useState<{ aiProvider: string; aiMode: 'gemini-live' | 'fallback-adapter'; awsAdapters: Record<string, string> }>({
    aiProvider: 'Cargando proveedor...',
    aiMode: 'fallback-adapter',
    awsAdapters: {},
  });
  const [hydraulic, setHydraulic] = useState<HydraulicDiagnosis | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<{ mode: 'disk' | 'memory-only'; lastError: string | null } | null>(null);
  const [integrity, setIntegrity] = useState<{ status: 'ok' | 'degraded' | 'compromised'; issues: string[] } | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const [selectedNodeId, setSelectedNodeId] = useState<string>('N-TOMA-01');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isSimulatorRunning, setIsSimulatorRunning] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [browserOnline, setBrowserOnline] = useState<boolean>(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [offlineReports, setOfflineReports] = useState<OfflineReportRecord[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [guidedStepIdx, setGuidedStepIdx] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const effectiveOffline = !browserOnline || isOfflineMode;
  const online = !effectiveOffline;

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? null : prev)), 6000);
  }, []);

  // ───────────── Navegación (con historial del navegador) ─────────────

  const navigate = useCallback((next: MainView, tab?: AdvancedTab) => {
    setView(next);
    if (tab) setAdvancedTab(tab);
    if (typeof window !== 'undefined') {
      const target = hashFor(next, tab ?? 'sensores');
      if (window.location.hash !== target) window.location.hash = target;
      window.scrollTo?.({ top: 0 });
    }
  }, []);

  useEffect(() => {
    const onHash = () => {
      const p = parseHash(window.location.hash);
      setView(p.view);
      if (p.view === 'advanced') setAdvancedTab(p.tab);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openIncident = (id: string) => {
    setSelectedIncidentId(id);
    navigate('incidents');
  };
  const openOrder = (id: string) => {
    setSelectedOrderId(id);
    navigate('orders');
  };

  // ───────────── Estado del servidor ─────────────

  /** Aplica el estado que envía el servidor. Cada campo se valida: un dato inesperado se ignora, no deja la interfaz en blanco. */
  const applyServerState = useCallback((data: Record<string, any>) => {
    if (Array.isArray(data.nodes)) setNodes(data.nodes);
    if (data.seriesByNode && typeof data.seriesByNode === 'object') setSeriesByNode(data.seriesByNode);
    if (Array.isArray(data.anomalies)) setAnomalies(data.anomalies);
    if (Array.isArray(data.visionAnalyses)) setVisionAnalyses(data.visionAnalyses);
    if (Array.isArray(data.diagnoses)) setDiagnoses(data.diagnoses);
    if (Array.isArray(data.workOrders)) setWorkOrders(data.workOrders);
    if (Array.isArray(data.ledger)) setLedger(data.ledger);
    if ('hydraulic' in data) setHydraulic(data.hydraulic ?? null);
    if (data.provider) setProviderStatus(data.provider);
    if (data.persistence) setPersistenceStatus(data.persistence);
    if (data.integrity) setIntegrity(data.integrity);
    if (Array.isArray(data.nodes)) setLastUpdatedAt(Date.now());
  }, []);

  const hydrateState = useCallback(async () => {
    try {
      const res = await apiFetch('/api/state');
      if (!res.ok) {
        setLoadError(res.status === 401 ? 'Tu sesión terminó.' : `El servidor respondió con el error ${res.status}.`);
        return;
      }
      applyServerState(await res.json());
      setLoadError(null);
    } catch {
      setLoadError('No hay conexión con el servidor.');
    } finally {
      setLoading(false);
    }
  }, [applyServerState]);

  useEffect(() => {
    void hydrateState();
    listOfflineReports()
      .then(setOfflineReports)
      .catch(() => {});
  }, [hydrateState]);

  // Conectividad real del navegador (M-04)
  useEffect(() => {
    const handleOnline = () => {
      setBrowserOnline(true);
      notify('Volvió la conexión.');
      void hydrateState();
    };
    const handleOffline = () => {
      setBrowserOnline(false);
      notify('Se perdió la conexión. Puedes seguir reportando: se guarda en este dispositivo.');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [notify, hydrateState]);

  // Actualizaciones en vivo (enriquecimiento de IA sin bloquear). Se cierra al revocarse la sesión.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    const handleUpdate = (event: MessageEvent) => {
      try {
        applyServerState(JSON.parse(event.data));
      } catch {
        // fragmento mal formado: se ignora
      }
    };
    source.addEventListener('state_update', handleUpdate);
    return () => {
      source.removeEventListener('state_update', handleUpdate);
      source.close();
    };
  }, [applyServerState]);

  // Simulador IoT (herramienta avanzada)
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
        levelPct: targetNode.baseline.levelPct > 0 ? Number(Math.min(100, Math.max(0, targetNode.current.levelPct + jitter(0.8))).toFixed(1)) : 0,
        turbidityNtu: Number(Math.max(0.2, targetNode.current.turbidityNtu + jitter(0.05)).toFixed(2)),
        chlorineMgL: Number(Math.max(0.05, targetNode.current.chlorineMgL + jitter(0.02)).toFixed(2)),
        ph: Number((targetNode.current.ph + jitter(0.04)).toFixed(2)),
        synthetic: true,
      };
      try {
        const res = await apiFetch('/api/telemetry/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readings: [simulatedReading] }) });
        if (res.ok) applyServerState(await res.json());
      } catch {
        // error transitorio del ciclo
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [isSimulatorRunning, nodes, selectedNodeId, applyServerState]);

  // ───────────── Acciones ─────────────

  const handleTriggerScenario = async (id: ScenarioId) => {
    setIsBusy(true);
    try {
      const res = await apiFetch(`/api/scenarios/${id}/trigger`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        applyServerState(data);
        setSelectedNodeId(data.scenario.nodeId);
        if (data.anomaly?.id) setSelectedIncidentId(data.anomaly.id);
        notify(`Escenario simulado «${data.scenario.label}» ejecutado. Mira Incidentes.`);
      } else {
        notify(data.error ?? 'No se pudo ejecutar el escenario.');
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetDemo = async () => {
    setIsBusy(true);
    try {
      const res = await destructiveFetch('/api/reset', 'reset');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        applyServerState(data);
        setGuidedStepIdx(null);
        setSelectedIncidentId(null);
        setSelectedOrderId(null);
        notify('La red volvió a su estado normal. El estado anterior se guardó en el servidor.');
      } else {
        notify(data.error ?? (await readServerMessage(res, 'No se pudo reiniciar la red.')));
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleRunFrankensteinDemo = async () => {
    setIsBusy(true);
    try {
      const res = await destructiveFetch('/api/demo/frankenstein', 'demo');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo iniciar la demostración.');
      applyServerState(data);
      setSelectedNodeId(data.scenario.nodeId);
      setSelectedIncidentId(data.anomaly?.id ?? null);
      setGuidedStepIdx(0);
      navigate('home');
      notify('Demostración iniciada. Todas las lecturas son simuladas.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error al iniciar la demostración.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleIngestCsv = async (csvText: string) => {
    const res = await apiFetch('/api/telemetry/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csvText }) });
    const data = await res.json();
    if (res.ok) applyServerState(data);
    return { ingestedCount: data.ingestedCount ?? 0, errors: data.errors ?? [] };
  };

  const handleAnalyzeVision = async (payload: { nodeId: string; imageUrl: string; imageTitle: string; imageBase64?: string; imageMimeType?: string }): Promise<VisionAnalysisResult> => {
    const res = await apiFetch('/api/ai/vision-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error en el análisis de la imagen');
    applyServerState(data);
    notify('Foto guardada y registrada.');
    return data.analysis;
  };

  /** Foto añadida desde un incidente: se vincula al incidente activo de ese punto. */
  const handleAddIncidentPhoto = async (nodeId: string, dataUrl: string, title: string) => {
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('La foto no se pudo preparar.');
    await handleAnalyzeVision({ nodeId, imageUrl: '', imageTitle: title, imageBase64: m[2], imageMimeType: m[1] });
  };

  const handleGenerateDiagnosis = async (anomalyId: string) => {
    const res = await apiFetch('/api/ai/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anomalyId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo generar el diagnóstico.');
    applyServerState(data);
    notify('Diagnóstico listo.');
  };

  const handleDecideDiagnosis = async (
    diagnosisId: string,
    payload: { decision: 'accepted' | 'modified' | 'rejected'; operatorNote?: string; modifiedAction?: string; modifiedPriority?: PriorityLevel }
  ) => {
    const res = await apiFetch(`/api/diagnoses/${diagnosisId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `El servidor rechazó la decisión (${res.status}).`);
    applyServerState(data);
    notify(data.createdOrder ? `Orden ${data.createdOrder.id} creada y registrada.` : 'La recomendación se descartó y quedó registrada.');
  };

  /** Llama a la API de órdenes; si el servidor rechaza, lanza el mensaje real para mostrarlo en la UI. */
  const callWorkOrderApi = async (url: string, method: string, body: unknown) => {
    let res: Response;
    try {
      res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error('Sin conexión con el servidor. La acción no se aplicó.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status} del servidor.`);
    applyServerState(data);
    return data;
  };

  const handleUpdateWorkOrder = async (orderId: string, payload: { status: WorkOrderStatus; closureNotes?: string; closureEvidenceLabel?: string }) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}`, 'PATCH', payload);
    notify(payload.status === 'Cerrada' ? `Orden ${orderId} cerrada y sellada. Falta confirmar la recuperación con mediciones.` : `Orden ${orderId}: ${payload.status.toLowerCase()}.`);
  };
  const handleAssignOrder = async (orderId: string, assignee: string) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/assignee`, 'PATCH', { assignee });
    notify(`Responsable de ${orderId}: ${assignee}.`);
  };
  const handleToggleChecklist = async (orderId: string, itemId: string, done: boolean) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/checklist/${itemId}`, 'PATCH', { done });
  };
  const handleUploadEvidence = async (orderId: string, fileName: string, dataUrl: string) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}/evidence`, 'POST', { fileName, dataUrl });
    notify('Foto guardada y sellada.');
  };

  const handleDownloadDossier = async (orderId: string) => {
    const res = await apiFetch(`/api/work-orders/${orderId}/dossier`);
    if (!res.ok) throw new Error('No se pudo generar el expediente.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-${orderId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Expediente descargado. Puedes verificarlo sin conexión con: npm run verify:dossier -- <archivo>');
  };

  const handleCreateOfflineReport = async (record: OfflineReportRecord) => {
    await saveOfflineReport(record);
    setOfflineReports(await listOfflineReports());
  };

  const handleSyncOfflineReports = async () => {
    const pending = offlineReports.filter((r) => r.syncStatus === 'pending');
    if (pending.length === 0) return;
    setSyncing(true);
    try {
      const res = await apiFetch('/api/sync/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: pending }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify(data.error ?? 'No se pudieron enviar los reportes. Siguen guardados en este dispositivo.');
        return;
      }
      for (const item of data.results as Array<{ id: string; status: 'synced' | 'duplicate' | 'conflict'; note: string }>) {
        const match = offlineReports.find((r) => r.id === item.id);
        if (match) await updateOfflineReport({ ...match, syncStatus: item.status, syncNote: item.note });
      }
      setOfflineReports(await listOfflineReports());
      applyServerState(data);
      notify(`Se enviaron ${data.results.length} reporte(s).`);
    } catch {
      notify('No se pudieron enviar los reportes. Siguen guardados en este dispositivo.');
    } finally {
      setSyncing(false);
    }
  };

  // ───────────── Derivados ─────────────

  const pendingReports = offlineReports.filter((r) => r.syncStatus === 'pending').length;
  const summary = networkSummary({ nodes, anomalies, diagnoses, orders: workOrders, pendingReports });
  const activeGuidedStep = guidedStepIdx !== null ? GUIDED_STEPS[guidedStepIdx] : null;
  const goToStep = (i: number) => {
    setGuidedStepIdx(i);
    navigate(GUIDED_STEPS[i].view, GUIDED_STEPS[i].tab);
  };

  const advancedContent = () => {
    switch (advancedTab) {
      case 'evidencia':
        return <VisionIntelligenceView nodes={nodes} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} visionAnalyses={visionAnalyses} onAnalyzeVision={handleAnalyzeVision} canAnalyze={can(user.role, 'ai:use')} />;
      case 'ledger':
        return <TrustLedgerView ledger={ledger} />;
      case 'conectividad':
        return (
          <IntegrationsAndOfflineView
            role={user.role}
            isOfflineMode={effectiveOffline}
            isSimulatedOffline={isOfflineMode}
            browserOnline={browserOnline}
            onToggleOfflineMode={() => setIsOfflineMode((v) => !v)}
            offlineReports={offlineReports}
            onSyncOfflineReports={handleSyncOfflineReports}
            onRefreshState={() => void hydrateState()}
            providerStatus={providerStatus}
          />
        );
      case 'demo':
        return <DemoPanel scenarios={DIFFERENTIAL_SCENARIOS} role={user.role} busy={isBusy} onTriggerScenario={handleTriggerScenario} onStartDemo={handleRunFrankensteinDemo} onReset={handleResetDemo} />;
      default:
        return (
          <SensorIntelligenceView
            nodes={nodes}
            seriesByNode={seriesByNode}
            anomalies={anomalies}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onIngestCsv={handleIngestCsv}
            isSimulatorRunning={isSimulatorRunning}
            onToggleSimulator={() => setIsSimulatorRunning((v) => !v)}
            canIngest={can(user.role, 'telemetry:ingest')}
          />
        );
    }
  };

  const viewLabel = view === 'home' ? 'Inicio' : view === 'map' ? 'Mapa' : view === 'incidents' ? 'Incidentes' : view === 'orders' ? 'Órdenes de trabajo' : 'Herramientas avanzadas';

  return (
    <AppShell
      view={view}
      user={user}
      connection={{ online, simulatedOffline: isOfflineMode, pendingReports, syncing, lastUpdatedAt }}
      allSynthetic={summary.allSynthetic}
      badges={{ incidents: summary.counts.activeIncidents, orders: summary.counts.openOrders }}
      onNavigate={(v) => {
        // Tocar un apartado de la barra siempre muestra su lista (en el móvil, no se queda en el detalle anterior).
        if (v === 'incidents') setSelectedIncidentId(null);
        if (v === 'orders') setSelectedOrderId(null);
        navigate(v);
      }}
      onLogout={onLogout}
    >
      <div className="space-y-6">
        {persistenceStatus?.mode === 'memory-only' && (
          <Notice tone="critical" title="El servidor no puede guardar los datos en disco" live="assertive">
            Los datos solo existen en memoria y se perderán al reiniciar el servidor. Un administrador puede exportar una copia en Herramientas avanzadas → Conexión e integraciones.
            {persistenceStatus.lastError ? ` Último error: ${persistenceStatus.lastError}` : ''}
          </Notice>
        )}
        {integrity && integrity.status !== 'ok' && (
          <Notice tone={integrity.status === 'compromised' ? 'critical' : 'attention'} title={integrity.status === 'compromised' ? 'La integridad del registro está comprometida' : 'La comprobación de integridad tiene avisos'} live="assertive">
            {integrity.issues.slice(0, 2).join(' · ')}{' '}
            <button type="button" onClick={() => navigate('advanced', 'ledger')} className="cursor-pointer font-semibold text-accent underline">
              Ver el registro
            </button>
          </Notice>
        )}

        {activeGuidedStep && guidedStepIdx !== null && (
          <section aria-label="Demostración guiada" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-bold uppercase tracking-wider text-accent">
                Demostración · paso {guidedStepIdx + 1} de {GUIDED_STEPS.length}: {activeGuidedStep.title}
              </p>
              <p className="text-sm text-soft">{activeGuidedStep.hint}</p>
            </div>
            <div className="flex gap-2">
              {guidedStepIdx > 0 && (
                <Button variant="ghost" onClick={() => goToStep(guidedStepIdx - 1)}>
                  Anterior
                </Button>
              )}
              {guidedStepIdx < GUIDED_STEPS.length - 1 ? (
                <Button variant="primary" onClick={() => goToStep(guidedStepIdx + 1)}>
                  Siguiente
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setGuidedStepIdx(null)}>
                  Terminar
                </Button>
              )}
            </div>
          </section>
        )}

        {toastMsg && (
          <Notice tone="neutral" onClose={() => setToastMsg(null)}>
            {toastMsg}
          </Notice>
        )}

        <ErrorBoundary scope={viewLabel} resetKey={`${view}-${advancedTab}`}>
          {view === 'home' && (
            <HomeView
              nodes={nodes}
              anomalies={anomalies}
              diagnoses={diagnoses}
              workOrders={workOrders}
              seriesByNode={seriesByNode}
              pendingReports={pendingReports}
              online={online}
              syncing={syncing}
              loading={loading}
              loadError={loadError}
              lastUpdatedAt={lastUpdatedAt}
              role={user.role}
              onOpenIncident={openIncident}
              onOpenOrder={openOrder}
              onSyncReports={() => void handleSyncOfflineReports()}
              onNavigate={(v) => navigate(v)}
              onReport={() => setReportOpen(true)}
              onRetry={() => void hydrateState()}
              onStartDemo={can(user.role, 'destructive:demo') ? () => void handleRunFrankensteinDemo() : undefined}
            />
          )}
          {view === 'map' && (
            <MapView nodes={nodes} pipes={NETWORK_PIPES} anomalies={anomalies} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onOpenIncident={openIncident} onOpenAdvanced={(tab) => navigate('advanced', tab)} />
          )}
          {view === 'incidents' && (
            <IncidentsView
              nodes={nodes}
              anomalies={anomalies}
              diagnoses={diagnoses}
              visionAnalyses={visionAnalyses}
              workOrders={workOrders}
              hydraulic={hydraulic}
              role={user.role}
              loading={loading}
              selectedId={selectedIncidentId}
              onSelect={setSelectedIncidentId}
              onGenerateDiagnosis={handleGenerateDiagnosis}
              onDecide={handleDecideDiagnosis}
              onAddPhoto={handleAddIncidentPhoto}
              onOpenOrder={openOrder}
              onReport={() => setReportOpen(true)}
              onOpenAdvanced={() => navigate('advanced', 'ledger')}
            />
          )}
          {view === 'orders' && (
            <WorkOrdersView
              workOrders={workOrders}
              nodes={nodes}
              seriesByNode={seriesByNode}
              role={user.role}
              loading={loading}
              selectedId={selectedOrderId}
              onSelect={setSelectedOrderId}
              onUpdateOrder={handleUpdateWorkOrder}
              onAssignOrder={handleAssignOrder}
              onToggleChecklist={handleToggleChecklist}
              onUploadEvidence={handleUploadEvidence}
              onDownloadDossier={handleDownloadDossier}
              onOpenLedger={() => navigate('advanced', 'ledger')}
              onOpenIncident={openIncident}
            />
          )}
          {view === 'advanced' && (
            <AdvancedView tab={advancedTab} onTab={(t) => navigate('advanced', t)} role={user.role}>
              {advancedContent()}
            </AdvancedView>
          )}
        </ErrorBoundary>
      </div>

      <ReportIssueSheet open={reportOpen} nodes={nodes} reporterName={user.displayName} online={online} defaultNodeId={selectedNodeId} onSave={handleCreateOfflineReport} onClose={() => setReportOpen(false)} />
    </AppShell>
  );
}
