import { Permission, Role, ROLE_LABEL } from '../core/permissions';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  PriorityLevel,
  SmartWorkOrder,
  TelemetryReading,
  TrustLedgerEntry,
} from '../core/types';
import { live, plural, t } from './i18n';
import { repairView } from './repairView';

/**
 * REQ-UX-01..05: vocabulario y reglas de presentación de la interfaz, en lenguaje claro y SIN lógica de negocio nueva.
 * Todo se deriva de datos que el servidor ya entrega. Cuando el servidor afirma algo que la interfaz sabe que no es
 * cierto (p. ej. un reporte declarado contado como "sensores", o un nodo "nominal" sin mediciones tras un cierre),
 * la interfaz lo muestra tal como es, no lo oculta.
 */

// ───────────── Estados ─────────────

export type HealthKey = 'stable' | 'attention' | 'critical' | 'verifying' | 'offline';
export type Tone = 'ok' | 'attention' | 'critical' | 'verifying' | 'offline' | 'neutral';

export const HEALTH_META: Record<HealthKey, { label: string; tone: Tone; help: string }> = live(() => ({
  stable: { label: t('Estable', 'Stable'), tone: 'ok' as Tone, help: t('Las lecturas están dentro de lo normal.', 'Readings are within the normal range.') },
  attention: { label: t('Requiere atención', 'Needs attention'), tone: 'attention' as Tone, help: t('Hay algo fuera de lo normal que conviene revisar.', 'Something is out of range and worth checking.') },
  critical: { label: t('Crítico', 'Critical'), tone: 'critical' as Tone, help: t('Hay un problema que debe atenderse cuanto antes.', 'There is a problem that needs attention as soon as possible.') },
  verifying: { label: t('Pendiente de verificación', 'Pending verification'), tone: 'verifying' as Tone, help: t('Se cerró una intervención, pero aún no hay mediciones reales que confirmen la recuperación.', 'An intervention was closed, but there are no later measurements yet to confirm recovery.') },
  offline: { label: t('Sin conexión', 'Offline'), tone: 'offline' as Tone, help: t('No hay conexión con el servidor. Lo que registres se guarda en este dispositivo.', 'There is no connection to the server. What you record is saved on this device.') },
}));

/** El punto lleva una lectura "restaurada" escrita al cerrar una orden por una versión anterior del servidor (no es una medición). */
export const hasLegacyRestoredReading = (node: Pick<NetworkNode, 'current'>) => node.current.source === 'restored';

/**
 * El nodo está "pendiente de verificación" si se cerró una orden y aún no llegó ninguna medición posterior (F2 corregido:
 * el servidor lo marca con `pendingVerification`). Los estados guardados antes de la corrección traen en su lugar una
 * lectura "restaurada", que tampoco es una medición.
 */
export function nodeHealth(node: NetworkNode): HealthKey {
  if (node.pendingVerification || hasLegacyRestoredReading(node)) return 'verifying';
  if (node.status === 'critical') return 'critical';
  if (node.status === 'warning' || node.status === 'fault') return 'attention';
  return 'stable';
}

export const nodeHealthDetail = (node: NetworkNode): string =>
  node.status === 'fault' && nodeHealth(node) !== 'verifying' ? t('El sensor no da lecturas confiables.', 'The sensor is not giving reliable readings.') : HEALTH_META[nodeHealth(node)].help;

export function urgency(priority: PriorityLevel): { label: string; tone: Tone } {
  switch (priority) {
    case 'Crítica':
      return { label: t('Urgente', 'Urgent'), tone: 'critical' };
    case 'Alta':
      return { label: t('Importante', 'Important'), tone: 'attention' };
    case 'Media':
      return { label: t('Normal', 'Normal'), tone: 'attention' };
    default:
      return { label: t('Bajo', 'Low'), tone: 'neutral' };
  }
}

const URGENCY_RANK: Record<PriorityLevel, number> = { Crítica: 0, Alta: 1, Media: 2, Baja: 3 };
export const byUrgency = (a: AnomalyEvent, b: AnomalyEvent) =>
  URGENCY_RANK[a.priority.priority] - URGENCY_RANK[b.priority.priority] || b.priority.totalScore - a.priority.totalScore || b.timestamp.localeCompare(a.timestamp);

// ───────────── Procedencia de cada dato ─────────────

export type Provenance = 'medido' | 'declarado' | 'inferido' | 'hipotesis_ia' | 'simulado';

export const PROVENANCE_META: Record<Provenance, { label: string; help: string }> = live(() => ({
  medido: { label: t('MEDIDO', 'MEASURED'), help: t('Lectura de un sensor.', 'A sensor reading.') },
  declarado: { label: t('DECLARADO', 'DECLARED'), help: t('Lo reportó una persona. No está verificado por ningún sensor.', 'Reported by a person. No sensor has verified it.') },
  inferido: { label: t('INFERIDO', 'INFERRED'), help: t('Resultado de reglas y cálculos del sistema sobre las lecturas. Sin inteligencia artificial.', 'Result of the system’s rules and calculations over the readings. No artificial intelligence.') },
  hipotesis_ia: { label: t('HIPÓTESIS IA', 'AI HYPOTHESIS'), help: t('Interpretación generada por inteligencia artificial. Es una hipótesis, no un hecho confirmado.', 'An interpretation generated by artificial intelligence. It is a hypothesis, not a confirmed fact.') },
  simulado: { label: t('SIMULADO', 'SIMULATED'), help: t('Dato sintético de demostración. No proviene de la red real.', 'Synthetic demonstration data. It does not come from a real network.') },
}));

/** De dónde sale un incidente. */
export function incidentProvenance(a: AnomalyEvent): Provenance[] {
  const declared = a.origin === 'offline-report';
  const out: Provenance[] = declared ? ['declarado'] : ['inferido'];
  // Un reporte de una persona no es un dato simulado aunque el nodo muestre lecturas sintéticas.
  if (a.synthetic || (!declared && a.telemetrySnapshot?.synthetic)) out.push('simulado');
  return out;
}

/** El texto de un diagnóstico es una hipótesis de IA solo si lo generó un modelo; el texto de respaldo sale de plantillas deterministas. */
export const diagnosisProvenance = (d: Pick<AquaBrainDiagnosis, 'providerMode'>): Provenance => (d.providerMode === 'gemini-live' ? 'hipotesis_ia' : 'inferido');

export const isSyntheticNode = (n: NetworkNode) => Boolean(n.current.synthetic);

/**
 * Canales de respaldo que se muestran al usuario. El servidor ya cuenta un reporte de campo como canal "reporte" (F1 corregido).
 * Los diagnósticos guardados antes de la corrección pueden traer "sensores" en un reporte declarado: se siguen mostrando
 * como "Reporte de campo (declarado)" y con un aviso, nunca como lecturas de sensores.
 */
export function evidenceBasisLabels(anomaly: Pick<AnomalyEvent, 'origin'>, diagnosis: Pick<AquaBrainDiagnosis, 'evidenceBasis'> | null): { labels: string[]; warning?: string } {
  const declared = anomaly.origin === 'offline-report';
  const map: Record<string, string> = { sensores: t('Lecturas de sensores', 'Sensor readings'), reporte: t('Reporte de campo (declarado)', 'Field report (declared)'), hidráulica: t('Balance hidráulico', 'Hydraulic balance'), fotografía: t('Fotografía analizada', 'Analyzed photo') };
  const basis = diagnosis?.evidenceBasis ?? [];
  const labels = basis.filter((b) => !(declared && (b === 'sensores' || b === 'reporte'))).map((b) => map[b] ?? b);
  if (declared) labels.unshift(map.reporte);
  return {
    labels,
    warning: declared && basis.includes('sensores')
      ? t('Este diagnóstico se guardó antes de una corrección y contaba el reporte como respaldo de «sensores». Lo escribió una persona y ningún sensor lo confirma: se muestra como declarado.', 'This diagnosis was saved before a fix and counted the report as «sensors» support. A person wrote it and no sensor confirms it, so it is shown as declared.')
      : undefined,
  };
}

/** Nombre claro de cada canal de concordancia para el usuario. */
export function channelLabel(anomaly: Pick<AnomalyEvent, 'origin'>, channel: string): string {
  if (channel === 'reporte') return t('Reporte de campo (declarado)', 'Field report (declared)');
  if (channel === 'sensores') return anomaly.origin === 'offline-report' ? t('Reporte de campo (declarado)', 'Field report (declared)') : t('Lecturas de sensores', 'Sensor readings');
  if (channel === 'hidráulica') return t('Balance hidráulico', 'Hydraulic balance');
  if (channel === 'fotografía') return t('Fotografía', 'Photo');
  return channel;
}

export function channelProvenance(anomaly: Pick<AnomalyEvent, 'origin' | 'synthetic'>, channel: string, visionIsAi: boolean): Provenance[] {
  if (channel === 'reporte') return ['declarado'];
  if (channel === 'sensores') return anomaly.origin === 'offline-report' ? ['declarado'] : anomaly.synthetic ? ['medido', 'simulado'] : ['medido'];
  if (channel === 'hidráulica') return anomaly.synthetic ? ['inferido', 'simulado'] : ['inferido'];
  return visionIsAi ? ['hipotesis_ia'] : [];
}

// ───────────── Incidentes en lenguaje claro ─────────────

const categoryPlain = (c: AnomalyEvent['category']): string =>
  ({
    leak: t('fuga de agua', 'water leak'),
    obstruction: t('obstrucción', 'obstruction'),
    contamination: t('problema de calidad del agua', 'water quality problem'),
    quality_drift: t('cambio en la calidad del agua', 'change in water quality'),
    sensor_fault: t('falla de un sensor', 'sensor fault'),
    nominal: t('sin anomalía', 'no anomaly'),
  })[c];

export function incidentTitle(a: AnomalyEvent): string {
  const where = a.nodeName;
  if (a.origin === 'offline-report') return t(`Reporte de campo: ${categoryPlain(a.category)} en ${where}`, `Field report: ${categoryPlain(a.category)} at ${where}`);
  if (a.origin === 'network-balance') return a.hydraulicLevel === 'localized_leak' ? t(`Fuga probable cerca de ${where}`, `Likely leak near ${where}`) : t(`Posible fuga cerca de ${where}`, `Possible leak near ${where}`);
  switch (a.category) {
    case 'leak':
      return t(`Posible fuga en ${where}`, `Possible leak at ${where}`);
    case 'obstruction':
      return t(`Posible obstrucción en ${where}`, `Possible obstruction at ${where}`);
    case 'contamination':
      return t(`Calidad del agua fuera de rango en ${where}`, `Water quality out of range at ${where}`);
    case 'quality_drift':
      return t(`El agua en ${where} se aleja de lo normal`, `Water at ${where} is drifting away from normal`);
    case 'sensor_fault':
      return t(`El sensor de ${where} no es confiable`, `The sensor at ${where} is not reliable`);
    default:
      return t(`Incidente en ${where}`, `Incident at ${where}`);
  }
}

const metricPlain = (): Record<string, { label: string; unit: string }> => ({
  pressureBar: { label: t('La presión', 'Pressure'), unit: 'bar' },
  flowLs: { label: t('El caudal', 'Flow'), unit: 'L/s' },
  turbidityNtu: { label: t('La turbidez', 'Turbidity'), unit: 'NTU' },
  chlorineMgL: { label: t('El cloro', 'Chlorine'), unit: 'mg/L' },
  ph: { label: t('El pH', 'pH'), unit: '' },
  levelPct: { label: t('El nivel del tanque', 'Tank level'), unit: '%' },
});

const num = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Number(n.toFixed(2)).toString());

/** Qué está pasando, con cifras y su referencia ("normal"). */
export function incidentWhatHappens(a: AnomalyEvent): string {
  const first = a.rulesTriggered[0];
  if (a.origin === 'offline-report') {
    const quoted = first?.explanation.match(/"([^"]{1,200})"/)?.[1];
    return t(`Una persona reportó en campo${quoted ? `: «${quoted}»` : ' un problema'}. Ningún sensor lo ha confirmado todavía.`, `A person reported in the field${quoted ? `: “${quoted}”` : ' a problem'}. No sensor has confirmed it yet.`);
  }
  if (a.origin === 'network-balance' && first) {
    return t(`Entra más agua a la red de la que se consume: unos ${num(first.observedValue)} L/s de diferencia. Es una estimación a partir de los medidores, no una medición directa de la fuga.`, `More water enters the network than is consumed: about ${num(first.observedValue)} L/s of difference. It is an estimate from the meters, not a direct measurement of the leak.`);
  }
  const parts = a.rulesTriggered
    .filter((r) => metricPlain()[r.metric] && Number.isFinite(r.deltaPct) && r.metric !== 'fieldReport')
    .slice(0, 2)
    .map((r) => {
      const m = metricPlain()[r.metric];
      const obs = `${num(r.observedValue)}${m.unit ? ' ' + m.unit : ''}`;
      const base = `${num(r.baselineValue)}${m.unit ? ' ' + m.unit : ''}`;
      const pct = num(Math.abs(r.deltaPct));
      return t(`${m.label} está ${pct}% ${r.deltaPct < 0 ? 'por debajo' : 'por encima'} de lo normal (${obs} frente a ${base})`, `${m.label} is ${pct}% ${r.deltaPct < 0 ? 'below' : 'above'} normal (${obs} vs ${base})`);
    });
  return parts.length ? `${parts.join('. ')}.` : t('El sistema detectó lecturas fuera de lo normal en este punto.', 'The system detected readings out of range at this point.');
}

export const HYDRAULIC_PLAIN: Record<string, string> = live(() => ({
  insufficient_data: t('Todavía no hay datos suficientes para evaluar el balance de agua.', 'There is not enough data yet to assess the water balance.'),
  no_anomaly: t('El balance de agua no muestra diferencias importantes.', 'The water balance shows no significant difference.'),
  flow_anomaly: t('Hay una diferencia de caudal, pero la presión no la confirma. Puede ser un medidor desajustado o más consumo de lo habitual.', 'There is a flow difference, but pressure does not confirm it. It may be a drifting meter or higher-than-usual consumption.'),
  possible_leak: t('El balance de agua y la presión sugieren una posible fuga.', 'The water balance and pressure suggest a possible leak.'),
  localized_leak: t('El balance de agua y la presión apuntan a una fuga en un tramo concreto entre dos medidores.', 'The water balance and pressure point to a leak in a specific reach between two meters.'),
}));

export const EVIDENCE_LEVEL_PLAIN: Record<string, { label: string; help: string }> = live(() => ({
  baja: { label: t('Bajo', 'Low'), help: t('Solo las lecturas de sensores respaldan la conclusión.', 'Only sensor readings support the conclusion.') },
  media: { label: t('Medio', 'Medium'), help: t('Un segundo tipo de evidencia coincide con las lecturas.', 'A second kind of evidence agrees with the readings.') },
  alta: { label: t('Alto', 'High'), help: t('Varios tipos de evidencia independientes coinciden.', 'Several independent kinds of evidence agree.') },
  en_conflicto: { label: t('En conflicto', 'Conflicting'), help: t('Una evidencia contradice a otra. Hay que revisarlo en campo antes de actuar.', 'One piece of evidence contradicts another. Check it in the field before acting.') },
}));

export function likelihoodPlain(l: 'Alta' | 'Media' | 'Baja'): string {
  return l === 'Alta' ? t('Muy posible', 'Very likely') : l === 'Media' ? t('Posible', 'Possible') : t('Poco probable', 'Unlikely');
}

/** Nombre del rol en el idioma activo. */
export const roleLabel = (r: Role): string => ({ ADMIN: t('Administrador', 'Administrator'), OPERATOR: t('Operador', 'Operator'), VIEWER: t('Lector', 'Viewer'), VISITOR: t('Visitante', 'Visitor') })[r] ?? ROLE_LABEL[r];

// ───────────── Tiempo ─────────────

export function timeAgo(iso: string | number | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return t('sin datos', 'no data');
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return t('sin datos', 'no data');
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t('hace unos segundos', 'a few seconds ago');
  const m = Math.round(s / 60);
  if (m < 60) return t(`hace ${m} min`, `${m} min ago`);
  const h = Math.round(m / 60);
  if (h < 48) return t(`hace ${h} h`, `${h} h ago`);
  const d = Math.round(h / 24);
  return t(`hace ${d} días`, `${d} days ago`);
}

// ───────────── Resumen del estado de la red ─────────────

export interface NetworkSummary {
  status: HealthKey;
  headline: string;
  detail: string;
  counts: {
    activeIncidents: number;
    criticalIncidents: number;
    undecided: number;
    openOrders: number;
    verifying: number;
    pendingReports: number;
  };
  allSynthetic: boolean;
  lastReadingAt: string | null;
}

export function networkSummary(input: {
  nodes: NetworkNode[];
  anomalies: AnomalyEvent[];
  diagnoses: AquaBrainDiagnosis[];
  orders: SmartWorkOrder[];
  pendingReports: number;
}): NetworkSummary {
  const active = input.anomalies.filter((a) => a.status === 'active').sort(byUrgency);
  const critical = active.filter((a) => a.priority.priority === 'Crítica');
  const undecided = active.filter((a) => !input.diagnoses.some((d) => d.anomalyId === a.id && d.operatorDecision !== 'pending')).length;
  const openOrders = input.orders.filter((o) => o.status !== 'Cerrada').length;
  const verifying = input.nodes.filter((n) => nodeHealth(n) === 'verifying').length;
  const status: HealthKey = critical.length > 0 ? 'critical' : active.length > 0 ? 'attention' : verifying > 0 ? 'verifying' : 'stable';
  const headline =
    status === 'critical'
      ? incidentTitle(critical[0])
      : status === 'attention'
        ? active.length === 1
          ? incidentTitle(active[0])
          : t(`${active.length} incidentes requieren atención`, `${active.length} incidents need attention`)
        : status === 'verifying'
          ? t('Hay zonas pendientes de verificación', 'Some zones are pending verification')
          : t('La red está estable', 'The network is stable');
  const detail =
    status === 'critical'
      ? t(`Es el incidente más urgente${active.length > 1 ? ` de ${active.length} activos` : ''}. Revisa qué significa y decide qué hacer.`, `This is the most urgent${active.length > 1 ? ` of ${active.length} active incidents` : ' incident'}. Review what it means and decide what to do.`)
      : status === 'attention'
        ? t('Revisa el incidente y decide qué hacer.', 'Review the incident and decide what to do.')
        : status === 'verifying'
          ? t('Se cerró una intervención pero todavía no hay mediciones reales que confirmen la recuperación.', 'An intervention was closed but there are no later measurements yet to confirm recovery.')
          : t('No hay incidentes activos. Las lecturas están dentro de lo normal.', 'There are no active incidents. Readings are within the normal range.');
  const times = input.nodes.map((n) => n.current.timestamp).filter((t) => Number.isFinite(Date.parse(t)));
  const last = times.length ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null;
  return {
    status,
    headline,
    detail,
    counts: { activeIncidents: active.length, criticalIncidents: critical.length, undecided, openOrders, verifying, pendingReports: input.pendingReports },
    allSynthetic: input.nodes.length > 0 && input.nodes.every(isSyntheticNode),
    lastReadingAt: last,
  };
}

// ───────────── Qué hacer ahora (Inicio) ─────────────

export interface NextAction {
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  cta: string;
  target: { kind: 'incident'; id: string } | { kind: 'order'; id: string } | { kind: 'sync' };
  /** Permiso del servidor que hace falta para ejecutar la acción (la interfaz lo usa solo para explicarlo). */
  needs?: Permission;
}

export function nextActions(input: {
  anomalies: AnomalyEvent[];
  diagnoses: AquaBrainDiagnosis[];
  orders: SmartWorkOrder[];
  nodes: NetworkNode[];
  seriesByNode: Record<string, TelemetryReading[]>;
  pendingReports: number;
  online: boolean;
  /** Trust Ledger: de aquí sale el veredicto sellado de cada reparación. */
  ledger?: TrustLedgerEntry[];
}): NextAction[] {
  const out: NextAction[] = [];
  const active = input.anomalies.filter((a) => a.status === 'active').sort(byUrgency);
  for (const a of active) {
    const d = input.diagnoses.find((x) => x.anomalyId === a.id);
    const hasOrder = input.orders.some((o) => o.anomalyId === a.id);
    if (hasOrder) continue;
    const u = urgency(a.priority.priority);
    if (!d) out.push({ id: `inc-${a.id}`, tone: u.tone, title: incidentTitle(a), detail: t('Falta pedir el diagnóstico.', 'The diagnosis has not been requested yet.'), cta: t('Ver incidente', 'See incident'), target: { kind: 'incident', id: a.id }, needs: 'ai:use' });
    else if (d.operatorDecision === 'pending') out.push({ id: `inc-${a.id}`, tone: u.tone, title: incidentTitle(a), detail: t('Esperando tu decisión: aceptar la recomendación, cambiarla o descartarla.', 'Waiting for your decision: accept the recommendation, change it or dismiss it.'), cta: t('Decidir', 'Decide'), target: { kind: 'incident', id: a.id }, needs: 'diagnosis:decide' });
  }
  for (const o of input.orders.filter((x) => x.status !== 'Cerrada')) {
    out.push({ id: `ord-${o.id}`, tone: o.status === 'Abierta' ? 'attention' : 'neutral', title: t(`Orden ${o.id}: ${o.location}`, `Order ${o.id}: ${o.location}`), detail: o.status === 'Abierta' ? t(`Sin iniciar · responsable: ${o.assignee}`, `Not started · owner: ${o.assignee}`) : t(`En progreso · responsable: ${o.assignee}`, `In progress · owner: ${o.assignee}`), cta: t('Abrir orden', 'Open order'), target: { kind: 'order', id: o.id }, needs: 'order:write' });
  }
  for (const o of input.orders.filter((x) => x.status === 'Cerrada')) {
    const rv = repairView(o, input.nodes.find((n) => n.id === o.nodeId), input.seriesByNode[o.nodeId], input.ledger);
    if (rv && (rv.outcome === 'PENDING' || rv.outcome === 'INCONCLUSIVE')) {
      out.push({ id: `ver-${o.id}`, tone: 'verifying', title: t(`Confirmar la recuperación en ${o.location.split(' · ')[0]}`, `Confirm recovery at ${o.location.split(' · ')[0]}`), detail: rv.outcome === 'PENDING' ? t('La orden se cerró, pero todavía no hay mediciones posteriores.', 'The order was closed, but there are no later measurements yet.') : t(`Hay ${rv.measuredAfter} de ${rv.required} mediciones normales seguidas: aún no basta para confirmar.`, `${rv.measuredAfter} of ${rv.required} consecutive normal measurements so far: not enough to confirm yet.`), cta: t('Ver orden', 'See order'), target: { kind: 'order', id: o.id } });
    }
  }
  if (input.pendingReports > 0) {
    out.push({
      id: 'sync',
      tone: input.online ? 'attention' : 'offline',
      title: t(`${input.pendingReports} ${plural(input.pendingReports, ['reporte guardado', 'reportes guardados'], ['', ''])} en este dispositivo`, `${input.pendingReports} ${plural(input.pendingReports, ['', ''], ['report saved', 'reports saved'])} on this device`),
      detail: input.online ? t('Aún no se enviaron al servidor.', 'They have not been sent to the server yet.') : t('Se enviarán cuando vuelva la conexión.', 'They will be sent when the connection is back.'),
      cta: input.online ? t('Enviar ahora', 'Send now') : t('Esperando conexión', 'Waiting for connection'),
      target: { kind: 'sync' },
      needs: 'offline:sync',
    });
  }
  const rank: Record<Tone, number> = { critical: 0, attention: 1, verifying: 2, offline: 3, neutral: 4, ok: 5 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// ───────────── Rutas de la aplicación ─────────────

export type MainView = 'home' | 'map' | 'incidents' | 'orders' | 'advanced';
export const MAIN_NAV: Array<{ id: Exclude<MainView, 'advanced'>; readonly label: string; hash: string }> = [
  { id: 'home', get label() { return t('Inicio', 'Home'); }, hash: 'inicio' },
  { id: 'map', get label() { return t('Mapa', 'Map'); }, hash: 'mapa' },
  { id: 'incidents', get label() { return t('Incidentes', 'Incidents'); }, hash: 'incidentes' },
  { id: 'orders', get label() { return t('Órdenes de trabajo', 'Work orders'); }, hash: 'ordenes' },
];
export const ADVANCED_TABS = ['sensores', 'evidencia', 'ledger', 'conectividad', 'demo'] as const;
export type AdvancedTab = (typeof ADVANCED_TABS)[number];

export function parseHash(hash: string): { view: MainView; tab: AdvancedTab } {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const nav = MAIN_NAV.find((n) => n.hash === parts[0]);
  if (nav) return { view: nav.id, tab: 'sensores' };
  if (parts[0] === 'avanzado') return { view: 'advanced', tab: (ADVANCED_TABS as readonly string[]).includes(parts[1]) ? (parts[1] as AdvancedTab) : 'sensores' };
  return { view: 'home', tab: 'sensores' };
}

export function hashFor(view: MainView, tab: AdvancedTab = 'sensores'): string {
  if (view === 'advanced') return `#/avanzado/${tab}`;
  return `#/${MAIN_NAV.find((n) => n.id === view)!.hash}`;
}
