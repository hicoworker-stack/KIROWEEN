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
import type { SimulatedMeasurementMode } from './components/RepairVerificationPanel';
import { Button, Notice } from './components/ui';
import { tr } from './ui/engineText';
import { chooseLang, detectLang, setLang, t, useLang } from './ui/i18n';
import { AdvancedTab, hashFor, MainView, networkSummary, parseHash } from './ui/vocab';

/** Pasos de la demostración guiada, sobre los cuatro apartados de la aplicación. */
const guidedSteps = (): Array<{ view: MainView; tab?: AdvancedTab; title: string; hint: string }> => [
  { view: 'home', title: t('Qué está pasando', 'What is happening'), hint: t('Inicio resume el estado de la red y lo que requiere tu atención. Todas las lecturas son simuladas.', 'Home summarizes the network status and what needs your attention. All readings are simulated.') },
  { view: 'incidents', title: t('Entender el incidente', 'Understand the incident'), hint: t('Elige el incidente: verás qué pasa, qué significa y qué tan respaldado está. La causa es una hipótesis, no un hecho.', 'Choose the incident: you will see what is happening, what it means and how well supported it is. The cause is a hypothesis, not a fact.') },
  { view: 'incidents', title: t('Decidir', 'Decide'), hint: t('Acepta la recomendación para crear la orden de trabajo, cámbiala o descártala. Queda registrado con tu usuario.', 'Accept the recommendation to create the work order, change it or dismiss it. It is recorded under your user.') },
  { view: 'orders', title: t('Registrar la intervención', 'Record the intervention'), hint: t('Completa las tareas, añade la foto y cierra la orden. Después comprueba si ya hay mediciones que confirmen la recuperación.', 'Complete the tasks, add the photo and close the order. Then check whether measurements confirm the recovery.') },
  { view: 'advanced', tab: 'ledger', title: t('Verificar el registro', 'Verify the record'), hint: t('El Trust Ledger encadena cada decisión. Verifícalo o prueba a alterarlo para ver cómo se detecta.', 'The Trust Ledger chains every decision. Verify it or try tampering with it to see how it is detected.') },
];
export default function App() {
  // key: al pasar de visitante a usuario (o al revés) la aplicación se vuelve a montar y recarga su estado con los permisos nuevos.
  return <AuthGate>{(session) => <AppInner key={session.user.id} user={session.user} onLogout={session.logout} />}</AuthGate>;
}

function AppInner({ user, onLogout }: { user: SessionUser; onLogout?: () => void }) {
  useLang(); // al cambiar el idioma, esta función y todo lo que cuelga de ella se vuelven a dibujar
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
    aiProvider: t('Cargando proveedor...', 'Loading provider...'),
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

  // Al entrar o salir de una sesión se vuelve a Inicio (la aplicación se monta de nuevo leyendo la URL).
  const handleLogout = onLogout
    ? () => {
        if (typeof window !== 'undefined') window.location.hash = hashFor('home');
        onLogout();
      }
    : undefined;

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
        setLoadError(res.status === 401 ? t('Tu sesión terminó.', 'Your session ended.') : t(`El servidor respondió con el error ${res.status}.`, `The server answered with error ${res.status}.`));
        return;
      }
      applyServerState(await res.json());
      setLoadError(null);
    } catch {
      setLoadError(t('No hay conexión con el servidor.', 'There is no connection to the server.'));
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
      notify(t('Volvió la conexión.', 'The connection is back.'));
      void hydrateState();
    };
    const handleOffline = () => {
      setBrowserOnline(false);
      notify(t('Se perdió la conexión. Puedes seguir reportando: se guarda en este dispositivo.', 'The connection was lost. You can keep reporting: it is saved on this device.'));
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
        notify(t(`Escenario simulado «${data.scenario.label}» ejecutado. Mira Incidentes.`, `Simulated scenario “${tr(data.scenario.label)}” run. See Incidents.`));
      } else {
        notify(data.error ?? t('No se pudo ejecutar el escenario.', 'The scenario could not be run.'));
      }
    } finally {
      setIsBusy(false);
    }
  };

  /** Simula las mediciones que llegarían tras cerrar una orden. El veredicto lo calculan los motores del servidor, no la interfaz. */
  const handleSimulateMeasurements = async (orderId: string, mode: SimulatedMeasurementMode) => {
    const res = await apiFetch(`/api/work-orders/${orderId}/simulated-measurements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      applyServerState(data);
      notify(t('Mediciones simuladas recibidas. El motor evaluó la reparación: revisa el resultado en la orden.', 'Simulated measurements received. The engine assessed the repair: see the result in the order.'));
    } else {
      notify(data.error ?? t('No se pudieron simular las mediciones.', 'The measurements could not be simulated.'));
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
        notify(t('La red volvió a su estado normal. El estado anterior se guardó en el servidor.', 'The network is back to its normal state. The previous state was saved on the server.'));
      } else {
        notify(data.error ?? (await readServerMessage(res, t('No se pudo reiniciar la red.', 'The network could not be reset.'))));
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
      if (!res.ok) throw new Error(data.error || t('No se pudo iniciar la demostración.', 'The demonstration could not be started.'));
      applyServerState(data);
      setSelectedNodeId(data.scenario.nodeId);
      setSelectedIncidentId(data.anomaly?.id ?? null);
      setGuidedStepIdx(0);
      navigate('home');
      notify(t('Demostración iniciada. Todas las lecturas son simuladas.', 'Demonstration started. All readings are simulated.'));
    } catch (e) {
      notify(e instanceof Error ? e.message : t('Error al iniciar la demostración.', 'Error starting the demonstration.'));
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
    if (!res.ok) throw new Error(data.error || t('Error en el análisis de la imagen', 'Error analyzing the image'));
    applyServerState(data);
    notify(t('Foto guardada y registrada.', 'Photo saved and recorded.'));
    return data.analysis;
  };

  /** Foto añadida desde un incidente: se vincula al incidente activo de ese punto. */
  const handleAddIncidentPhoto = async (nodeId: string, dataUrl: string, title: string) => {
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error(t('La foto no se pudo preparar.', 'The photo could not be prepared.'));
    await handleAnalyzeVision({ nodeId, imageUrl: '', imageTitle: title, imageBase64: m[2], imageMimeType: m[1] });
  };

  const handleGenerateDiagnosis = async (anomalyId: string) => {
    const res = await apiFetch('/api/ai/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anomalyId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('No se pudo generar el diagnóstico.', 'The diagnosis could not be generated.'));
    applyServerState(data);
    notify(t('Diagnóstico listo.', 'Diagnosis ready.'));
  };

  const handleDecideDiagnosis = async (
    diagnosisId: string,
    payload: { decision: 'accepted' | 'modified' | 'rejected'; operatorNote?: string; modifiedAction?: string; modifiedPriority?: PriorityLevel }
  ) => {
    const res = await apiFetch(`/api/diagnoses/${diagnosisId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t(`El servidor rechazó la decisión (${res.status}).`, `The server rejected the decision (${res.status}).`));
    applyServerState(data);
    notify(data.createdOrder ? t(`Orden ${data.createdOrder.id} creada y registrada.`, `Order ${data.createdOrder.id} created and recorded.`) : t('La recomendación se descartó y quedó registrada.', 'The recommendation was dismissed and recorded.'));
  };

  /** Llama a la API de órdenes; si el servidor rechaza, lanza el mensaje real para mostrarlo en la UI. */
  const callWorkOrderApi = async (url: string, method: string, body: unknown) => {
    let res: Response;
    try {
      res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error(t('Sin conexión con el servidor. La acción no se aplicó.', 'No connection to the server. The action was not applied.'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status} del servidor.`);
    applyServerState(data);
    return data;
  };

  const handleUpdateWorkOrder = async (orderId: string, payload: { status: WorkOrderStatus; closureNotes?: string; closureEvidenceLabel?: string }) => {
    await callWorkOrderApi(`/api/work-orders/${orderId}`, 'PATCH', payload);
    notify(payload.status === 'Cerrada' ? t(`Orden ${orderId} cerrada y sellada. Falta confirmar la recuperación con mediciones.`, `Order ${orderId} closed and sealed. Recovery still has to be confirmed with measurements.`) : t(`Orden ${orderId}: ${payload.status.toLowerCase()}.`, `Order ${orderId}: ${payload.status === 'Abierta' ? 'open' : 'in progress'}.`));
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
    notify(t('Foto guardada y sellada.', 'Photo saved and sealed.'));
  };

  const handleDownloadDossier = async (orderId: string) => {
    const res = await apiFetch(`/api/work-orders/${orderId}/dossier`);
    if (!res.ok) throw new Error(t('No se pudo generar el expediente.', 'The dossier could not be generated.'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-${orderId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify(t('Expediente descargado. Puedes verificarlo sin conexión con: npm run verify:dossier -- <archivo>', 'Dossier downloaded. You can verify it offline with: npm run verify:dossier -- <file>'));
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
        notify(data.error ?? t('No se pudieron enviar los reportes. Siguen guardados en este dispositivo.', 'The reports could not be sent. They are still saved on this device.'));
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
      notify(t('No se pudieron enviar los reportes. Siguen guardados en este dispositivo.', 'The reports could not be sent. They are still saved on this device.'));
    } finally {
      setSyncing(false);
    }
  };

  // ───────────── Derivados ─────────────

  const pendingReports = offlineReports.filter((r) => r.syncStatus === 'pending').length;
  const summary = networkSummary({ nodes, anomalies, diagnoses, orders: workOrders, pendingReports });
  const activeGuidedStep = guidedStepIdx !== null ? guidedSteps()[guidedStepIdx] : null;
  const goToStep = (i: number) => {
    setGuidedStepIdx(i);
    navigate(guidedSteps()[i].view, guidedSteps()[i].tab);
  };

  const advancedContent = () => {
    switch (advancedTab) {
      case 'evidencia':
        return <VisionIntelligenceView nodes={nodes} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} visionAnalyses={visionAnalyses} onAnalyzeVision={handleAnalyzeVision} canAnalyze={can(user.role, 'ai:use')} />;
      case 'ledger':
        return <TrustLedgerView ledger={ledger} serverVerify={can(user.role, 'dossier:verify')} />;
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

  const viewLabel = view === 'home' ? t('Inicio', 'Home') : view === 'map' ? t('Mapa', 'Map') : view === 'incidents' ? t('Incidentes', 'Incidents') : view === 'orders' ? t('Órdenes de trabajo', 'Work orders') : t('Herramientas avanzadas', 'Advanced tools');

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
      onLogout={handleLogout}
    >
      <div className="space-y-6">
        {persistenceStatus?.mode === 'memory-only' && (
          <Notice tone="critical" title={t('El servidor no puede guardar los datos en disco', 'The server cannot save data to disk')} live="assertive">
            {t('Los datos solo existen en memoria y se perderán al reiniciar el servidor. Un administrador puede exportar una copia en Herramientas avanzadas → Conexión e integraciones.', 'The data only exists in memory and will be lost when the server restarts. An administrator can export a copy in Advanced tools → Connection and integrations.')}
            {persistenceStatus.lastError ? t(` Último error: ${persistenceStatus.lastError}`, ` Last error: ${persistenceStatus.lastError}`) : ''}
          </Notice>
        )}
        {integrity && integrity.status !== 'ok' && (
          <Notice tone={integrity.status === 'compromised' ? 'critical' : 'attention'} title={integrity.status === 'compromised' ? t('La integridad del registro está comprometida', 'The integrity of the record is compromised') : t('La comprobación de integridad tiene avisos', 'The integrity check has warnings')} live="assertive">
            {integrity.issues.slice(0, 2).join(' · ')}{' '}
            <button type="button" onClick={() => navigate('advanced', 'ledger')} className="cursor-pointer font-semibold text-accent underline">
              {t('Ver el registro', 'See the record')}
            </button>
          </Notice>
        )}

        {activeGuidedStep && guidedStepIdx !== null && (
          <section aria-label={t('Demostración guiada', 'Guided demonstration')} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-bold uppercase tracking-wider text-accent">
                {t('Demostración · paso', 'Demonstration · step')} {guidedStepIdx + 1} {t('de', 'of')} {guidedSteps().length}: {activeGuidedStep.title}
              </p>
              <p className="text-sm text-soft">{activeGuidedStep.hint}</p>
            </div>
            <div className="flex gap-2">
              {guidedStepIdx > 0 && (
                <Button variant="ghost" onClick={() => goToStep(guidedStepIdx - 1)}>
                  {t('Anterior', 'Previous')}
                </Button>
              )}
              {guidedStepIdx < guidedSteps().length - 1 ? (
                <Button variant="primary" onClick={() => goToStep(guidedStepIdx + 1)}>
                  {t('Siguiente', 'Next')}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setGuidedStepIdx(null)}>
                  {t('Terminar', 'Finish')}
                </Button>
              )}
            </div>
          </section>
        )}

        {toastMsg && (
          <Notice tone="neutral" onClose={() => setToastMsg(null)}>
            {tr(toastMsg)}
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
              ledger={ledger}
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
              ledger={ledger}
              onSimulateMeasurements={can(user.role, 'scenario:trigger') ? handleSimulateMeasurements : undefined}
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
