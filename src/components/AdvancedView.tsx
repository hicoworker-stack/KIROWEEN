import React from 'react';
import { ArrowRight, Play, RotateCcw } from 'lucide-react';
import { can, Role } from '../core/permissions';
import { ScenarioDefinition, ScenarioId } from '../core/types';
import { t } from '../ui/i18n';
import { AdvancedTab, roleLabel } from '../ui/vocab';
import { Button, Notice, ProvenanceBadge } from './ui';

const tabs = (): Array<{ id: AdvancedTab; label: string; help: string }> => [
  { id: 'sensores', label: t('Sensores y series', 'Sensors and series'), help: t('Historial de lecturas, carga de datos y reglas que se dispararon.', 'Readings history, data upload and the rules that fired.') },
  { id: 'evidencia', label: t('Evidencia visual', 'Visual evidence'), help: t('Fotografías y su análisis por punto de la red.', 'Photos and their analysis for each point of the network.') },
  { id: 'ledger', label: t('Registro verificable', 'Verifiable record'), help: t('Trust Ledger: cadena criptográfica de todo lo que ocurrió.', 'Trust Ledger: a cryptographic chain of everything that happened.') },
  { id: 'conectividad', label: t('Conexión e integraciones', 'Connection and integrations'), help: t('Reportes guardados, estado del servidor, IA y especificaciones.', 'Saved reports, server status, AI and specifications.') },
  { id: 'demo', label: t('Demostración', 'Demonstration'), help: t('Escenarios simulados para probar el sistema.', 'Simulated scenarios to try the system.') },
];

/** Textos de cada escenario en el idioma activo (los datos del escenario viven en el núcleo, que no depende de la interfaz). */
const scenarioText = (s: ScenarioDefinition): { label: string; title: string } => {
  const map: Record<string, { label: [string, string]; title: [string, string] }> = {
    leak: { label: ['1. Fuga en Troncal', '1. Trunk-main leak'], title: ['Pérdida de caudal en el tramo P-05, de la Troncal Norte a la escuela y el centro de salud', 'Flow loss on reach P-05, from the north trunk main to the school and health center'] },
    obstruction: { label: ['2. Obstrucción Válvula', '2. Valve obstruction'], title: ['Obstrucción progresiva en la Válvula Sur', 'Progressive obstruction at the south valve'] },
    sensor_fault: { label: ['3. Falla de Sensor', '3. Sensor fault'], title: ['Lectura físicamente inconsistente en el Tanque Mirador', 'Physically inconsistent reading at the Mirador tank'] },
    contamination: { label: ['4. Posible Contaminación', '4. Possible contamination'], title: ['Anomalía de calidad en la Bocatoma', 'Water-quality anomaly at the intake'] },
  };
  const m = map[s.id];
  return m ? { label: t(m.label[0], m.label[1]), title: t(m.title[0], m.title[1]) } : { label: s.label, title: s.shortTitle };
};

/** Herramientas para personal técnico. Lo cotidiano vive en Inicio, Mapa, Incidentes y Órdenes. */
export const AdvancedView: React.FC<{ tab: AdvancedTab; onTab: (t: AdvancedTab) => void; role: Role; children: React.ReactNode }> = ({ tab, onTab, role, children }) => {
  // El visitante del modo público no puede lanzar nada: su pestaña de demostración no tendría ninguna acción disponible.
  const shown = tabs().filter((x) => !(x.id === 'demo' && role === 'VISITOR'));
  const current = shown.find((x) => x.id === tab) ?? shown[0];
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">{t('Herramientas avanzadas', 'Advanced tools')}</h1>
        <p className="text-base text-soft">{t('Para revisar el detalle técnico. No hace falta usarlas en el trabajo diario.', 'To review the technical detail. They are not needed for day-to-day work.')}</p>
      </header>
      <div role="tablist" aria-label={t('Herramientas avanzadas', 'Advanced tools')} className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {shown.map((x) => (
          <button
            key={x.id}
            id={`adv-tab-${x.id}`}
            role="tab"
            type="button"
            aria-selected={tab === x.id}
            aria-controls="adv-panel"
            onClick={() => onTab(x.id)}
            className={`min-h-11 shrink-0 cursor-pointer whitespace-nowrap border-b-2 px-4 text-sm font-medium ${tab === x.id ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-ink'}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-quiet">{current.help}</p>
      <div id="adv-panel" role="tabpanel" aria-labelledby={`adv-tab-${current.id}`} className="view-in">
        {children}
      </div>
      <p className="text-xs text-quiet">{t(`Sesión como ${roleLabel(role)}: lo que tu rol no permite está desactivado, y el servidor lo comprueba además en cada acción.`, `Signed in as ${roleLabel(role)}: what your role does not allow is disabled, and the server also checks it on every action.`)}</p>
    </div>
  );
};

export const DemoPanel: React.FC<{
  scenarios: ScenarioDefinition[];
  role: Role;
  busy: boolean;
  onTriggerScenario: (id: ScenarioId) => void;
  onStartDemo: () => void;
  onReset: () => void;
}> = ({ scenarios, role, busy, onTriggerScenario, onStartDemo, onReset }) => {
  const mayScenario = can(role, 'scenario:trigger');
  const mayReset = can(role, 'destructive:reset');
  const mayDemo = can(role, 'destructive:demo');
  return (
    <div className="space-y-8">
      <Notice tone="neutral" title={t('Todo lo de aquí es simulado', 'Everything here is simulated')}>
        {t('Estos escenarios inyectan datos sintéticos en la red de demostración', 'These scenarios inject synthetic data into the demonstration network')} <ProvenanceBadge kind="simulado" />. {t('No existen en una red real.', 'They do not exist in a real network.')}
      </Notice>

      <section aria-labelledby="demo-scen" className="space-y-3">
        <h2 id="demo-scen" className="font-display text-lg font-semibold text-ink">
          {t('Simular un problema', 'Simulate a problem')}
        </h2>
        {!mayScenario && <p className="text-sm text-quiet">{t('Tu rol solo permite consultar. Un operador puede lanzar escenarios.', 'Your role is view-only. An operator can launch scenarios.')}</p>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {scenarios.map((s) => {
            const text = scenarioText(s);
            return (
              <li key={s.id}>
                <button type="button" disabled={busy || !mayScenario} onClick={() => onTriggerScenario(s.id)} className="flex min-h-20 w-full cursor-pointer items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50">
                  <span>
                    <span className="block text-base font-semibold text-ink">{text.label}</span>
                    <span className="mt-1 block text-sm text-soft">{text.title}</span>
                  </span>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-quiet" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="demo-reset" className="space-y-3">
        <h2 id="demo-reset" className="font-display text-lg font-semibold text-ink">
          {t('Empezar de cero', 'Start from scratch')}
        </h2>
        <p className="text-sm text-soft">{t('Estas acciones reinician el estado de la red. El estado anterior se guarda en el servidor y pedimos tu contraseña para confirmar.', 'These actions reset the network state. The previous state is saved on the server and we ask for your password to confirm.')}</p>
        {!mayReset && !mayDemo && <p className="text-sm text-quiet">{t('Solo un administrador puede reiniciar la red.', 'Only an administrator can reset the network.')}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" disabled={busy || !mayDemo} onClick={onStartDemo} icon={<Play className="h-4 w-4" />}>
            {t('Iniciar la demostración guiada', 'Start the guided demonstration')}
          </Button>
          <Button variant="danger" disabled={busy || !mayReset} onClick={onReset} icon={<RotateCcw className="h-4 w-4" />}>
            {t('Volver al estado normal', 'Back to the normal state')}
          </Button>
        </div>
      </section>
    </div>
  );
};
