import { Permission } from '../core/permissions';
import {
  AnomalyEvent,
  AquaBrainDiagnosis,
  NetworkNode,
  PriorityLevel,
  SmartWorkOrder,
  TelemetryReading,
} from '../core/types';

/**
 * REQ-UX-01..05: vocabulario y reglas de presentación de la interfaz, en lenguaje claro y SIN lógica de negocio nueva.
 * Todo se deriva de datos que el servidor ya entrega. Cuando el servidor afirma algo que la interfaz sabe que no es
 * cierto (p. ej. un reporte declarado contado como "sensores", o un nodo "nominal" sin mediciones tras un cierre),
 * la interfaz lo muestra tal como es, no lo oculta.
 */

// ───────────── Estados ─────────────

export type HealthKey = 'stable' | 'attention' | 'critical' | 'verifying' | 'offline';
export type Tone = 'ok' | 'attention' | 'critical' | 'verifying' | 'offline' | 'neutral';

export const HEALTH_META: Record<HealthKey, { label: string; tone: Tone; help: string }> = {
  stable: { label: 'Estable', tone: 'ok', help: 'Las lecturas están dentro de lo normal.' },
  attention: { label: 'Requiere atención', tone: 'attention', help: 'Hay algo fuera de lo normal que conviene revisar.' },
  critical: { label: 'Crítico', tone: 'critical', help: 'Hay un problema que debe atenderse cuanto antes.' },
  verifying: { label: 'Pendiente de verificación', tone: 'verifying', help: 'Se cerró una intervención, pero aún no hay mediciones reales que confirmen la recuperación.' },
  offline: { label: 'Sin conexión', tone: 'offline', help: 'No hay conexión con el servidor. Lo que registres se guarda en este dispositivo.' },
};

/** El nodo está "pendiente de verificación" si su última lectura no es una medición sino la restauración al cerrar una orden. */
export function nodeHealth(node: NetworkNode): HealthKey {
  if (node.current.source === 'restored') return 'verifying';
  if (node.status === 'critical') return 'critical';
  if (node.status === 'warning' || node.status === 'fault') return 'attention';
  return 'stable';
}

export const nodeHealthDetail = (node: NetworkNode): string =>
  node.status === 'fault' && node.current.source !== 'restored' ? 'El sensor no da lecturas confiables.' : HEALTH_META[nodeHealth(node)].help;

export function urgency(priority: PriorityLevel): { label: string; tone: Tone } {
  switch (priority) {
    case 'Crítica':
      return { label: 'Urgente', tone: 'critical' };
    case 'Alta':
      return { label: 'Importante', tone: 'attention' };
    case 'Media':
      return { label: 'Normal', tone: 'attention' };
    default:
      return { label: 'Bajo', tone: 'neutral' };
  }
}

const URGENCY_RANK: Record<PriorityLevel, number> = { Crítica: 0, Alta: 1, Media: 2, Baja: 3 };
export const byUrgency = (a: AnomalyEvent, b: AnomalyEvent) =>
  URGENCY_RANK[a.priority.priority] - URGENCY_RANK[b.priority.priority] || b.priority.totalScore - a.priority.totalScore || b.timestamp.localeCompare(a.timestamp);

// ───────────── Procedencia de cada dato ─────────────

export type Provenance = 'medido' | 'declarado' | 'inferido' | 'hipotesis_ia' | 'simulado';

export const PROVENANCE_META: Record<Provenance, { label: string; help: string }> = {
  medido: { label: 'MEDIDO', help: 'Lectura de un sensor.' },
  declarado: { label: 'DECLARADO', help: 'Lo reportó una persona. No está verificado por ningún sensor.' },
  inferido: { label: 'INFERIDO', help: 'Resultado de reglas y cálculos del sistema sobre las lecturas. Sin inteligencia artificial.' },
  hipotesis_ia: { label: 'HIPÓTESIS IA', help: 'Interpretación generada por inteligencia artificial. Es una hipótesis, no un hecho confirmado.' },
  simulado: { label: 'SIMULADO', help: 'Dato sintético de demostración. No proviene de la red real.' },
};

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
 * Canales de respaldo que se muestran al usuario. El servidor cuenta SIEMPRE el canal "sensores" (defecto F1 de la auditoría):
 * en un reporte declarado por una persona eso es falso, así que aquí se muestra como "Reporte de campo (declarado)".
 */
export function evidenceBasisLabels(anomaly: Pick<AnomalyEvent, 'origin'>, diagnosis: Pick<AquaBrainDiagnosis, 'evidenceBasis'> | null): { labels: string[]; warning?: string } {
  const declared = anomaly.origin === 'offline-report';
  const map: Record<string, string> = { sensores: 'Lecturas de sensores', hidráulica: 'Balance hidráulico', fotografía: 'Fotografía analizada' };
  const basis = diagnosis?.evidenceBasis ?? [];
  const labels = basis.filter((b) => !(declared && b === 'sensores')).map((b) => map[b] ?? b);
  if (declared) labels.unshift('Reporte de campo (declarado)');
  return {
    labels,
    warning: declared && basis.includes('sensores')
      ? 'El servidor cuenta este reporte como respaldo de «sensores», pero lo escribió una persona y ningún sensor lo confirma. Se muestra como declarado.'
      : undefined,
  };
}

/** Nombre claro de cada canal de concordancia para el usuario. */
export function channelLabel(anomaly: Pick<AnomalyEvent, 'origin'>, channel: string): string {
  if (channel === 'sensores') return anomaly.origin === 'offline-report' ? 'Reporte de campo (declarado)' : 'Lecturas de sensores';
  if (channel === 'hidráulica') return 'Balance hidráulico';
  if (channel === 'fotografía') return 'Fotografía';
  return channel;
}

export function channelProvenance(anomaly: Pick<AnomalyEvent, 'origin' | 'synthetic'>, channel: string, visionIsAi: boolean): Provenance[] {
  if (channel === 'sensores') return anomaly.origin === 'offline-report' ? ['declarado'] : anomaly.synthetic ? ['medido', 'simulado'] : ['medido'];
  if (channel === 'hidráulica') return anomaly.synthetic ? ['inferido', 'simulado'] : ['inferido'];
  return visionIsAi ? ['hipotesis_ia'] : [];
}

// ───────────── Incidentes en lenguaje claro ─────────────

const CATEGORY_PLAIN: Record<AnomalyEvent['category'], string> = {
  leak: 'fuga de agua',
  obstruction: 'obstrucción',
  contamination: 'problema de calidad del agua',
  quality_drift: 'cambio en la calidad del agua',
  sensor_fault: 'falla de un sensor',
  nominal: 'sin anomalía',
};

export function incidentTitle(a: AnomalyEvent): string {
  const where = a.nodeName;
  if (a.origin === 'offline-report') return `Reporte de campo: ${CATEGORY_PLAIN[a.category]} en ${where}`;
  if (a.origin === 'network-balance') return a.hydraulicLevel === 'localized_leak' ? `Fuga probable cerca de ${where}` : `Posible fuga cerca de ${where}`;
  switch (a.category) {
    case 'leak':
      return `Posible fuga en ${where}`;
    case 'obstruction':
      return `Posible obstrucción en ${where}`;
    case 'contamination':
      return `Calidad del agua fuera de rango en ${where}`;
    case 'quality_drift':
      return `El agua en ${where} se aleja de lo normal`;
    case 'sensor_fault':
      return `El sensor de ${where} no es confiable`;
    default:
      return `Incidente en ${where}`;
  }
}

const METRIC_PLAIN: Record<string, { label: string; unit: string }> = {
  pressureBar: { label: 'La presión', unit: 'bar' },
  flowLs: { label: 'El caudal', unit: 'L/s' },
  turbidityNtu: { label: 'La turbidez', unit: 'NTU' },
  chlorineMgL: { label: 'El cloro', unit: 'mg/L' },
  ph: { label: 'El pH', unit: '' },
  levelPct: { label: 'El nivel del tanque', unit: '%' },
};

const num = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Number(n.toFixed(2)).toString());

/** Qué está pasando, con cifras y su referencia ("normal"). */
export function incidentWhatHappens(a: AnomalyEvent): string {
  const first = a.rulesTriggered[0];
  if (a.origin === 'offline-report') {
    const quoted = first?.explanation.match(/"([^"]{1,200})"/)?.[1];
    return `Una persona reportó en campo${quoted ? `: «${quoted}»` : ' un problema'}. Ningún sensor lo ha confirmado todavía.`;
  }
  if (a.origin === 'network-balance' && first) {
    return `Entra más agua a la red de la que se consume: unos ${num(first.observedValue)} L/s de diferencia. Es una estimación a partir de los medidores, no una medición directa de la fuga.`;
  }
  const parts = a.rulesTriggered
    .filter((r) => METRIC_PLAIN[r.metric] && Number.isFinite(r.deltaPct) && r.metric !== 'fieldReport')
    .slice(0, 2)
    .map((r) => {
      const m = METRIC_PLAIN[r.metric];
      return `${m.label} está ${num(Math.abs(r.deltaPct))}% ${r.deltaPct < 0 ? 'por debajo' : 'por encima'} de lo normal (${num(r.observedValue)}${m.unit ? ' ' + m.unit : ''} frente a ${num(r.baselineValue)}${m.unit ? ' ' + m.unit : ''})`;
    });
  return parts.length ? `${parts.join('. ')}.` : 'El sistema detectó lecturas fuera de lo normal en este punto.';
}

export const HYDRAULIC_PLAIN: Record<string, string> = {
  insufficient_data: 'Todavía no hay datos suficientes para evaluar el balance de agua.',
  no_anomaly: 'El balance de agua no muestra diferencias importantes.',
  flow_anomaly: 'Hay una diferencia de caudal, pero la presión no la confirma. Puede ser un medidor desajustado o más consumo de lo habitual.',
  possible_leak: 'El balance de agua y la presión sugieren una posible fuga.',
  localized_leak: 'El balance de agua y la presión apuntan a una fuga en un tramo concreto entre dos medidores.',
};

export const EVIDENCE_LEVEL_PLAIN: Record<string, { label: string; help: string }> = {
  baja: { label: 'Bajo', help: 'Solo las lecturas de sensores respaldan la conclusión.' },
  media: { label: 'Medio', help: 'Un segundo tipo de evidencia coincide con las lecturas.' },
  alta: { label: 'Alto', help: 'Varios tipos de evidencia independientes coinciden.' },
  en_conflicto: { label: 'En conflicto', help: 'Una evidencia contradice a otra. Hay que revisarlo en campo antes de actuar.' },
};

export function likelihoodPlain(l: 'Alta' | 'Media' | 'Baja'): string {
  return l === 'Alta' ? 'Muy posible' : l === 'Media' ? 'Posible' : 'Poco probable';
}

// ───────────── Verificación tras el cierre (F2) ─────────────

export type OrderVerification =
  | { state: 'not_closed' }
  | { state: 'pending'; measuredAfter: 0; closedAt: string }
  | { state: 'measured'; measuredAfter: number; closedAt: string; last: TelemetryReading };

const NOT_MEASUREMENT = new Set(['restored', 'baseline']);

/**
 * El servidor, al cerrar una orden, escribe una lectura "restaurada" con los valores normales y marca el nodo como estable
 * (defecto F2 de la auditoría). Esa lectura NO es una medición. Aquí solo cuentan las lecturas posteriores al cierre
 * que no sean esa restauración.
 */
export function orderVerification(order: Pick<SmartWorkOrder, 'status' | 'updatedAt' | 'seal'>, series: TelemetryReading[] | undefined): OrderVerification {
  if (order.status !== 'Cerrada') return { state: 'not_closed' };
  const closedAt = order.seal?.sealedAt ?? order.updatedAt;
  const closedMs = Date.parse(closedAt);
  const after = (series ?? []).filter((r) => !NOT_MEASUREMENT.has(r.source ?? '') && Date.parse(r.timestamp) > closedMs);
  if (after.length === 0) return { state: 'pending', measuredAfter: 0, closedAt };
  return { state: 'measured', measuredAfter: after.length, closedAt, last: after[after.length - 1] };
}

// ───────────── Tiempo ─────────────

export function timeAgo(iso: string | number | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return 'sin datos';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return 'sin datos';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'hace unos segundos';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
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
          : `${active.length} incidentes requieren atención`
        : status === 'verifying'
          ? 'Hay zonas pendientes de verificación'
          : 'La red está estable';
  const detail =
    status === 'critical'
      ? `Es el incidente más urgente${active.length > 1 ? ` de ${active.length} activos` : ''}. Revisa qué significa y decide qué hacer.`
      : status === 'attention'
        ? 'Revisa el incidente y decide qué hacer.'
        : status === 'verifying'
          ? 'Se cerró una intervención pero todavía no hay mediciones reales que confirmen la recuperación.'
          : 'No hay incidentes activos. Las lecturas están dentro de lo normal.';
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
}): NextAction[] {
  const out: NextAction[] = [];
  const active = input.anomalies.filter((a) => a.status === 'active').sort(byUrgency);
  for (const a of active) {
    const d = input.diagnoses.find((x) => x.anomalyId === a.id);
    const hasOrder = input.orders.some((o) => o.anomalyId === a.id);
    if (hasOrder) continue;
    const u = urgency(a.priority.priority);
    if (!d) out.push({ id: `inc-${a.id}`, tone: u.tone, title: incidentTitle(a), detail: 'Falta pedir el diagnóstico.', cta: 'Ver incidente', target: { kind: 'incident', id: a.id }, needs: 'ai:use' });
    else if (d.operatorDecision === 'pending') out.push({ id: `inc-${a.id}`, tone: u.tone, title: incidentTitle(a), detail: 'Esperando tu decisión: aceptar la recomendación, cambiarla o descartarla.', cta: 'Decidir', target: { kind: 'incident', id: a.id }, needs: 'diagnosis:decide' });
  }
  for (const o of input.orders.filter((x) => x.status !== 'Cerrada')) {
    out.push({ id: `ord-${o.id}`, tone: o.status === 'Abierta' ? 'attention' : 'neutral', title: `Orden ${o.id}: ${o.location}`, detail: o.status === 'Abierta' ? `Sin iniciar · responsable: ${o.assignee}` : `En progreso · responsable: ${o.assignee}`, cta: 'Abrir orden', target: { kind: 'order', id: o.id }, needs: 'order:write' });
  }
  for (const o of input.orders.filter((x) => x.status === 'Cerrada')) {
    const v = orderVerification(o, input.seriesByNode[o.nodeId]);
    if (v.state === 'pending') out.push({ id: `ver-${o.id}`, tone: 'verifying', title: `Confirmar la recuperación en ${o.location.split(' · ')[0]}`, detail: 'La orden se cerró, pero todavía no hay mediciones reales posteriores.', cta: 'Ver orden', target: { kind: 'order', id: o.id } });
  }
  if (input.pendingReports > 0) {
    out.push({
      id: 'sync',
      tone: input.online ? 'attention' : 'offline',
      title: `${input.pendingReports} ${input.pendingReports === 1 ? 'reporte guardado' : 'reportes guardados'} en este dispositivo`,
      detail: input.online ? 'Aún no se enviaron al servidor.' : 'Se enviarán cuando vuelva la conexión.',
      cta: input.online ? 'Enviar ahora' : 'Esperando conexión',
      target: { kind: 'sync' },
      needs: 'offline:sync',
    });
  }
  const rank: Record<Tone, number> = { critical: 0, attention: 1, verifying: 2, offline: 3, neutral: 4, ok: 5 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// ───────────── Rutas de la aplicación ─────────────

export type MainView = 'home' | 'map' | 'incidents' | 'orders' | 'advanced';
export const MAIN_NAV: Array<{ id: Exclude<MainView, 'advanced'>; label: string; hash: string }> = [
  { id: 'home', label: 'Inicio', hash: 'inicio' },
  { id: 'map', label: 'Mapa', hash: 'mapa' },
  { id: 'incidents', label: 'Incidentes', hash: 'incidentes' },
  { id: 'orders', label: 'Órdenes de trabajo', hash: 'ordenes' },
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
