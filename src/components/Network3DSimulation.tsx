import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, LocateFixed, Pause, Play, RotateCcw, RotateCw, Tags } from 'lucide-react';
import { computeSim, fmt1, LEAK_RANGE, phaseText, SIM_NODES, SIM_PHASES, SimPhase } from '../ui/sim3dModel';
import type { SceneController } from './sim3d/networkScene';
import { Button, ProvenanceBadge, StatusPill } from './ui';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const STEP_MS = 7000;

/**
 * Simulación 3D interactiva del Inicio: una fuga en el tramo P-05, de la operación normal a la recuperación medida.
 * La maqueta (three.js) se carga solo cuando la sección se acerca a la pantalla. Todo el contenido es SIMULADO; las cifras
 * del panel salen del mismo modelo que pinta la escena, así que lo que se ve y lo que se lee coinciden.
 */
export const Network3DSimulation: React.FC<{ initialPhase?: SimPhase }> = ({ initialPhase = 'normal' }) => {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<SceneController | null>(null);
  const [load, setLoad] = useState<LoadState>('idle');
  const [phase, setPhase] = useState<SimPhase>(initialPhase);
  const [leak, setLeak] = useState<number>(LEAK_RANGE.initial);
  const [selected, setSelected] = useState<string | null>('N-TRON-04');
  const [xray, setXray] = useState(true);
  const [labels, setLabels] = useState(true);
  const [playing, setPlaying] = useState(false);

  const sim = useMemo(() => computeSim(phase, leak), [phase, leak]);
  const idx = SIM_PHASES.findIndex((p) => p.id === phase);
  const current = SIM_PHASES[idx];

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
    if (load === 'ready') ctrlRef.current?.update({ sim, selected });
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
  const selReading = sel ? sim.readings[sel.id] : undefined;
  const leakEditable = phase === 'leak' || phase === 'detect';
  const b = sim.balance;

  return (
    <section ref={sectionRef} aria-labelledby="sim3d-title" className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">Simulación 3D interactiva</p>
          <h2 id="sim3d-title" className="font-display text-2xl font-semibold text-ink sm:text-3xl">
            Una fuga en la troncal, de principio a fin
          </h2>
          <p className="text-base leading-relaxed text-soft">Gira la maqueta, acércate y toca cualquier sensor. Avanza por los pasos para ver el problema y cómo lo resuelve Aqua Sentinel.</p>
        </div>
        <ProvenanceBadge kind="simulado" />
      </header>

      {/* Pasos */}
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Pasos de la simulación">
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
          aria-label="Maqueta 3D de la red San Cristóbal de las Aguas. Arrastra para girar, usa la rueda o pellizca para acercar. Las lecturas están en el panel."
          className="relative h-[24rem] overflow-hidden rounded-2xl border border-line bg-[radial-gradient(ellipse_at_top,#0f2736_0%,#06131c_70%)] sm:h-[30rem] lg:sticky lg:top-20 lg:h-[38rem]"
        >
          <div ref={hostRef} className="absolute inset-0" />

          {load !== 'ready' && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              {load === 'error' ? (
                <p className="max-w-sm text-sm text-soft">Tu navegador no puede mostrar la maqueta 3D (WebGL no está disponible). Las lecturas del panel siguen funcionando.</p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-quiet" aria-live="polite">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" /> Cargando la maqueta 3D…
                </p>
              )}
            </div>
          )}

          {/* Herramientas de vista */}
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            <ToolButton label="Girar a la izquierda" onClick={() => ctrlRef.current?.rotate(-Math.PI / 8)} disabled={load !== 'ready'}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Girar a la derecha" onClick={() => ctrlRef.current?.rotate(Math.PI / 8)} disabled={load !== 'ready'}>
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Volver a la vista general" onClick={() => ctrlRef.current?.resetView()} disabled={load !== 'ready'}>
              <LocateFixed className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Ver bajo tierra" pressed={xray} onClick={() => setXray((v) => !v)} disabled={load !== 'ready'}>
              <Layers className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Mostrar etiquetas" pressed={labels} onClick={() => setLabels((v) => !v)} disabled={load !== 'ready'}>
              <Tags className="h-4 w-4" aria-hidden="true" />
            </ToolButton>
          </div>

          <p className="pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-canvas/90 to-transparent px-4 pb-3 pt-8 text-xs text-soft sm:block">
            Arrastra para girar · rueda o pellizco para acercar · clic derecho o dos dedos para desplazar · toca un sensor para ver sus lecturas
          </p>
        </div>

        {/* Panel */}
        <aside aria-label="Lecturas de la simulación" className="flex flex-col gap-4 rounded-2xl border border-line bg-surface/60 p-4 sm:p-5">
          <div className="space-y-1.5" aria-live="polite">
            <p className="text-[11px] font-bold tracking-widest text-accent">
              PASO {idx + 1} DE {SIM_PHASES.length} · {current.label.toUpperCase()}
            </p>
            <h3 className="font-display text-lg font-semibold leading-snug text-ink">{current.title}</h3>
            <p className="text-sm leading-relaxed text-soft">{phaseText(sim)}</p>
          </div>

          <label className={`block space-y-1.5 ${leakEditable ? '' : 'opacity-50'}`}>
            <span className="flex items-center justify-between text-xs font-medium text-soft">
              Tamaño de la fuga <span className="tabular-nums text-ink">{fmt1(leak)} L/s</span>
            </span>
            <input
              type="range"
              min={LEAK_RANGE.min}
              max={LEAK_RANGE.max}
              step={LEAK_RANGE.step}
              value={leak}
              disabled={!leakEditable}
              onChange={(e) => setLeak(Number(e.target.value))}
              className="w-full cursor-pointer accent-[#22d3ee] disabled:cursor-not-allowed"
              aria-describedby="sim3d-leak-help"
            />
            <span id="sim3d-leak-help" className="block text-[11px] text-quiet">
              {leakEditable ? 'Mueve el control y mira cómo cambian la presión y el balance.' : 'Se puede ajustar en los pasos 2 y 3.'}
            </span>
          </label>

          {/* Balance de masa */}
          <div className="rounded-xl border border-line bg-canvas/50 p-3">
            <p className="mb-2 text-xs font-semibold text-soft">Balance de agua del tramo P-05</p>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div>
                <dt className="text-[11px] text-quiet">Entra</dt>
                <dd className="font-display text-lg font-semibold tabular-nums text-ink">{fmt1(b.inflowLps)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-quiet">Llega</dt>
                <dd className="font-display text-lg font-semibold tabular-nums text-ink">{fmt1(b.deliveredLps)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-quiet">Falta</dt>
                <dd className={`font-display text-lg font-semibold tabular-nums ${b.detectable ? 'text-critical' : 'text-ink'}`}>{fmt1(b.missingLps)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[11px] text-quiet">L/s · incertidumbre de los medidores ± {fmt1(b.uncertaintyLps)} L/s</p>
          </div>

          {/* Sensores */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-soft">Sensores</p>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {SIM_NODES.map((n) => {
                const r = sim.readings[n.id];
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
                        <span className="tabular-nums text-soft">{r.pressureM !== null ? `${fmt1(r.pressureM)} m` : `${fmt1(r.flowLps)} L/s`}</span>
                        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT[r.tone]}`} />
                        <span className="sr-only">{r.statusLabel}</span>
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
                  <dt className="text-quiet">Presión</dt>
                  <dd className="tabular-nums text-ink">{selReading.pressureM !== null ? `${fmt1(selReading.pressureM)} m c.a.` : 'No se mide aquí'}</dd>
                </div>
                <div>
                  <dt className="text-quiet">Caudal</dt>
                  <dd className="tabular-nums text-ink">{fmt1(selReading.flowLps)} L/s</dd>
                </div>
              </dl>
              {selReading.note && <p className="text-xs text-soft">{selReading.note}</p>}
            </div>
          )}

          <div className="mt-auto flex items-center gap-2 pt-1">
            <Button variant="ghost" onClick={() => (setPlaying(false), goTo(SIM_PHASES[Math.max(0, idx - 1)].id))} disabled={idx === 0} aria-label="Paso anterior" icon={<ChevronLeft className="h-4 w-4" />} />
            <Button variant="primary" className="flex-1" onClick={togglePlay} icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}>
              {playing ? 'Pausar recorrido' : idx >= SIM_PHASES.length - 1 ? 'Ver de nuevo' : 'Reproducir recorrido'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => (setPlaying(false), goTo(SIM_PHASES[Math.min(SIM_PHASES.length - 1, idx + 1)].id))}
              disabled={idx >= SIM_PHASES.length - 1}
              aria-label="Paso siguiente"
              icon={<ChevronRight className="h-4 w-4" />}
            />
          </div>
        </aside>
      </div>
    </section>
  );
};

const DOT: Record<'ok' | 'attention' | 'critical' | 'offline', string> = { ok: 'bg-ok', attention: 'bg-attention', critical: 'bg-critical', offline: 'bg-offline' };

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
