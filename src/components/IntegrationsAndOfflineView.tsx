import { OperationsHealthPanel } from './OperationsHealthPanel';
import React, { useEffect, useState } from 'react';
import { WifiOff, Wifi, RefreshCw, Database, Cloud, FileCode2 } from 'lucide-react';
import { buildOfflineIdempotencyKey } from '../core/offlineStore';
import { AnomalyCategory, NetworkNode, OfflineReportRecord } from '../core/types';

interface IntegrationsAndOfflineViewProps {
  nodes: NetworkNode[];
  isOfflineMode: boolean;
  isSimulatedOffline: boolean;
  browserOnline: boolean;
  onToggleOfflineMode: () => void;
  offlineReports: OfflineReportRecord[];
  onCreateOfflineReport: (record: OfflineReportRecord) => Promise<void>;
  onSyncOfflineReports: () => Promise<void>;
  onRefreshState?: () => void;
  providerStatus: {
    aiProvider: string;
    aiMode: 'gemini-live' | 'fallback-adapter';
    awsAdapters: Record<string, string>;
  };
}

interface KiroFileItem {
  path: string;
  category: string;
  content: string;
}

export const IntegrationsAndOfflineView: React.FC<IntegrationsAndOfflineViewProps> = ({
  nodes,
  isOfflineMode,
  isSimulatedOffline,
  browserOnline,
  onToggleOfflineMode,
  offlineReports,
  onCreateOfflineReport,
  onSyncOfflineReports,
  providerStatus,
  onRefreshState,
}) => {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? 'N-TOMA-01');
  const [category, setCategory] = useState<AnomalyCategory>('leak');
  const [reporterName, setReporterName] = useState('Brigadista Comunitario');
  const [description, setDescription] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [kiroFiles, setKiroFiles] = useState<KiroFileItem[]>([]);
  const [selectedKiroPath, setSelectedKiroPath] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/kiro/files')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.files)) {
          setKiroFiles(data.files);
          if (data.files.length > 0) setSelectedKiroPath(data.files[0].path);
        }
      })
      .catch(() => {});
  }, []);

  const pendingCount = offlineReports.filter((r) => r.syncStatus === 'pending').length;

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPhotoDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitOffline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const record: OfflineReportRecord = {
        id: `OFF-${Date.now().toString(36).toUpperCase()}`,
        idempotencyKey: buildOfflineIdempotencyKey(nodeId, category, description, now),
        createdAt: now,
        nodeId,
        category,
        reporterName: reporterName.trim() || 'Operador de Campo',
        description: description.trim(),
        photoDataUrl,
        syncStatus: 'pending',
      };
      await onCreateOfflineReport(record);
      setDescription('');
      setPhotoDataUrl(undefined);
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSyncOfflineReports();
    } finally {
      setSyncing(false);
    }
  };

  const activeKiro = kiroFiles.find((f) => f.path === selectedKiroPath) ?? kiroFiles[0] ?? null;

  return (
    <div className="space-y-6">
      {/* Offline Resilience Section */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#18364A] pb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Resiliencia Offline (IndexedDB) y Sincronización
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Crea reportes en zonas rurales sin cobertura. Al sincronizar se incorporan al Command
              Center, Aqua Brain y Trust Ledger sin duplicados.
            </p>
            <p className="text-xs font-mono text-slate-400 mt-1">
              Red navegador (navigator.onLine):{' '}
              <span className={browserOnline ? 'text-emerald-400' : 'text-amber-400'}>
                {browserOnline ? 'En línea' : 'Sin conexión real'}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onToggleOfflineMode}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isOfflineMode
                  ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                  : 'bg-[#06131C] border-[#234C66] text-emerald-300'
              }`}
            >
              {isOfflineMode ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
              {!browserOnline
                ? 'Sin Red Real (Navegador)'
                : isSimulatedOffline
                  ? 'Modo Sin Conexión (Simulado)'
                  : 'Conexión Activa'}
            </button>

            <button
              type="button"
              disabled={isOfflineMode || pendingCount === 0 || syncing}
              onClick={handleSync}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              Sincronizar Cola ({pendingCount})
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form onSubmit={handleSubmitOffline} className="lg:col-span-5 space-y-3">
            <div>
              <label htmlFor="off-node" className="block text-xs text-slate-300 mb-1">
                Nodo afectado
              </label>
              <select
                id="off-node"
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#18364A] rounded-lg"
              >
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.id})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="off-cat" className="block text-xs text-slate-300 mb-1">
                  Categoría
                </label>
                <select
                  id="off-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as AnomalyCategory)}
                  className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#18364A] rounded-lg"
                >
                  <option value="leak">Fuga visible</option>
                  <option value="obstruction">Obstrucción</option>
                  <option value="contamination">Turbidez / Calidad</option>
                  <option value="sensor_fault">Falla de equipo</option>
                </select>
              </div>
              <div>
                <label htmlFor="off-rep" className="block text-xs text-slate-300 mb-1">
                  Reportante
                </label>
                <input
                  id="off-rep"
                  type="text"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#18364A] rounded-lg"
                />
              </div>
            </div>

            <div>
              <label htmlFor="off-desc" className="block text-xs text-slate-300 mb-1">
                Observación de campo
              </label>
              <textarea
                id="off-desc"
                rows={3}
                required
                placeholder="Describe fuga visible, olor, turbidez o estado de válvula..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#06131C] text-white border border-[#18364A] rounded-lg focus:outline-none focus:border-cyan-400"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="text-xs text-cyan-300 hover:text-cyan-200 cursor-pointer">
                {photoDataUrl ? '✓ Fotografía adjunta' : '+ Adjuntar foto opcional'}
                <input type="file" accept="image/*" onChange={handlePhotoSelect} className="sr-only" />
              </label>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-[#0F2736] hover:bg-[#17394F] text-cyan-200 border border-cyan-500/40 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <Database className="w-3.5 h-3.5" />
                {saving ? 'Guardando...' : 'Guardar en IndexedDB'}
              </button>
            </div>
          </form>

          {/* Local IndexedDB Queue */}
          <div className="lg:col-span-7 space-y-2.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Registros almacenados en IndexedDB ({offlineReports.length})</span>
              <span className="font-mono">Base local: aqua-sentinel-db</span>
            </div>

            {offlineReports.length === 0 ? (
              <div className="p-8 text-center border border-dashed border-[#18364A] rounded-lg text-xs text-slate-400">
                No hay reportes locales en IndexedDB. Activa "Modo Sin Conexión" y crea un reporte
                para probar la cola resiliente.
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {offlineReports.map((rep) => (
                  <div
                    key={rep.id}
                    className="p-3 rounded-lg bg-[#06131C] border border-[#18364A] text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono">
                      <span className="text-cyan-300">
                        {rep.id} · {rep.nodeId}
                      </span>
                      <span
                        className={
                          rep.syncStatus === 'synced'
                            ? 'text-emerald-400'
                            : rep.syncStatus === 'conflict'
                              ? 'text-amber-400'
                              : rep.syncStatus === 'duplicate'
                                ? 'text-sky-400'
                                : 'text-amber-300'
                        }
                      >
                        {rep.syncStatus === 'pending'
                          ? '● Pendiente de sincronización'
                          : rep.syncStatus === 'synced'
                            ? '✓ Sincronizado'
                            : rep.syncStatus === 'conflict'
                              ? '▲ Conflicto resuelto'
                              : '◆ Duplicado omitido'}
                      </span>
                    </div>
                    <p className="text-slate-200">{rep.description}</p>
                    {rep.syncNote && <p className="text-slate-400">{rep.syncNote}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <OperationsHealthPanel onStateChanged={onRefreshState ?? (() => {})} />

      {/* AI Provider & AWS Adapter Transparency + Kiro Spec Explorer */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-cyan-400" />
            <h3 className="text-base font-semibold text-white">
              Proveedores IA y Adaptadores Cloud
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Transparencia estricta: los servicios sin credenciales configuradas operan mediante
            adaptadores locales de demostración y se declaran explícitamente.
          </p>

          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
              <div className="text-slate-400">Capa de Inteligencia Multimodal</div>
              <div className="font-semibold text-cyan-300 mt-0.5">{providerStatus.aiProvider}</div>
            </div>
            {Object.entries(providerStatus.awsAdapters).map(([key, val]) => (
              <div key={key} className="p-3 rounded-lg bg-[#06131C] border border-[#18364A]">
                <div className="text-slate-400 uppercase font-mono">AWS {key} (no es un servicio AWS real)</div>
                <div className="text-slate-200 mt-0.5">{val}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-7 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-cyan-400" />
              <h3 className="text-base font-semibold text-white">
                Especificaciones Kiro (.kiro/)
              </h3>
            </div>
            <span className="text-xs font-mono text-slate-400">
              {kiroFiles.length} artefactos reales en repositorio
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {kiroFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedKiroPath(f.path)}
                className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                  activeKiro?.path === f.path
                    ? 'bg-[#0F2736] border-cyan-400 text-cyan-300'
                    : 'bg-[#06131C] border-[#18364A] text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.path.replace('.kiro/', '')}
              </button>
            ))}
          </div>

          {activeKiro && (
            <pre className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] text-xs font-mono text-slate-300 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {activeKiro.content}
            </pre>
          )}
        </div>
      </section>
    </div>
  );
};

