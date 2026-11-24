import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Role } from '../core/permissions';
import { AdvancedView, DemoPanel } from '../components/AdvancedView';
import { AppShell } from '../components/AppShell';
import { HomeView, HomeViewProps } from '../components/HomeView';
import { IncidentsView, IncidentsViewProps } from '../components/IncidentsView';
import { MapView } from '../components/MapView';
import { WorkOrdersView, WorkOrdersViewProps } from '../components/WorkOrdersView';
import { HowItWorks, IntroSection, IntroVideo } from '../components/IntroSection';
import { parseVideoConfig } from './introVideo';
import { anomaly, diag, node, order, reading } from './fixtures';

/**
 * REQ-UX-01..05: la interfaz se renderiza con datos reales de la forma que entrega el servidor y se comprueba lo que la persona VE.
 * No sustituye a una prueba en navegador (ver el informe de validación), pero fija por pruebas automáticas que F1/F2 no se maquillan,
 * que cada rol ve solo lo que puede hacer y que la accesibilidad básica no se pierde.
 */
const noop = () => undefined;
const asyncNoop = async () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const homeProps = (over: Partial<HomeViewProps> = {}): HomeViewProps => ({
  nodes: [node()], anomalies: [], diagnoses: [], workOrders: [], seriesByNode: {}, pendingReports: 0, online: true, syncing: false, loading: false, loadError: null,
  lastUpdatedAt: Date.now(), role: 'OPERATOR' as Role, onOpenIncident: noop, onOpenOrder: noop, onSyncReports: noop, onNavigate: noop, onReport: noop, onRetry: noop, ...over,
});

const incidentProps = (over: Partial<IncidentsViewProps> = {}): IncidentsViewProps => ({
  nodes: [node()], anomalies: [anomaly()], diagnoses: [], visionAnalyses: [], workOrders: [], hydraulic: null, role: 'OPERATOR' as Role, loading: false, selectedId: 'A1',
  onSelect: noop, onGenerateDiagnosis: asyncNoop, onDecide: asyncNoop, onAddPhoto: asyncNoop, onOpenOrder: noop, onReport: noop, onOpenAdvanced: noop, ...over,
});

const closedOrder = order({ status: 'Cerrada', nodeId: 'N1', updatedAt: '2026-06-01T13:00:00.000Z', checklist: [{ id: 'c1', label: 'Aislar el tramo', done: true, doneAt: '2026-06-01T12:40:00.000Z', doneBy: 'Ana' }], closureEvidence: { fileName: 'foto.png', mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64), attachedAt: '2026-06-01T12:50:00.000Z', attachedBy: 'Ana' }, requiredResources: [], probableCause: 'Brida fracturada', assetName: 'Tubo' });
const ordersProps = (over: Partial<WorkOrdersViewProps> = {}): WorkOrdersViewProps => ({
  workOrders: [closedOrder], nodes: [node()], seriesByNode: {}, role: 'OPERATOR' as Role, loading: false, selectedId: 'OT-1', onSelect: noop, onUpdateOrder: asyncNoop, onAssignOrder: asyncNoop,
  onToggleChecklist: asyncNoop, onUploadEvidence: asyncNoop, onDownloadDossier: asyncNoop, onOpenLedger: noop, onOpenIncident: noop, ...over,
});

const offlineAnomaly = anomaly({
  origin: 'offline-report',
  synthetic: false,
  rulesTriggered: [{ ruleId: 'PRESSURE_DROP_LEAK', metric: 'fieldReport', observedValue: 1, baselineValue: 0, deltaPct: 100, title: '', category: 'leak', severityScore: 50, explanation: 'Reporte en sitio capturado sin conexión (declarado por el reportante, no verificado): "sale agua junto a la escuela"' }],
});

test('REQ-UX-01: Inicio responde "qué pasa" en una frase y deja claro que los datos son simulados', () => {
  const t = text(html(<HomeView {...homeProps()} />));
  assert.match(t, /La red está estable/);
  assert.match(t, /No hay nada pendiente/);
  assert.match(t, /SIMULADO/);
  assert.match(t, /de demostración, no de campo/);
});

test('REQ-UX-03: F2 visible. Una zona restaurada al cerrar una orden NO se presenta como estable en Inicio', () => {
  const restored = node({ current: reading({ source: 'restored' }) });
  const t = text(html(<HomeView {...homeProps({ nodes: [restored] })} />));
  assert.doesNotMatch(t, /La red está estable/);
  assert.match(t, /Hay zonas pendientes de verificación/);
  assert.match(t, /Pendiente de verificación/);
  assert.match(t, /sin haber medido nada/);
});

test('REQ-UX-01: Inicio ordena lo que hay que hacer y lo adapta al rol (el Lector no recibe botones que no puede usar)', () => {
  const props = homeProps({ nodes: [node({ status: 'critical' })], anomalies: [anomaly({ priority: { totalScore: 90, priority: 'Crítica' } as never })], diagnoses: [diag()], pendingReports: 2 });
  const operator = text(html(<HomeView {...props} />));
  assert.match(operator, /Qué hacer ahora/);
  assert.match(operator, /Posible fuga en Troncal Norte/);
  assert.match(operator, /Decidir/);
  assert.match(operator, /Enviar ahora/);
  const viewer = text(html(<HomeView {...props} role="VIEWER" />));
  assert.match(viewer, /Con tu rol puedes consultarlo, pero no actuar/);
  assert.match(viewer, /Solo operadores pueden enviarlos/);
  assert.doesNotMatch(viewer, /Reportar un problema/);
  const offline = text(html(<HomeView {...props} online={false} />));
  assert.match(offline, /Se enviarán cuando vuelva la conexión/);
});

test('REQ-UX-01: un fallo de carga se explica y se puede reintentar, mostrando la antigüedad de lo que se ve', () => {
  const t = text(html(<HomeView {...homeProps({ loadError: 'No hay conexión con el servidor.', lastUpdatedAt: Date.now() - 5 * 60_000 })} />));
  assert.match(t, /No se pudo actualizar/);
  assert.match(t, /hace 5 min/);
  assert.match(t, /Reintentar/);
  const loading = html(<HomeView {...homeProps({ loading: true })} />);
  assert.match(loading, /aria-busy="true"/);
});

test('REQ-UX-02: F1 visible. Un reporte DECLARADO nunca aparece como lectura de sensores, aunque el servidor lo cuente así', () => {
  const props = incidentProps({ anomalies: [offlineAnomaly], diagnoses: [diag({ evidenceBasis: ['sensores'], primaryHypothesis: 'Posible rotura', potentialImpact: 'Pérdida de agua', recommendedAction: 'Revisar el tramo', uncertaintyStatement: 'Sin medición', missingData: [], alternativeHypotheses: [], evidenceLevel: 'baja' })] });
  const h = html(<IncidentsView {...props} />);
  const t = text(h);
  assert.match(t, /Reporte de campo: fuga de agua/);
  assert.match(t, /DECLARADO/);
  assert.match(t, /Una persona reportó en campo: «sale agua junto a la escuela»/);
  assert.match(t, /Ningún sensor lo ha confirmado/);
  assert.match(t, /Reporte de campo \(declarado\)/);
  assert.doesNotMatch(t, /Lecturas de sensores/);
  assert.doesNotMatch(t, /MEDIDO/);
});

test('REQ-UX-02: la hipótesis se presenta como hipótesis; el texto de respaldo no se rotula como IA y el de Gemini sí', () => {
  const base = { primaryHypothesis: 'Rotura de brida', potentialImpact: 'Baja presión', recommendedAction: 'Aislar y reparar', uncertaintyStatement: 'Sin inspección', missingData: ['Inspección acústica'], alternativeHypotheses: [{ title: 'Medidor desajustado', likelihood: 'Baja', supportingEvidence: 'a', contradictingOrMissing: 'b' }] } as const;
  const fallback = text(html(<IncidentsView {...incidentProps({ diagnoses: [diag({ ...base, providerMode: 'fallback-adapter' } as never)] })} />));
  assert.match(fallback, /Causa más probable INFERIDO/);
  assert.doesNotMatch(fallback, /HIPÓTESIS IA/);
  assert.match(fallback, /Es una hipótesis para decidir mejor, no un hecho confirmado/);
  assert.match(fallback, /Poco probable/);
  const live = text(html(<IncidentsView {...incidentProps({ diagnoses: [diag({ ...base, providerMode: 'gemini-live' } as never)] })} />));
  assert.match(live, /Causa más probable HIPÓTESIS IA/);
});

test('REQ-UX-05: cada rol ve en Incidentes solo lo que puede hacer; la decisión siempre la valida el servidor', () => {
  const d = diag({ primaryHypothesis: 'x', potentialImpact: 'y', recommendedAction: 'Reparar la brida', uncertaintyStatement: 'z', missingData: [], alternativeHypotheses: [] } as never);
  const operator = text(html(<IncidentsView {...incidentProps({ diagnoses: [d] })} />));
  assert.match(operator, /Aceptar y crear la orden de trabajo/);
  assert.match(operator, /Cambiar la recomendación/);
  assert.match(operator, /No aplicar/);
  const viewer = text(html(<IncidentsView {...incidentProps({ diagnoses: [d], role: 'VIEWER' })} />));
  assert.doesNotMatch(viewer, /Aceptar y crear la orden de trabajo/);
  assert.match(viewer, /permite consultar, no decidir/);
  assert.doesNotMatch(viewer, /Reportar un problema/);
  assert.doesNotMatch(viewer, /Añadir una foto/);
  const noDiag = text(html(<IncidentsView {...incidentProps({ role: 'VIEWER' })} />));
  assert.match(noDiag, /Un operador debe pedir el diagnóstico/);
  assert.match(text(html(<IncidentsView {...incidentProps()} />)), /Pedir el diagnóstico/);
});

test('REQ-UX-01: un incidente con orden lleva directamente a ella; cada bloque responde qué pasa, qué significa y qué hacer', () => {
  const t = text(html(<IncidentsView {...incidentProps({ diagnoses: [diag({ potentialImpact: 'y', primaryHypothesis: 'x', recommendedAction: 'z', uncertaintyStatement: 'u', missingData: [], alternativeHypotheses: [] } as never)], workOrders: [order()] })} />));
  for (const q of ['Qué está pasando', 'Qué significa', 'Qué debo hacer', 'Evidencias']) assert.match(t, new RegExp(q));
  assert.match(t, /Ya existe la orden de trabajo OT-1/);
  assert.match(t, /Abrir la orden/);
  assert.doesNotMatch(t, /Aceptar y crear/);
});

test('REQ-UX-03: F2 visible. Una orden cerrada sin mediciones posteriores dice "Aún no se puede confirmar" y no promete recuperación', () => {
  const t = text(html(<WorkOrdersView {...ordersProps()} />));
  assert.match(t, /Pendiente de verificación/);
  assert.match(t, /Aún no se puede confirmar/);
  assert.match(t, /sus cifras son de antes del cierre/);
  assert.doesNotMatch(t, /Restaurar Nodo/);
  assert.doesNotMatch(t, /verificada en campo/);
  const measured = text(html(<WorkOrdersView {...ordersProps({ seriesByNode: { N1: [reading({ timestamp: '2026-06-01T13:30:00.000Z', source: 'api' })] } })} />));
  assert.match(measured, /Hay 1 medición posterior/);
  assert.match(measured, /quedó registrada en el Trust Ledger/);
  assert.doesNotMatch(measured, /recuperación está medida/, 'el punto sigue con la lectura antigua: no se declara recuperado');
  assert.doesNotMatch(measured, /Aún no se puede confirmar/);
});

test('REQ-UX-05: en Órdenes el Lector consulta pero no modifica; el Operador puede cerrar y se le avisa de lo que implica', () => {
  const open = order({ status: 'En Progreso', checklist: [{ id: 'c1', label: 'Aislar el tramo', done: true }], closureEvidence: closedOrder.closureEvidence, requiredResources: ['Llave'], probableCause: 'Brida', assetName: 'Tubo' });
  const operator = text(html(<WorkOrdersView {...ordersProps({ workOrders: [open] })} />));
  assert.match(operator, /Cerrar la orden/);
  assert.match(operator, /Cambiar/);
  const operatorHtml = html(<WorkOrdersView {...ordersProps({ workOrders: [open] })} />);
  assert.doesNotMatch(operatorHtml, /type="checkbox"[^>]*disabled/);
  const viewerHtml = html(<WorkOrdersView {...ordersProps({ workOrders: [open], role: 'VIEWER' })} />);
  const viewer = text(viewerHtml);
  assert.match(viewer, /permite consultar la orden, no modificarla/);
  assert.doesNotMatch(viewer, /Cerrar la orden/);
  assert.match(viewerHtml, /type="checkbox"[^>]*disabled/);
});

test('REQ-UX-05: la demostración y los reinicios solo se activan para quien tiene permiso', () => {
  const props = { scenarios: [{ id: 'leak', label: 'Fuga', shortTitle: 'Rotura' }] as never, busy: false, onTriggerScenario: noop, onStartDemo: noop, onReset: noop };
  const admin = html(<DemoPanel {...props} role="ADMIN" />);
  assert.doesNotMatch(admin, /disabled=""/);
  const operator = html(<DemoPanel {...props} role="OPERATOR" />);
  assert.match(text(operator), /Solo un administrador puede reiniciar la red/);
  assert.equal((operator.match(/disabled=""/g) ?? []).length, 2, 'iniciar la demostración y volver al estado normal quedan desactivados');
  const viewer = html(<DemoPanel {...props} role="VIEWER" />);
  assert.equal((viewer.match(/disabled=""/g) ?? []).length, 3, 'el Lector no puede lanzar nada');
  assert.match(text(html(<DemoPanel {...props} role="ADMIN" />)), /Todo lo de aquí es simulado/);
});

const shell = (over: Partial<React.ComponentProps<typeof AppShell>> = {}) =>
  html(
    <AppShell view="home" user={{ id: 'u', username: 'ana', displayName: 'Ana', role: 'OPERATOR' }} connection={{ online: true, simulatedOffline: false, pendingReports: 0, syncing: false, lastUpdatedAt: Date.now() }} allSynthetic badges={{ incidents: 2 }} onNavigate={noop} onLogout={noop} {...over}>
      <p>contenido</p>
    </AppShell>
  );

test('REQ-UX-04/REQ-PUB-04: el menú es un único desplegable compacto, cerrado de inicio, accesible y sin barras de navegación duplicadas', () => {
  const closed = shell();
  assert.match(closed, /href="#main"/, 'salto al contenido');
  assert.match(closed, /aria-haspopup="menu"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /aria-label="Menú de navegación\. Estás en Inicio"/);
  assert.doesNotMatch(closed, /role="menuitem"/, 'cerrado: no hay opciones a la vista');
  assert.doesNotMatch(closed, /<nav/, 'sin barra superior ni inferior duplicada');
  assert.equal((closed.match(/<button[^>]*aria-haspopup/g) ?? []).length, 1, 'un solo botón de menú');
  assert.match(closed, /SIMULADO/);
  assert.doesNotMatch(text(closed), /Trust Ledger|Sensores IoT|Aqua Brain|Command Center/, 'sin términos técnicos en la cabecera');
});

test('REQ-UX-04/REQ-PUB-04: abierto, el menú ofrece los cuatro apartados, las herramientas avanzadas y la sesión, marcando dónde estás', () => {
  const open = shell({ initialMenuOpen: true, view: 'incidents' });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /role="menu"/);
  const items = (open.match(/role="menuitem"/g) ?? []).length;
  assert.equal(items, 6, 'cuatro apartados + herramientas avanzadas + cerrar sesión');
  const t = text(open);
  for (const label of ['Inicio', 'Mapa', 'Incidentes', 'Órdenes de trabajo', 'Herramientas avanzadas', 'Cerrar sesión']) assert.match(t, new RegExp(label));
  assert.equal((open.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(open, /aria-current="page"[^>]*>[\s\S]*?Incidentes/);
  assert.match(open, /aria-label="2 pendientes"/);
  assert.match(t, /@ana · Operador/);
  assert.match(shell({ view: 'advanced' }), /Estás en Herramientas avanzadas/);
});

test('REQ-PUB-04: el visitante del modo público ve el aviso de solo lectura y «Iniciar sesión» en el menú, nunca «Cerrar sesión»', () => {
  const v = shell({ user: { id: 'public-visitor', username: 'visitante', displayName: 'Visitante', role: 'VISITOR' }, initialMenuOpen: true });
  const t = text(v);
  assert.match(t, /Modo público de demostración/);
  assert.match(t, /Datos simulados y solo lectura/);
  assert.match(t, /Iniciar sesión para actuar/);
  assert.match(t, /Modo público · solo lectura/);
  assert.equal((v.match(/Iniciar sesión/g) ?? []).length >= 2, true);
  assert.doesNotMatch(t, /Cerrar sesión/);
  assert.match(v, /role="note"/);
  assert.doesNotMatch(shell(), /role="note"/, 'un usuario con sesión no ve el aviso público');
});

test('REQ-PUB-04: el visitante ve la presentación del producto arriba (título, video, cómo funciona, acceso) y el estado de la red debajo', () => {
  const h = html(<HomeView {...homeProps({ role: 'VISITOR' })} />);
  const t = text(h);
  assert.equal((h.match(/<h1/g) ?? []).length, 1, 'una sola h1 en la página');
  assert.match(h, /<h1[^>]*id="hero-title"/);
  // REQ-PUB-05: el Hero arranca en inglés.
  assert.match(t, /Intelligence to protect every drop\./);
  assert.match(t, /We detect anomalies, analyze water infrastructure and turn information into verifiable actions\./);
  assert.match(h, /aspect-video/, 'contenedor 16:9');
  assert.match(h, /src="\/images\/hero-network\.svg"/, 'portada neutra antes de saber si hay video en inglés');
  assert.match(h, /alt="Cover of the explainer video/);
  const order = ['hero-title', 'aspect-video', 'how-title', 'explore-title', 'Estado de la red ahora', 'home-status'].map((k) => h.indexOf(k));
  assert.ok(order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), `orden de las secciones: ${order.join(',')}`);
  assert.match(t, /Empezar a explorar/);
  assert.match(t, /No necesitas cuenta/);
  assert.match(t, /Todo lo que ves es simulado/);
  assert.doesNotMatch(t, /Reportar un problema|Ver una demostración/, 'el visitante no recibe acciones que no puede usar');
});

test('REQ-PUB-04: «Cómo funciona» muestra el flujo CAPTURA → DETECCIÓN → ANÁLISIS → ACCIÓN → VERIFICACIÓN con un boceto por paso', () => {
  const h = html(<HowItWorks />);
  const t = text(h);
  const labels = ['CAPTURA', 'DETECCIÓN', 'ANÁLISIS', 'ACCIÓN', 'VERIFICACIÓN'];
  const pos = labels.map((l) => t.indexOf(l));
  assert.ok(pos.every((n, i) => n >= 0 && (i === 0 || n > pos[i - 1])), 'en orden');
  assert.equal((h.match(/<svg/g) ?? []).length >= 5, true, 'un boceto por paso');
  assert.equal((h.match(/role="img" aria-label="Boceto:/g) ?? []).length, 5, 'cada boceto tiene texto alternativo');
  assert.doesNotMatch(t, /garantiza|100 ?%|infalible/i, 'sin promesas que el sistema no puede cumplir');
});

test('REQ-PUB-04: Inicio abre con la landing para cualquier rol y deja el estado operativo de la red debajo', () => {
  const h = html(<HomeView {...homeProps()} />);
  assert.equal((h.match(/<h1/g) ?? []).length, 1, 'una sola h1 en la página');
  assert.match(h, /<h1[^>]*id="hero-title"/);
  assert.match(h, /<h2[^>]*id="home-status"/);
  assert.ok(h.indexOf('hero-title') < h.indexOf('how-title') && h.indexOf('how-title') < h.indexOf('home-status'), 'hero, cómo funciona y luego el estado');
  assert.match(text(h), /Estado de la red ahora/);
});

test('Inicio: la simulación 3D va justo debajo del Hero, rotulada como simulada y con sus pasos y controles accesibles', () => {
  const h = html(<HomeView {...homeProps()} />);
  const hero = h.indexOf('hero-title');
  const sim = h.indexOf('id="sim3d-title"');
  const how = h.indexOf('how-title');
  assert.ok(hero > 0 && sim > hero && how > sim, `orden: hero ${hero}, simulación ${sim}, cómo funciona ${how}`);
  const t = text(h);
  for (const label of ['Operación normal', 'Aparece una fuga', 'Detección', 'Reparación', 'Verificación']) assert.match(t, new RegExp(label));
  assert.match(t, /Balance de agua del tramo P-05/);
  assert.match(h, /aria-label="Girar a la izquierda"/);
  assert.match(h, /aria-label="Ver bajo tierra"/);
  assert.match(h, /type="range"/);
  assert.match(t, /Cargando la maqueta 3D/, 'three.js no se carga en el primer render');
});

test('REQ-PUB-03: sin video publicado, la portada muestra «Video explicativo próximamente» y el botón de reproducir está desactivado (no se simula nada)', () => {
  const h = html(<IntroVideo forceState="soon" />);
  assert.match(text(h), /Video explicativo próximamente/);
  assert.doesNotMatch(h, /<video/, 'no existe ningún reproductor que simular');
  assert.match(h, /<button[^>]*disabled=""[^>]*aria-label="Reproducir el video explicativo \(todavía no disponible\)"|<button[^>]*aria-label="Reproducir el video explicativo \(todavía no disponible\)"[^>]*disabled=""/);
  assert.match(h, /<img[^>]*src="\/images\/video-poster\.svg"/);
  assert.match(h, /aspect-video/);
});

test('REQ-PUB-03: con video publicado se reproduce solo bajo demanda: sin autoplay, sin precarga, con portada y botón accesible', () => {
  const cfg = parseVideoConfig({ src: '/videos/aqua-sentinel-explicativo.mp4', captions: '/videos/es.vtt', title: 'Aqua Sentinel' });
  const h = html(<IntroVideo forceState="ready" forceConfig={cfg} />);
  assert.match(h, /<video/);
  assert.match(h, /src="\/videos\/aqua-sentinel-explicativo\.mp4"/);
  assert.match(h, /poster="\/images\/video-poster\.svg"/);
  assert.match(h, /preload="none"/);
  assert.match(h, /playsinline/i);
  assert.doesNotMatch(h, /autoplay/i, 'nunca se reproduce solo');
  assert.doesNotMatch(h, /<video[^>]*\scontrols/, 'los controles aparecen al empezar, no antes');
  assert.doesNotMatch(h, /muted/i);
  assert.match(h, /<button[^>]*aria-label="Reproducir el video explicativo"/);
  assert.doesNotMatch(h, /Video explicativo próximamente/);
  assert.match(h, /<track[^>]*kind="captions"[^>]*src="\/videos\/es\.vtt"|<track[^>]*src="\/videos\/es\.vtt"[^>]*kind="captions"/);
  assert.match(h, /aria-label="Aqua Sentinel"/);
});

test('REQ-PUB-05: el Hero tiene un selector English / Español, con inglés por defecto, y cambia sus textos', () => {
  const en = html(<IntroSection onNavigate={noop} />);
  assert.match(en, /role="group" aria-label="Language \/ Idioma"/);
  assert.match(en, /<button[^>]*lang="en"[^>]*aria-pressed="true"[^>]*>English<\/button>/);
  assert.match(en, /<button[^>]*lang="es"[^>]*aria-pressed="false"[^>]*>Español<\/button>/);
  assert.match(en, /<div class="max-w-2xl space-y-4" lang="en">/, 'el idioma se declara para lectores de pantalla');
  assert.match(text(en), /Intelligence to protect every drop\./);
  assert.doesNotMatch(text(en), /Inteligencia para proteger cada gota/);
  const es = html(<IntroSection onNavigate={noop} initialLang="es" />);
  assert.match(es, /<button[^>]*lang="es"[^>]*aria-pressed="true"/);
  assert.match(text(es), /Inteligencia para proteger cada gota\./);
  assert.doesNotMatch(text(es), /Intelligence to protect every drop/);
  assert.match(es, /<figure aria-label="Video explicativo de Aqua Sentinel" lang="es"/);
});

test('REQ-PUB-05: sin versión en inglés, English avisa en inglés y no reproduce el video español', () => {
  const h = html(<IntroVideo lang="en" forceState="soon" />);
  const t = text(h);
  assert.match(t, /English version coming soon/);
  assert.doesNotMatch(t, /próximamente|Video explicativo/);
  assert.doesNotMatch(h, /<video|aqua-sentinel-demo/, 'ningún reproductor ni archivo en español');
  assert.match(h, /aria-label="Play the explainer video \(not available yet\)"/);
  assert.match(h, /<img[^>]*src="\/images\/hero-network\.svg"/, 'portada sin texto');
  const ready = html(<IntroVideo lang="en" forceState="ready" forceConfig={parseVideoConfig({ src: '/videos/en.mp4', captions: '/videos/en.vtt' })} />);
  assert.match(ready, /<track[^>]*srcLang="en"|<track[^>]*srclang="en"/i, 'subtítulos declarados en inglés');
  assert.match(ready, /label="English"/);
  assert.match(ready, /aria-label="Play the explainer video"/);
});

test('REQ-PUB-03: si el video no carga, se avisa y se vuelve a la portada', () => {
  const h = html(<IntroVideo forceState="unavailable" />);
  assert.match(text(h), /No se pudo cargar el video/);
  assert.doesNotMatch(h, /<video/);
});

test('REQ-PUB-01: el visitante consulta Incidentes y Órdenes sin recibir ninguna acción de escritura', () => {
  const d = diag({ primaryHypothesis: 'x', potentialImpact: 'y', recommendedAction: 'Reparar la brida', uncertaintyStatement: 'z', missingData: [], alternativeHypotheses: [] } as never);
  const inc = text(html(<IncidentsView {...incidentProps({ diagnoses: [d], role: 'VISITOR' })} />));
  assert.match(inc, /Tu rol \(Visitante\) permite consultar, no decidir/);
  assert.doesNotMatch(inc, /Aceptar y crear la orden|Pedir el diagnóstico|Añadir una foto|Reportar un problema|Cambiar la recomendación|No aplicar/);
  const open = order({ status: 'En Progreso', checklist: [{ id: 'c1', label: 'Aislar el tramo', done: false }], closureEvidence: closedOrder.closureEvidence, requiredResources: [], probableCause: 'Brida', assetName: 'Tubo' });
  const ordHtml = html(<WorkOrdersView {...ordersProps({ workOrders: [open], role: 'VISITOR' })} />);
  assert.match(text(ordHtml), /permite consultar la orden, no modificarla/);
  assert.doesNotMatch(text(ordHtml), /Cerrar la orden|Empezar la intervención|Tomar o añadir la foto|Cambiar la foto|Cambiar/);
  assert.match(ordHtml, /type="checkbox"[^>]*disabled/);
});

test('REQ-PUB-04: las herramientas avanzadas del visitante omiten la pestaña de demostración, que no tendría ninguna acción disponible', () => {
  const visitor = text(html(<AdvancedView tab="sensores" onTab={noop} role="VISITOR"><p>x</p></AdvancedView>));
  assert.doesNotMatch(visitor, /Demostración/);
  for (const label of ['Sensores y series', 'Evidencia visual', 'Registro verificable', 'Conexión e integraciones']) assert.match(visitor, new RegExp(label));
  assert.match(text(html(<AdvancedView tab="sensores" onTab={noop} role="ADMIN"><p>x</p></AdvancedView>)), /Demostración/);
});

test('REQ-UX-04: Avanzado agrupa las herramientas técnicas sin eliminarlas', () => {
  const t = text(html(<AdvancedView tab="ledger" onTab={noop} role="ADMIN"><p>x</p></AdvancedView>));
  for (const label of ['Sensores y series', 'Evidencia visual', 'Registro verificable', 'Conexión e integraciones', 'Demostración']) assert.match(t, new RegExp(label));
});

test('REQ-UX-03: el mapa describe los estados con texto y símbolo, no solo con color, y permite elegir un punto por teclado', () => {
  const nodes = [node({ id: 'N1', name: 'Troncal Norte', status: 'critical', x: 200, y: 100 }), node({ id: 'N2', name: 'Válvula Sur', x: 500, y: 200 })];
  const h = html(<MapView nodes={nodes} pipes={[{ id: 'P1', from: 'N1', to: 'N2', diameterMm: 100, lengthM: 10, material: 'PVC', status: 'nominal' }]} anomalies={[anomaly()]} selectedNodeId="N1" onSelectNode={noop} onOpenIncident={noop} onOpenAdvanced={noop} />);
  const t = text(h);
  for (const s of ['Estable', 'Requiere atención', 'Crítico', 'Pendiente de verificación']) assert.match(t, new RegExp(s));
  assert.match(h, /role="button"[^>]*tabindex="0"|tabindex="0"[^>]*role="button"/);
  assert.match(h, /aria-label="Troncal Norte: crítico, con incidente activo"/);
  assert.match(t, /Lo normal aquí: 4\.50 bar/);
  assert.match(t, /MEDIDO/);
  assert.match(t, /SIMULADO/);
});

test('REQ-UX-05: accesibilidad básica. Toda imagen tiene texto alternativo y todo botón del sistema visual declara su tipo y mide al menos 44 px', () => {
  const pages = [
    html(<IncidentsView {...incidentProps({ visionAnalyses: [{ id: 'V1', timestamp: '2026-06-01T12:05:00.000Z', nodeId: 'N1', anomalyId: 'A1', imageUrl: '/api/evidence/x', imageTitle: 'Foto', providerUsed: 'x', providerMode: 'fallback-adapter', observed: [], inferred: [], cannotDetermine: [], missingData: [], sensorCorrelationSummary: '', analysisStatus: 'not_analyzed' }] as never })} />),
    html(<WorkOrdersView {...ordersProps()} />),
    html(<HomeView {...homeProps({ anomalies: [anomaly()] })} />),
  ];
  for (const h of pages) {
    for (const img of h.match(/<img[^>]*>/g) ?? []) assert.match(img, /alt="[^"]+"/, img);
    for (const b of h.match(/<button[^>]*>/g) ?? []) assert.match(b, /type="button"|type="submit"/, `botón sin tipo: ${b}`);
  }
  assert.match(pages[2], /min-h-11/);
});
