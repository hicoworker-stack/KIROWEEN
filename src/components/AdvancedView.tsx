import React from 'react';
import { ArrowRight, Play, RotateCcw } from 'lucide-react';
import { can, Role, ROLE_LABEL } from '../core/permissions';
import { ScenarioDefinition, ScenarioId } from '../core/types';
import { AdvancedTab } from '../ui/vocab';
import { Button, Notice, ProvenanceBadge } from './ui';

const TABS: Array<{ id: AdvancedTab; label: string; help: string }> = [
  { id: 'sensores', label: 'Sensores y series', help: 'Historial de lecturas, carga de datos y reglas que se dispararon.' },
  { id: 'evidencia', label: 'Evidencia visual', help: 'Fotografías y su análisis por punto de la red.' },
  { id: 'ledger', label: 'Registro verificable', help: 'Trust Ledger: cadena criptográfica de todo lo que ocurrió.' },
  { id: 'conectividad', label: 'Conexión e integraciones', help: 'Reportes guardados, estado del servidor, IA y especificaciones.' },
  { id: 'demo', label: 'Demostración', help: 'Escenarios simulados para probar el sistema.' },
];

/** Herramientas para personal técnico. Lo cotidiano vive en Inicio, Mapa, Incidentes y Órdenes. */
export const AdvancedView: React.FC<{ tab: AdvancedTab; onTab: (t: AdvancedTab) => void; role: Role; children: React.ReactNode }> = ({ tab, onTab, role, children }) => {
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">Herramientas avanzadas</h1>
        <p className="text-base text-soft">Para revisar el detalle técnico. No hace falta usarlas en el trabajo diario.</p>
      </header>
      <div role="tablist" aria-label="Herramientas avanzadas" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`adv-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls="adv-panel"
            onClick={() => onTab(t.id)}
            className={`min-h-11 shrink-0 cursor-pointer whitespace-nowrap border-b-2 px-4 text-sm font-medium ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-quiet">{current.help}</p>
      <div id="adv-panel" role="tabpanel" aria-labelledby={`adv-tab-${current.id}`} className="view-in">
        {children}
      </div>
      <p className="text-xs text-quiet">Sesión como {ROLE_LABEL[role]}: lo que tu rol no permite está desactivado, y el servidor lo comprueba además en cada acción.</p>
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
      <Notice tone="neutral" title="Todo lo de aquí es simulado">
        Estos escenarios inyectan datos sintéticos en la red de demostración <ProvenanceBadge kind="simulado" />. No existen en una red real.
      </Notice>

      <section aria-labelledby="demo-scen" className="space-y-3">
        <h2 id="demo-scen" className="font-display text-lg font-semibold text-ink">
          Simular un problema
        </h2>
        {!mayScenario && <p className="text-sm text-quiet">Tu rol solo permite consultar. Un operador puede lanzar escenarios.</p>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {scenarios.map((s) => (
            <li key={s.id}>
              <button type="button" disabled={busy || !mayScenario} onClick={() => onTriggerScenario(s.id)} className="flex min-h-20 w-full cursor-pointer items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50">
                <span>
                  <span className="block text-base font-semibold text-ink">{s.label}</span>
                  <span className="mt-1 block text-sm text-soft">{s.shortTitle}</span>
                </span>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-quiet" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="demo-reset" className="space-y-3">
        <h2 id="demo-reset" className="font-display text-lg font-semibold text-ink">
          Empezar de cero
        </h2>
        <p className="text-sm text-soft">Estas acciones reinician el estado de la red. El estado anterior se guarda en el servidor y pedimos tu contraseña para confirmar.</p>
        {!mayReset && !mayDemo && <p className="text-sm text-quiet">Solo un administrador puede reiniciar la red.</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" disabled={busy || !mayDemo} onClick={onStartDemo} icon={<Play className="h-4 w-4" />}>
            Iniciar la demostración guiada
          </Button>
          <Button variant="danger" disabled={busy || !mayReset} onClick={onReset} icon={<RotateCcw className="h-4 w-4" />}>
            Volver al estado normal
          </Button>
        </div>
      </section>
    </div>
  );
};
