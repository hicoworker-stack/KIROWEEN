import React from 'react';
import { ArrowRight, LineChart } from 'lucide-react';
import { analyzeNetworkHydraulics } from '../core/graphHydrology';
import { AnomalyEvent, NetworkNode, NodeBaseline, PipeSegment } from '../core/types';
import { AdvancedTab, hasLegacyRestoredReading, HEALTH_META, HealthKey, incidentProvenance, incidentTitle, incidentWhatHappens, nodeHealth, nodeHealthDetail, Provenance, timeAgo } from '../ui/vocab';
import { t } from '../ui/i18n';
import { Button, Disclosure, HEALTH_TONE, MetricRow, ProvenanceRow, Question, StatusPill, TONE } from './ui';
import { NetworkMap } from './NetworkMap';

interface MapViewProps {
  nodes: NetworkNode[];
  pipes: PipeSegment[];
  anomalies: AnomalyEvent[];
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
  onOpenIncident: (id: string) => void;
  onOpenAdvanced: (tab: AdvancedTab) => void;
}

const LEGEND: HealthKey[] = ['stable', 'attention', 'critical', 'verifying'];
const SYMBOL: Record<HealthKey, string> = { stable: '✓', attention: '!', critical: '✕', verifying: '?', offline: '–' };

const readings = (): Array<{ key: keyof NodeBaseline; label: string; unit: string; digits: number; tankOnly?: boolean }> => [
  { key: 'pressureBar', label: t('Presión', 'Pressure'), unit: 'bar', digits: 2 },
  { key: 'flowLs', label: t('Caudal', 'Flow'), unit: 'L/s', digits: 1 },
  { key: 'levelPct', label: t('Nivel del tanque', 'Tank level'), unit: '%', digits: 0, tankOnly: true },
  { key: 'turbidityNtu', label: t('Turbidez', 'Turbidity'), unit: 'NTU', digits: 2 },
  { key: 'chlorineMgL', label: t('Cloro libre', 'Free chlorine'), unit: 'mg/L', digits: 2 },
  { key: 'ph', label: 'pH', unit: '', digits: 1 },
];

export const MapView: React.FC<MapViewProps> = ({ nodes, pipes, anomalies, selectedNodeId, onSelectNode, onOpenIncident, onOpenAdvanced }) => {
  const node = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];
  if (!node) return null;
  const health = nodeHealth(node);
  const incident = anomalies.filter((a) => a.nodeId === node.id && a.status === 'active')[0] ?? null;
  const risk = analyzeNetworkHydraulics(nodes, pipes, anomalies).propagatedByNode[node.id];
  const restored = hasLegacyRestoredReading(node);
  const awaiting = Boolean(node.pendingVerification) && !restored;
  const provenance: Provenance[] = restored ? [] : node.current.synthetic ? ['medido', 'simulado'] : ['medido'];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">{t('Mapa de la red', 'Network map')}</h1>
        <p className="text-base text-soft">{t('Toca un punto para ver cómo está. Los puntos marcados con un anillo punteado tienen un incidente o están en riesgo aguas abajo.', 'Tap a point to see how it is doing. Points with a dotted ring have an incident or are at risk downstream.')}</p>
      </header>

      <NetworkMap nodes={nodes} pipes={pipes} anomalies={anomalies} selectedNodeId={node.id} onSelectNode={onSelectNode} />

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-soft" aria-label={t('Significado de los símbolos', 'Meaning of the symbols')}>
        {LEGEND.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full border-2 text-[11px] font-bold ${TONE[HEALTH_TONE[k]].border} ${TONE[HEALTH_TONE[k]].text}`}>
              {SYMBOL[k]}
            </span>
            {HEALTH_META[k].label}
          </li>
        ))}
        <li className="flex items-center gap-2 text-quiet">
          <span aria-hidden="true" className="h-0 w-6 border-t-2 border-dashed border-attention" /> {t('Zona en riesgo aguas abajo', 'Zone at risk downstream')}
        </li>
      </ul>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <section aria-labelledby="node-title" className="space-y-6">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="node-title" className="font-display text-xl font-semibold text-ink">
                {node.name}
              </h2>
              <StatusPill tone={HEALTH_TONE[health]} label={HEALTH_META[health].label} />
            </div>
            <p className="text-sm text-quiet">
              {node.sector} · {t('abastece hasta', 'serves up to')} {node.populationServed.toLocaleString(t('es-ES', 'en-US'))} {t('personas · lectura', 'people · reading')} {timeAgo(node.current.timestamp)}
            </p>
          </div>

          <Question q={t('Qué pasa aquí', 'What is happening here')} id="q-node-now">
            {incident ? (
              <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
                  {incidentTitle(incident)} <ProvenanceRow kinds={incidentProvenance(incident)} />
                </p>
                <p className="text-sm leading-relaxed text-soft">{incidentWhatHappens(incident)}</p>
                <Button variant="primary" onClick={() => onOpenIncident(incident.id)} icon={<ArrowRight className="h-4 w-4" />}>
                  {t('Ver incidente y qué hacer', 'See the incident and what to do')}
                </Button>
              </div>
            ) : risk ? (
              <p className="text-base leading-relaxed text-attention">{risk.reason}</p>
            ) : (
              <p className="text-base text-soft">{nodeHealthDetail(node)}</p>
            )}
          </Question>

          <Question q={t('Lecturas ahora', 'Readings now')} id="q-node-readings">
            {restored && (
              <p className="rounded-lg border border-verifying/40 bg-verifying/10 px-3 py-2 text-sm text-soft">
                {t('Estas cifras no son una medición: son los valores normales que una versión anterior del sistema escribió al cerrar la orden. Aún no hay mediciones reales posteriores.', 'These figures are not a measurement: they are the normal values an earlier version of the system wrote when closing the order. There are no later real measurements yet.')}
              </p>
            )}
            {awaiting && (
              <p className="rounded-lg border border-verifying/40 bg-verifying/10 px-3 py-2 text-sm text-soft">
                {t(`Se cerró la orden ${node.pendingVerification!.workOrderId}. Estas son las últimas mediciones de antes del cierre: la recuperación se confirmará con las mediciones posteriores.`, `Order ${node.pendingVerification!.workOrderId} was closed. These are the last measurements from before the closing: recovery will be confirmed by later measurements.`)}
              </p>
            )}
            <div>
              {readings().filter((r) => !r.tankOnly || node.baseline.levelPct > 0).map((r) => {
                const value = node.current[r.key];
                const normal = node.baseline[r.key];
                const off = normal !== 0 && Math.abs(value - normal) / Math.abs(normal) > 0.25;
                return (
                  <MetricRow
                    key={r.key}
                    label={r.label}
                    value={`${value.toFixed(r.digits)}${r.unit ? ' ' + r.unit : ''}`}
                    context={t(`Lo normal aquí: ${normal.toFixed(r.digits)}${r.unit ? ' ' + r.unit : ''}`, `Normal here: ${normal.toFixed(r.digits)}${r.unit ? ' ' + r.unit : ''}`)}
                    provenance={provenance}
                    tone={off && !restored ? 'attention' : 'neutral'}
                  />
                );
              })}
            </div>
          </Question>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => onOpenAdvanced('sensores')} icon={<LineChart className="h-4 w-4" />}>
              {t('Ver el historial de lecturas', 'See the readings history')}
            </Button>
          </div>

          <Disclosure summary={t('Datos técnicos del punto', 'Technical data of the point')}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <dt className="text-quiet">{t('Código', 'Code')}</dt>
              <dd className="text-ink">{node.assetCode}</dd>
              <dt className="text-quiet">{t('Material', 'Material')}</dt>
              <dd className="text-ink">{node.material}</dd>
              <dt className="text-quiet">{t('Diámetro', 'Diameter')}</dt>
              <dd className="text-ink">{node.diameterMm} mm</dd>
              <dt className="text-quiet">{t('Altitud', 'Elevation')}</dt>
              <dd className="text-ink">{node.elevationM} m</dd>
            </dl>
          </Disclosure>
        </section>

        <nav aria-label={t('Lugares de la red', 'Network places')} className="lg:border-l lg:border-line lg:pl-6">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-quiet">{t('Todos los lugares', 'All places')}</h2>
          <ul>
            {nodes.map((n) => {
              const h = nodeHealth(n);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    aria-current={n.id === node.id ? 'true' : undefined}
                    onClick={() => onSelectNode(n.id)}
                    className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 border-b border-line/70 px-1 py-2 text-left hover:bg-raised/60 ${n.id === node.id ? 'text-accent' : 'text-ink'}`}
                  >
                    <span className="truncate text-sm">{n.name}</span>
                    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE[HEALTH_TONE[h]].dot}`} />
                    <span className="sr-only">{HEALTH_META[h].label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
};
