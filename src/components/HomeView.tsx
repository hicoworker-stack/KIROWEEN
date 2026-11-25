import React from 'react';
import { ArrowRight, ClipboardList, FilePlus2, Map as MapIcon, Play, RefreshCw } from 'lucide-react';
import { can, Role } from '../core/permissions';
import { AnomalyEvent, AquaBrainDiagnosis, NetworkNode, SmartWorkOrder, TelemetryReading, TrustLedgerEntry } from '../core/types';
import { t } from '../ui/i18n';
import { HEALTH_META, MainView, networkSummary, nextActions, nodeHealth, timeAgo } from '../ui/vocab';
import { IntroSection } from './IntroSection';
import { Button, HEALTH_TONE, Notice, ProvenanceBadge, Skeleton, StatusPill, TONE, toneIcon } from './ui';

export interface HomeViewProps {
  nodes: NetworkNode[];
  anomalies: AnomalyEvent[];
  diagnoses: AquaBrainDiagnosis[];
  workOrders: SmartWorkOrder[];
  seriesByNode: Record<string, TelemetryReading[]>;
  ledger?: TrustLedgerEntry[];
  pendingReports: number;
  online: boolean;
  syncing: boolean;
  loading: boolean;
  loadError: string | null;
  lastUpdatedAt: number | null;
  role: Role;
  onOpenIncident: (id: string) => void;
  onOpenOrder: (id: string) => void;
  onSyncReports: () => void;
  onNavigate: (view: MainView) => void;
  onReport: () => void;
  onRetry: () => void;
  onStartDemo?: () => void;
}

const Stat: React.FC<{ value: number; label: string; onClick: () => void; tone?: 'attention' | 'critical' }> = ({ value, label, onClick, tone }) => (
  <button type="button" onClick={onClick} className="min-h-11 flex-1 cursor-pointer px-4 py-3 text-left transition-colors hover:bg-raised/60 focus-visible:z-10">
    <span className={`block font-display text-3xl font-semibold tabular-nums ${value > 0 && tone ? TONE[tone].text : 'text-ink'}`}>{value}</span>
    <span className="mt-0.5 block text-sm text-soft">{label}</span>
  </button>
);

export const HomeView: React.FC<HomeViewProps> = (p) => {
  const now = Date.now();
  if (p.loading) {
    return (
      <div className="space-y-8" aria-busy="true" aria-label={t('Cargando el estado de la red', 'Loading the network status')}>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const summary = networkSummary({ nodes: p.nodes, anomalies: p.anomalies, diagnoses: p.diagnoses, orders: p.workOrders, pendingReports: p.pendingReports });
  const actions = nextActions({ anomalies: p.anomalies, diagnoses: p.diagnoses, orders: p.workOrders, nodes: p.nodes, seriesByNode: p.seriesByNode, ledger: p.ledger, pendingReports: p.pendingReports, online: p.online });
  const tone = HEALTH_TONE[summary.status];
  const Icon = toneIcon(tone);
  const canReport = can(p.role, 'offline:sync');
  // Inicio abre con la presentación del producto (landing); el estado operativo de la red va debajo.
  const visitor = p.role === 'VISITOR';
  const Headline = 'h2';
  const noAct = visitor ? t('Estás en el modo público: puedes consultarlo, no actuar.', 'You are in public mode: you can view it, not act on it.') : t('Con tu rol puedes consultarlo, pero no actuar.', 'With your role you can view it, but not act on it.');

  return (
    <div className="space-y-10">
      <IntroSection onNavigate={p.onNavigate} />
      <h2 className="border-t border-line pt-10 font-display text-xl font-semibold text-ink">{t('Estado de la red ahora', 'Network status now')}</h2>
      {p.loadError && (
        <Notice tone="attention" title={t('No se pudo actualizar', 'Could not update')} live="assertive">
          {t('Estás viendo los últimos datos recibidos', 'You are seeing the last data received')} ({timeAgo(p.lastUpdatedAt, now)}). {p.loadError}{' '}
          <button type="button" onClick={p.onRetry} className="cursor-pointer font-semibold text-accent underline">
            {t('Reintentar', 'Retry')}
          </button>
        </Notice>
      )}

      {/* ¿Qué está pasando? */}
      <section aria-labelledby="home-status" className="flex items-start gap-4">
        <span className={`mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border ${TONE[tone].bg} ${TONE[tone].border}`}>
          <Icon className={`h-6 w-6 ${TONE[tone].text}`} aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-2">
          <p className={`text-sm font-semibold ${TONE[tone].text}`}>{HEALTH_META[summary.status].label}</p>
          <Headline id="home-status" className="font-display text-2xl font-semibold leading-tight text-ink sm:text-3xl">
            {summary.headline}
          </Headline>
          <p className="max-w-2xl text-base leading-relaxed text-soft">{summary.detail}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-quiet">
            {t('Red San Cristóbal de las Aguas · última lectura', 'San Cristóbal de las Aguas network · last reading')} {timeAgo(summary.lastReadingAt, now)}
            {summary.allSynthetic && (
              <>
                <ProvenanceBadge kind="simulado" />
                <span>{t('Todas las lecturas son de demostración, no de campo.', 'All readings are demonstration data, not field data.')}</span>
              </>
            )}
          </p>
        </div>
      </section>

      {/* Tres cifras con contexto, sin tarjetas */}
      <section aria-label={t('Resumen', 'Summary')} className="flex divide-x divide-line overflow-hidden rounded-xl border border-line bg-surface">
        <Stat value={summary.counts.activeIncidents} label={summary.counts.activeIncidents === 1 ? t('incidente activo', 'active incident') : t('incidentes activos', 'active incidents')} tone={summary.counts.criticalIncidents > 0 ? 'critical' : 'attention'} onClick={() => p.onNavigate('incidents')} />
        <Stat value={summary.counts.openOrders} label={summary.counts.openOrders === 1 ? t('orden de trabajo abierta', 'open work order') : t('órdenes de trabajo abiertas', 'open work orders')} onClick={() => p.onNavigate('orders')} />
        <Stat value={summary.counts.pendingReports} label={summary.counts.pendingReports === 1 ? t('reporte por enviar', 'report to send') : t('reportes por enviar', 'reports to send')} tone="attention" onClick={() => p.onNavigate('orders')} />
      </section>

      {/* ¿Qué debo hacer? */}
      <section aria-labelledby="home-todo" className="space-y-3">
        <h2 id="home-todo" className="font-display text-lg font-semibold text-ink">
          {t('Qué hacer ahora', 'What to do now')}
        </h2>
        {actions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center">
            <p className="text-base font-medium text-ink">{t('No hay nada pendiente.', 'Nothing is pending.')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-soft">{t('Cuando el sistema detecte algo fuera de lo normal, aparecerá aquí con la acción que corresponde.', 'When the system detects something out of range, it will appear here with the right action.')}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              {canReport && (
                <Button variant="secondary" icon={<FilePlus2 className="h-4 w-4" />} onClick={p.onReport}>
                  {t('Reportar un problema visto en campo', 'Report a problem seen in the field')}
                </Button>
              )}
              {p.onStartDemo && (
                <Button variant="ghost" icon={<Play className="h-4 w-4" />} onClick={p.onStartDemo}>
                  {t('Ver una demostración', 'See a demonstration')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {actions.map((a) => {
              const AIcon = toneIcon(a.tone);
              const allowed = !a.needs || can(p.role, a.needs);
              const onClick = () => (a.target.kind === 'incident' ? p.onOpenIncident(a.target.id) : a.target.kind === 'order' ? p.onOpenOrder(a.target.id) : p.onSyncReports());
              const isSync = a.target.kind === 'sync';
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap">
                  <AIcon className={`h-5 w-5 shrink-0 ${TONE[a.tone].text}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium text-ink">{a.title}</p>
                    <p className="text-sm text-soft">{a.detail}</p>
                    {!allowed && !isSync && <p className="mt-1 text-xs text-quiet">{noAct}</p>}
                  </div>
                  {isSync ? (
                    allowed ? (
                      <Button variant="primary" onClick={onClick} disabled={!p.online} busy={p.syncing} icon={<RefreshCw className="h-4 w-4" />}>
                        {a.cta}
                      </Button>
                    ) : (
                      <span className="text-xs text-quiet">{visitor ? t('Solo para usuarios con sesión', 'Only for signed-in users') : t('Solo operadores pueden enviarlos', 'Only operators can send them')}</span>
                    )
                  ) : (
                    <Button variant={allowed && a.tone === 'critical' ? 'primary' : 'secondary'} onClick={onClick} icon={<ArrowRight className="h-4 w-4" />}>
                      {allowed ? a.cta : t('Ver', 'View')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Zonas de la red, para orientarse de un vistazo */}
      <section aria-labelledby="home-zones" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="home-zones" className="font-display text-lg font-semibold text-ink">
            {t('Estado por zona', 'Status by zone')}
          </h2>
          <Button variant="ghost" onClick={() => p.onNavigate('map')} icon={<MapIcon className="h-4 w-4" />}>
            {t('Abrir el mapa', 'Open the map')}
          </Button>
        </div>
        <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {p.nodes.map((n) => {
            const h = nodeHealth(n);
            return (
              <li key={n.id} className="flex items-center justify-between gap-3 border-b border-line/70 py-3">
                <span className="min-w-0 truncate text-base text-ink">{n.name}</span>
                <StatusPill tone={HEALTH_TONE[h]} label={HEALTH_META[h].label} title={HEALTH_META[h].help} />
              </li>
            );
          })}
        </ul>
      </section>

      {summary.counts.verifying > 0 && (
        <Notice tone="verifying" title={t('Pendiente de verificación', 'Pending verification')}>
          {summary.counts.verifying === 1 ? t('Una zona tiene', 'One zone has') : t(`${summary.counts.verifying} zonas tienen`, `${summary.counts.verifying} zones have`)} {t('una orden cerrada pero aún no recibió mediciones posteriores que demuestren la reparación. No se muestra como recuperada: revisa la orden.', 'a closed order but no later measurements that prove the repair yet. It is not shown as recovered: check the order.')}
        </Notice>
      )}

      {summary.counts.activeIncidents === 0 && summary.counts.openOrders === 0 && !canReport && (
        <p className="flex items-center gap-2 text-sm text-quiet">
          <ClipboardList className="h-4 w-4" aria-hidden="true" /> {t('Tu rol es de consulta: puedes revisar el estado de la red pero no modificarlo.', 'Your role is view-only: you can review the network status but not change it.')}
        </p>
      )}

    </div>
  );
};
