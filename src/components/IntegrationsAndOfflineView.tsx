import React, { useEffect, useState } from 'react';
import { Cloud, FileCode2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { apiFetch } from '../client/api';
import { can, Role } from '../core/permissions';
import { OfflineReportRecord } from '../core/types';
import { OperationsHealthPanel } from './OperationsHealthPanel';
import { Button, EmptyState, ProvenanceBadge, StatusPill } from './ui';

interface IntegrationsAndOfflineViewProps {
  role: Role;
  isOfflineMode: boolean;
  isSimulatedOffline: boolean;
  browserOnline: boolean;
  onToggleOfflineMode: () => void;
  offlineReports: OfflineReportRecord[];
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

const SYNC_LABEL: Record<OfflineReportRecord['syncStatus'], { text: string; className: string }> = {
  pending: { text: 'Pendiente de enviar', className: 'text-attention' },
  synced: { text: 'Enviado', className: 'text-ok' },
  conflict: { text: 'Enviado con conflicto: requiere revisión', className: 'text-attention' },
  duplicate: { text: 'Ya existía: se omitió', className: 'text-soft' },
};

/**
 * Conectividad, reportes guardados en este dispositivo e integraciones. El formulario para crear un reporte
 * vive ahora en «Reportar un problema» (disponible desde Inicio e Incidentes).
 */
export const IntegrationsAndOfflineView: React.FC<IntegrationsAndOfflineViewProps> = ({
  role,
  isOfflineMode,
  isSimulatedOffline,
  browserOnline,
  onToggleOfflineMode,
  offlineReports,
  onSyncOfflineReports,
  providerStatus,
  onRefreshState,
}) => {
  const [syncing, setSyncing] = useState(false);
  const [kiroFiles, setKiroFiles] = useState<KiroFileItem[]>([]);
  const [selectedKiroPath, setSelectedKiroPath] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/kiro/files')
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
  const maySync = can(role, 'offline:sync');
  const activeKiro = kiroFiles.find((f) => f.path === selectedKiroPath) ?? kiroFiles[0] ?? null;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSyncOfflineReports();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-10">
      <section aria-labelledby="conn-title" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="conn-title" className="font-display text-lg font-semibold text-ink">
              Conexión y reportes guardados
            </h2>
            <p className="text-sm text-soft">Los reportes de campo se guardan en este dispositivo y se envían cuando hay conexión.</p>
          </div>
          <StatusPill tone={browserOnline && !isSimulatedOffline ? 'ok' : 'offline'} label={!browserOnline ? 'Sin conexión de red' : isSimulatedOffline ? 'Sin conexión (simulada)' : 'Conectado'} />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="primary" busy={syncing} disabled={isOfflineMode || pendingCount === 0 || !maySync} onClick={handleSync} icon={<RefreshCw className="h-4 w-4" />}>
            Enviar {pendingCount > 0 ? `${pendingCount} ` : ''}
            {pendingCount === 1 ? 'reporte' : 'reportes'}
          </Button>
          <Button variant="secondary" onClick={onToggleOfflineMode} icon={isSimulatedOffline ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />} title="Simula la pérdida de conexión para probar el modo sin conexión">
            {isSimulatedOffline ? 'Terminar la simulación sin conexión' : 'Simular que no hay conexión'}
          </Button>
        </div>
        {!maySync && <p className="text-sm text-quiet">Tu rol solo permite consultar: enviar reportes requiere ser operador.</p>}

        {offlineReports.length === 0 ? (
          <EmptyState icon={<Cloud className="h-8 w-8" />} title="No hay reportes guardados en este dispositivo">
            Usa «Reportar un problema» en Inicio o Incidentes.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {offlineReports.map((rep) => {
              const s = SYNC_LABEL[rep.syncStatus];
              return (
                <li key={rep.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      {rep.nodeId} <ProvenanceBadge kind="declarado" />
                    </span>
                    <span className={`text-sm font-medium ${s.className}`}>{s.text}</span>
                  </div>
                  <p className="text-base text-ink">{rep.description}</p>
                  {rep.syncNote && <p className="text-sm text-quiet">{rep.syncNote}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {can(role, 'health:detail') && <OperationsHealthPanel onStateChanged={onRefreshState ?? (() => {})} isAdmin={can(role, 'ai:probe')} />}

      {/* Transparencia de proveedores IA y adaptadores cloud + explorador de especificaciones Kiro */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 rounded-xl border border-line bg-surface p-5 lg:col-span-5">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-accent" />
            <h3 className="text-base font-semibold text-ink">Proveedores de IA y adaptadores cloud</h3>
          </div>
          <p className="text-sm leading-relaxed text-soft">Los servicios sin credenciales configuradas operan con adaptadores locales de demostración y se declaran como tales.</p>
          <div className="space-y-2.5 text-sm">
            <div className="rounded-lg border border-line bg-canvas p-3">
              <div className="text-quiet">Capa de inteligencia multimodal</div>
              <div className="mt-0.5 font-semibold text-accent">{providerStatus.aiProvider}</div>
            </div>
            {Object.entries(providerStatus.awsAdapters).map(([key, val]) => (
              <div key={key} className="rounded-lg border border-line bg-canvas p-3">
                <div className="font-mono text-xs uppercase text-quiet">AWS {key} (no es un servicio AWS real)</div>
                <div className="mt-0.5 text-ink">{val}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-4 rounded-xl border border-line bg-surface p-5 lg:col-span-7">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-accent" />
              <h3 className="text-base font-semibold text-ink">Especificaciones Kiro (.kiro/)</h3>
            </div>
            <span className="font-mono text-xs text-quiet">{kiroFiles.length} artefactos en el repositorio</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {kiroFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedKiroPath(f.path)}
                className={`min-h-11 cursor-pointer whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${activeKiro?.path === f.path ? 'border-accent bg-raised text-accent' : 'border-line bg-canvas text-quiet hover:text-ink'}`}
              >
                {f.path.replace('.kiro/', '')}
              </button>
            ))}
          </div>
          {activeKiro && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-4 font-mono text-xs leading-relaxed text-soft">{activeKiro.content}</pre>}
        </div>
      </section>
    </div>
  );
};
