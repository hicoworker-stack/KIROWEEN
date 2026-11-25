import { tr } from '../ui/engineText';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, LocateFixed, Pause, Play, RotateCcw, RotateCw, Tags } from 'lucide-react';
import { LeakPreview, PREVIEW_LEAK_RANGE, PreviewRepairMode } from '../core/leakPreview';
import { explainRepair } from '../ui/repairView';
import { buildSimView, ENGINE_LEVEL_LABEL, fmt1, fmt2, OUTCOME_LABEL, phaseText, SIM_NODES, SIM_PHASES, SimPhase, SimTone } from '../ui/sim3dModel';
import { t } from '../ui/i18n';
import type { SceneController } from './sim3d/networkScene';
import { Button, Disclosure, Notice, ProvenanceBadge, StatusPill } from './ui';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const STEP_MS = 7000;
const repairChoices = (): Array<{ id: PreviewRepairMode; label: string; help: string }> => [
  { id: 'repaired', label: t('La reparación funcionó', 'The repair worked'), help: t('3 mediciones normales', '3 normal measurements') },
  { id: 'unresolved', label: t('El problema persiste', 'The problem persists'), help: t('2 mediciones anómalas', '2 anomalous measurements') },
  { id: 'sparse', label: t('Llega una sola medición', 'Only one measurement arrives'), help: t('1 medición normal', '1 normal measurement') },
];

/**
 * Simulación 3D interactiva del Inicio: una fuga en el tramo P-05, de la operación normal a la verificación de la reparación.
 *
 * La maqueta (three.js) se carga solo cuando la sección se acerca a la pantalla. NADA de lo que muestra está calculado aquí:
 * cada cifra y cada conclusión vienen de /api/preview/leak, que ejecuta los motores reales del proyecto con datos SINTÉTICOS.
 * Si el servidor no responde, no se inventan resultados: se avisa.
 */
export const Network3DSimulation: React.FC<{ initialPhase?: SimPhase }> = ({ initialPhase = 'normal' }) => {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<SceneController | null>(null);
  const [load, setLoad] = useState<LoadState>('idle');
  const [phase, setPhase] = useState<SimPhase>(initialPhase);
  const [leak, setLeak] = useState<number>(PREVIEW_LEAK_RANGE.initial);
  const [mode, setMode] = useState<PreviewRepairMode>('repaired');
  const [preview, setPreview] = useState<LeakPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [selected, setSelected] = useState<string | null>('N-TRON-04');
  const [xray, setXray] = useState(true);
  // En pantallas estrechas las siete etiquetas se pisan y se salen del lienzo: arrancan ocultas (el botón las muestra).
  const [labels, setLabels] = useState(() => typeof window === 'undefined' || window.innerWidth >= 640);
  const [playing, setPlaying] = useState(false);

  const sim = useMemo(() => (preview ? buildSimView(phase, preview) : null), [phase, preview]);
  const idx = SIM_PHASES.findIndex((p) => p.id === phase);
  const current = SIM_PHASES[idx];

  // Resultados de los motores: se piden al servidor (con un pequeño retraso mientras se mueve el control) y se cancelan si cambian.
  useEffect(() => {
    if (typeof fetch === 'undefined') return;
    const ac = new AbortController();
    const timer = setTimeout(
      async () => {
        try {
          const res = await fetch(`/api/preview/leak?leakLps=${leak}&repair=${mode}`, { credentials: 'same-origin', signal: ac.signal });
          if (!res.ok) throw new Error(String(res.status));
          setPreview((await res.json()) as LeakPreview);
          setPreviewError(false);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') setPreviewError(true);
        }
      },
      preview ? 180 : 0
    );
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // `preview` solo decide el retraso inicial; no debe relanzar la petición.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leak, mode]);

  // Carga diferida: three.js solo se descarga cuando la sección está cerca de la pantalla.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || load !== 'idle') return;
    if (typeof IntersectionObserver === 'undefined') {
      setLoad('loading');
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLoad('loading'), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [load]);

  useEffect(() => {
    if (load !== 'loading') return;
    let alive = true;
    (async () => {
      try {
        const { createNetworkScene } = await import('./sim3d/networkScene');
        if (!alive || !hostRef.current) return;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        ctrlRef.current = createNetworkScene(hostRef.current, { onSelect: setSelected, reducedMotion });
        setLoad('ready');
      } catch {
        if (alive) setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(
    () => () => {
      ctrlRef.current?.dispose();
      ctrlRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (load === 'ready' && sim) ctrlRef.current?.update({ sim, selected });
  }, [load, sim, selected]);
  useEffect(() => {
    if (load === 'ready') ctrlRef.current?.setXray(xray);
  }, [load, xray]);
  useEffect(() => {
    if (load === 'ready') ctrlRef.current?.setLabels(labels);
  }, [load, labels]);

  const goTo = useCallback((p: SimPhase) => {
    setPhase(p);
    if (p === 'leak' || p === 'detect' || p === 'repair') setSelected((s) => s ?? 'N-DIST-06');
    ctrlRef.current?.focus(p);
  }, []);

  // Recorrido automático: avanza un paso cada STEP_MS y se detiene al final.
  useEffect(() => {
    if (!playing) return;
    if (idx >= SIM_PHASES.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => goTo(SIM_PHASES[idx + 1].id), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, idx, goTo]);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (idx >= SIM_PHASES.length - 1) goTo(SIM_PHASES[0].id);
    setPlaying(true);
  };

  const sel = selected ? SIM_NODES.find((n) => n.id === selected) : undefined;
  const selReading = sel && sim ? sim.readings[sel.id] : undefined;
  const leakEditable = phase === 'leak' || phase === 'detect';
  const modeEditable = phase === 'verified';
  const engine = sim?.engine;
  const showEngine = Boolean(sim) && (phase === 'detect' || phase === 'repair' || phase === 'verified');

  return (
    <section ref={sectionRef} aria-labelledby="sim3d-title" className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">{t('Simulación 3D interactiva', 'Interactive 3D simulation')}</p>
          <h2 id="sim3d-title" className="font-display text-2xl font-semibold text-ink sm:text-3xl">
            {t('Una fuga en la troncal, de principio a fin', 'A trunk-main leak, from start to finish')}
          </h2>
          <p className="text-base leading-relaxed text-soft">{t('Gira la maqueta y toca cualquier sensor. Cada cifra la calculan los motores reales del proyecto: la IA propone, la física contrasta y la evidencia demuestra.', 'Rotate the model and tap any sensor. Every figure is computed by the project’s real engines: the AI proposes, the physics checks, the evidence proves.')}</p>
        </div>
        <ProvenanceBadge kind="simulado" />
      </header>

      {/* Pasos */}
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label={t('Pasos de la simulación', 'Simulation steps')}>
        {SIM_PHASES.map((p, i) => {
          const active = p.id === phase;
          const done = i < idx;
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                onClick={() => {
                  setPlaying(false);
                  goTo(p.id);
                }}
                className={`flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 text-left text-sm transition-colors ${
                  active ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-surface/60 text-soft hover:border-line-strong hover:text-ink'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums ${
                    active ? 'bg-accent text-[#041018]' : done ? 'bg-accent/25 text-accent' : 'bg-raised text-quiet'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="font-medium leading-tight">{p.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Maqueta */}
        <div
          role="group"
          aria-label={t('Maqueta 3D de la red San Cristóbal de las Aguas. Arrastra para girar, usa la rueda o pellizca para acercar. Las lecturas están en el panel.', '3D model of the San Cristóbal de las Aguas network. Drag to rotate, use the wheel or pinch to zoom. Readings are in the panel.')}
          className="relative h-[24rem] overflow-hidden rounded-2xl border border-line bg-[radial-gradient(ellipse_at_top,#0f2736_0%,#06131c_70%)] sm:h-[30rem] lg:sticky lg:top-20 lg:h-[38rem]"
        >
          <div ref={hostRef} className="absolute inset-0" />

          {(load !== 'ready' || !sim) && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              {load === 'error' ? (
                <p className="max-w-sm text-sm text-soft">{t('Tu navegador no puede mostrar la maqueta 3D (WebGL no está disponible). Las lecturas del panel siguen funcionando.', 'Your browser cannot show the 3D model (WebGL is not available). The readings in the panel still work.')}</p>
              ) : previewError && !sim ? (
                <p className="max-w-sm text-sm text-soft">{t('La maqueta necesita el servidor para calcular con los motores reales. No se muestran resultados de respaldo.', 'The model needs the server to compute with the real engines. No fallback results are shown.')}</p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-quiet" aria-live="polite">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" /> {t('Cargando la maqueta 3D…', 'Loading the 3D model…')}
                </p>
              )}
            </div>
          )}

          {/* Herramientas de vista */}
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            <ToolButton label={t('Girar a la izquierda', 'Rotate left')} onClick={() => ctrlRef.current?.rotate(-Math.PI / 8)} disabled={load !== 'ready'}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t('Girar a la derecha', 'Rotate right')} onClick={() => ctrlRef.current?.rotate(Math.PI / 8)} disabled={load !== 'ready'}>
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t('Volver a la vista general', 'Back to the overview')} onClick={() => ctrlRef.current?.resetView()} disabled={load !== 'ready'}>
              <LocateFixed className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t('Ver bajo tierra', 'See underground')} pressed={xray} onClick={() => setXray((v) => !v)} disabled={load !== 'ready'}>
              <Layers className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t('Mostrar etiquetas', 'Show labels')} pressed={labels} onClick={() => setLabels((v) => !v)} disabled={load !== 'ready'}>
              <Tags className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
          </div>

          <p className="pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-canvas/90 to-transparent px-4 pb-3 pt-8 text-xs text-soft sm:block">
            {t('Arrastra para girar · rueda o pellizco para acercar · clic derecho o dos dedos para desplazar · toca un sensor para ver sus lecturas', 'Drag to rotate · wheel or pinch to zoom · right click or two fingers to pan · tap a sensor to see its readings')}
          </p>
        </div>

        {/* Panel */}
        <aside aria-label={t('Lecturas de la simulación', 'Simulation readings')} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface/60 p-4 sm:p-5">
          <div className="space-y-1.5" aria-live="polite">
            <p className="text-[11px] font-bold tracking-widest text-accent">
              {t('PASO', 'STEP')} {idx + 1} {t('DE', 'OF')} {SIM_PHASES.length} · {current.label.toUpperCase()}
            </p>
            <h3 className="font-display text-lg font-semibold leading-snug text-ink">{current.title}</h3>
            <p className="text-sm leading-relaxed text-soft">{sim && preview ? phaseText(sim, preview) : t('Calculando con los motores del servidor…', 'Computing with the server’s engines…')}</p>
          </div>

          {previewError && sim && (
            <Notice tone="attention" title={t('No se pudo actualizar', 'Could not update')}>
              {t('El servidor no respondió. Se conserva el último resultado calculado.', 'The server did not respond. The last computed result is kept.')}
            </Notice>
          )}

          {/* Controles: cada uno solo actúa en el paso al que pertenece */}
          <label className={`block space-y-1.5 ${leakEditable ? '' : 'opacity-50'}`}>
            <span className="flex items-center justify-between text-xs font-medium text-soft">
              {t('Tamaño de la fuga simulada', 'Simulated leak size')} <span className="tabular-nums text-ink">{fmt1(leak)} L/s</span>
            </span>
            <input
              type="range"
              min={PREVIEW_LEAK_RANGE.min}
              max={PREVIEW_LEAK_RANGE.max}
              step={PREVIEW_LEAK_RANGE.step}
              value={leak}
              disabled={!leakEditable}
              onChange={(e) => setLeak(Number(e.target.value))}
              className="w-full cursor-pointer accent-[#22d3ee] disabled:cursor-not-allowed"
              aria-describedby="sim3d-leak-help"
            />
            <span id="sim3d-leak-help" className="block text-[11px] text-quiet">
              {leakEditable ? t('Mueve el control: el motor decide con cada tamaño si ve una fuga, una anomalía o nada.', 'Move the slider: at each size the engine decides whether it sees a leak, an anomaly or nothing.') : t('Se puede ajustar en los pasos Anomalía e Investigación.', 'It can be adjusted in the Anomaly and Investigation steps.')}
            </span>
          </label>

          <fieldset className={`space-y-1.5 ${modeEditable ? '' : 'opacity-50'}`} disabled={!modeEditable}>
            <legend className="text-xs font-medium text-soft">{t('¿Qué pasa después de reparar?', 'What happens after the repair?')}</legend>
            <div className="grid grid-cols-1 gap-1.5">
              {repairChoices().map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={mode === c.id}
                  onClick={() => setMode(c.id)}
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm disabled:cursor-not-allowed ${mode === c.id ? 'border-accent bg-accent/10 text-ink' : 'border-line text-soft hover:border-line-strong hover:text-ink'}`}
                >
                  <span>{c.label}</span>
                  <span className="text-xs text-quiet">{c.help}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {/* Qué concluye el motor */}
          {showEngine && engine && sim && (
            <div className="space-y-2 rounded-xl border border-line bg-canvas/50 p-3" data-engine-level={engine.level}>
              <p className="text-xs font-semibold text-soft">{phase === 'verified' ? t('Veredicto de la reparación', 'Repair verdict') : t('Lo que concluye el motor hidráulico', 'What the hydraulic engine concludes')}</p>
              {phase === 'verified' ? (
                <>
                  <p className="flex items-center gap-2 font-display text-lg font-semibold text-ink" data-repair-outcome={sim.repair.outcome}>
                    <StatusPill tone={sim.repair.outcome === 'VERIFIED' ? 'ok' : sim.repair.outcome === 'REOPENED' ? 'critical' : 'verifying'} label={OUTCOME_LABEL[sim.repair.outcome]} />
                  </p>
                  <p className="text-xs text-soft">
                    {explainRepair(sim.repair)}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-display text-base font-semibold text-ink">{ENGINE_LEVEL_LABEL[engine.level]}</p>
                  {engine.balance && (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-quiet">{t('Entra en la Troncal', 'Enters the trunk main')}</dt>
                      <dd className="text-right tabular-nums text-ink">{fmt1(engine.balance.inflowLs)} L/s</dd>
                      <dt className="text-quiet">{t('Sale hacia aguas abajo', 'Leaves downstream')}</dt>
                      <dd className="text-right tabular-nums text-ink">{fmt1(engine.balance.outflowLs)} L/s</dd>
                      <dt className="text-quiet">{t('Consumo local esperado', 'Expected local use')}</dt>
                      <dd className="text-right tabular-nums text-ink">{fmt1(engine.balance.expectedLocalLs)} L/s</dd>
                      <dt className="font-semibold text-soft">{t('Exceso', 'Excess')}</dt>
                      <dd className={`text-right font-semibold tabular-nums ${engine.level === 'localized_leak' || engine.level === 'possible_leak' ? 'text-critical' : 'text-ink'}`}>
                        {fmt1(engine.balance.excessLs)} ± {fmt1(engine.balance.sigmaLs)} L/s
                      </dd>
                      <dt className="text-quiet">{t('Límite de detección', 'Detection limit')}</dt>
                      <dd className="text-right tabular-nums text-ink">{fmt1(engine.balance.detectionLimitLs)} L/s</dd>
                    </dl>
                  )}
                  {engine.rationale.length > 0 && (
                    <Disclosure summary={t('Cómo llegó el motor a esto (registro del motor)', 'How the engine got here (engine log)')}>
                      <ul className="list-disc space-y-1 pl-4 text-xs text-soft">
                        {engine.rationale.slice(0, 4).map((r, i) => (
                          <li key={i}>{tr(r)}</li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </>
              )}
            </div>
          )}

          {/* Sensores */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-soft">{t('Sensores', 'Sensors')}</p>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {SIM_NODES.map((n) => {
                const r = sim?.readings[n.id];
                const active = selected === n.id;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelected(active ? null : n.id)}
                      className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-accent/10' : 'hover:bg-raised/60'}`}
                    >
                      <span className="min-w-0 truncate text-ink">{n.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {r ? (
                          <>
                            <span className="tabular-nums text-soft">{fmt2(r.pressureBar)} bar</span>
                            <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT[r.tone]}`} />
                            <span className="sr-only">{r.statusLabel}</span>
                          </>
                        ) : (
                          <span className="text-xs text-quiet">…</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {sel && selReading && (
            <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink">{sel.name}</p>
                <StatusPill tone={selReading.tone} label={selReading.statusLabel} />
              </div>
              <p className="text-xs text-soft">{sel.role}</p>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-quiet">{t('Presión', 'Pressure')} ({t('lo normal', 'normal')}: {fmt2(selReading.baselinePressureBar)})</dt>
                  <dd className="tabular-nums text-ink">{fmt2(selReading.pressureBar)} bar</dd>
                </div>
                <div>
                  <dt className="text-quiet">{t('Caudal', 'Flow')} ({t('lo normal', 'normal')}: {fmt1(selReading.baselineFlowLs)})</dt>
                  <dd className="tabular-nums text-ink">{fmt1(selReading.flowLs)} L/s</dd>
                </div>
              </dl>
              {selReading.note && <p className="text-xs text-soft">{selReading.note}</p>}
            </div>
          )}

          <div className="mt-auto flex items-center gap-2 pt-1">
            <Button variant="ghost" onClick={() => (setPlaying(false), goTo(SIM_PHASES[Math.max(0, idx - 1)].id))} disabled={idx === 0} aria-label={t('Paso anterior', 'Previous step')} icon={<ChevronLeft className="h-4 w-4" />} />
            <Button variant="primary" className="flex-1" onClick={togglePlay} icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}>
              {playing ? t('Pausar recorrido', 'Pause the tour') : idx >= SIM_PHASES.length - 1 ? t('Ver de nuevo', 'Watch again') : t('Reproducir recorrido', 'Play the tour')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => (setPlaying(false), goTo(SIM_PHASES[Math.min(SIM_PHASES.length - 1, idx + 1)].id))}
              disabled={idx >= SIM_PHASES.length - 1}
              aria-label={t('Paso siguiente', 'Next step')}
              icon={<ChevronRight className="h-4 w-4" />}
            />
          </div>
        </aside>
      </div>
    </section>
  );
};

const DOT: Record<SimTone, string> = { ok: 'bg-ok', attention: 'bg-attention', critical: 'bg-critical', offline: 'bg-offline' };

const ToolButton: React.FC<{ label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: React.ReactNode }> = ({ label, onClick, pressed, disabled, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
    className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border backdrop-blur-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      pressed ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line-strong bg-canvas/70 text-soft hover:text-ink'
    }`}
  >
    {children}
  </button>
);
