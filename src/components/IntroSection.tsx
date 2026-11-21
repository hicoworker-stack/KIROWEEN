import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clapperboard, Play } from 'lucide-react';
import { DEFAULT_CONFIG_URL, IntroVideoConfig, parseVideoConfig, resolveVideoState, VideoState } from '../ui/introVideo';
import { Button } from './ui';

export const HERO_TITLE = 'Inteligencia para proteger cada gota.';
export const HERO_SUBTITLE = 'Detectamos anomalías, analizamos infraestructuras de agua y transformamos información en acciones verificables.';

/* ───────────── A. Encabezado ───────────── */

/** Burbujas decorativas del fondo: posiciones y tiempos fijos (sin azar, para que no haya diferencias entre cargas). */
const BUBBLES = [
  { x: '8%', s: 10, delay: '0s', dur: '19s' },
  { x: '22%', s: 16, delay: '6s', dur: '23s' },
  { x: '37%', s: 8, delay: '12s', dur: '21s' },
  { x: '52%', s: 14, delay: '3s', dur: '25s' },
  { x: '66%', s: 9, delay: '9s', dur: '20s' },
  { x: '79%', s: 18, delay: '15s', dur: '27s' },
  { x: '91%', s: 11, delay: '5s', dur: '22s' },
].map((b) => ({ ...b, s: `${b.s}px` }));

export const Hero: React.FC<{ as?: 'h1' | 'h2'; children?: React.ReactNode }> = ({ as: Heading = 'h1', children }) => (
  <section aria-labelledby="hero-title" className="relative isolate overflow-hidden rounded-2xl bg-surface bg-[url('/images/hero-network.svg')] bg-cover bg-center">
    <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-canvas via-canvas/80 to-canvas/10" />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {BUBBLES.map((b, i) => (
        <span key={i} className="hero-bubble" style={{ left: b.x, width: b.s, height: b.s, animationDelay: b.delay, animationDuration: b.dur }} />
      ))}
    </div>
    <div className={children ? 'grid items-center gap-8 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-2 lg:gap-12' : 'px-6 py-12 sm:px-10 sm:py-16'}>
<div className="max-w-2xl space-y-4">
      <p className="flex items-center gap-2.5 font-display text-base font-semibold tracking-tight text-accent">
        <img src="/images/logo.png" alt="" width="96" height="96" className="logo-float h-20 w-20 object-contain sm:h-24 sm:w-24" />
        Aqua Sentinel
      </p>
      <Heading id="hero-title" className="font-display text-3xl font-semibold leading-tight text-ink sm:text-4xl xl:text-5xl">
        {HERO_TITLE}
      </Heading>
      <p className="text-base leading-relaxed text-soft sm:text-lg">{HERO_SUBTITLE}</p>
    </div>
    {children}
    </div>
  </section>
);

/* ───────────── B. Video explicativo ───────────── */

/**
 * Video bajo demanda. Nunca se reproduce solo y nunca se simula: si el archivo no existe muestra la portada con el aviso
 * «Video explicativo próximamente». El archivo y la portada se configuran en public/config/intro-video.json.
 */
export const IntroVideo: React.FC<{ configUrl?: string; forceState?: VideoState; forceConfig?: IntroVideoConfig }> = ({ configUrl = DEFAULT_CONFIG_URL, forceState, forceConfig }) => {
  const [config, setConfig] = useState<IntroVideoConfig>(forceConfig ?? parseVideoConfig(null));
  const [state, setState] = useState<VideoState>(forceState ?? 'loading');
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (forceState) return;
    let alive = true;
    (async () => {
      let cfg = parseVideoConfig(null);
      try {
        const r = await fetch(configUrl, { cache: 'no-store' });
        if (r.ok && /json/i.test(r.headers.get('content-type') ?? '')) cfg = parseVideoConfig(await r.json());
      } catch {
        /* sin configuración: portada y "próximamente" */
      }
      let type: string | null | 'error' = null;
      if (cfg.src && cfg.enabled && !cfg.external) {
        try {
          const head = await fetch(cfg.src, { method: 'HEAD', cache: 'no-store' });
          type = head.ok ? head.headers.get('content-type') : null;
        } catch {
          type = 'error';
        }
      }
      if (!alive) return;
      setConfig(cfg);
      setState(resolveVideoState(cfg, type));
    })();
    return () => {
      alive = false;
    };
  }, [configUrl, forceState]);

  const play = () => {
    setStarted(true);
    void ref.current?.play().catch(() => setStarted(false));
  };
  const ready = state === 'ready';
  const showPoster = !ready;

  return (
    <figure aria-label="Video explicativo de Aqua Sentinel" className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-surface">
        {ready ? (
          <video
            ref={ref}
            className="absolute inset-0 h-full w-full bg-black object-contain"
            src={config.src ?? undefined}
            poster={config.poster}
            preload="none"
            playsInline
            controls={started}
            aria-label={config.title}
            onPlay={() => setStarted(true)}
            onError={() => {
              setState('unavailable');
              setStarted(false);
            }}
          >
            {config.captions && <track kind="captions" srcLang="es" label="Español" src={config.captions} default />}
          </video>
        ) : (
          <img src={config.poster} alt="Portada del video explicativo: una gota de agua sobre una red de tuberías y el nombre Aqua Sentinel" className="absolute inset-0 h-full w-full object-cover" />
        )}

        {/* Botón de reproducción: activo solo si de verdad hay un video. */}
        {!started && state !== 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-canvas/50 via-transparent to-transparent">
            {ready ? (
              <button
                type="button"
                onClick={play}
                aria-label="Reproducir el video explicativo"
                className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-full bg-accent text-[#041018] shadow-xl shadow-black/40 ring-8 ring-accent/20 transition-transform hover:scale-105 sm:h-24 sm:w-24"
              >
                <Play className="ml-1 h-9 w-9 fill-current sm:h-11 sm:w-11" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-label="Reproducir el video explicativo (todavía no disponible)"
                title="El video se publicará pronto"
                className="flex h-20 w-20 cursor-not-allowed items-center justify-center rounded-full border border-white/30 bg-white/10 text-white/70 backdrop-blur-sm sm:h-24 sm:w-24"
              >
                <Play className="ml-1 h-9 w-9 sm:h-11 sm:w-11" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {showPoster && state !== 'loading' && (
          <p className="absolute bottom-3 left-3 inline-flex items-center gap-2 rounded-full bg-canvas/80 px-3 py-1.5 text-xs font-medium text-soft backdrop-blur-sm sm:bottom-4 sm:left-4">
            <Clapperboard className="h-3.5 w-3.5" aria-hidden="true" />
            {state === 'unavailable' ? 'No se pudo cargar el video' : 'Video explicativo próximamente'}
          </p>
        )}
      </div>
      <figcaption className="sr-only">{config.title}</figcaption>
    </figure>
  );
};

/* ───────────── C. Cómo funciona ───────────── */

const SKETCH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Bocetos técnicos de una sola línea, a juego con el mapa. */
const SKETCHES: Record<string, React.ReactNode> = {
  captura: (
    <>
      <path d="M6 44H58" {...SKETCH} />
      <path d="M6 36H58" {...SKETCH} />
      <circle cx="32" cy="18" r="11" {...SKETCH} />
      <path d="M32 18L38 12" {...SKETCH} />
      <path d="M32 29V36" {...SKETCH} />
      <path d="M44 8l6 3M46 14h7" {...SKETCH} opacity="0.6" />
    </>
  ),
  deteccion: (
    <>
      <path d="M6 10V50H58" {...SKETCH} />
      <path d="M10 38L20 36L28 39L35 34L40 12L46 40L56 37" {...SKETCH} />
      <path d="M40 8V14" {...SKETCH} opacity="0.6" />
      <circle cx="40" cy="12" r="3" {...SKETCH} />
    </>
  ),
  analisis: (
    <>
      <circle cx="24" cy="26" r="14" {...SKETCH} />
      <circle cx="40" cy="26" r="14" {...SKETCH} />
      <circle cx="32" cy="38" r="14" {...SKETCH} />
      <circle cx="32" cy="30" r="2.5" {...SKETCH} />
    </>
  ),
  accion: (
    <>
      <rect x="14" y="8" width="36" height="48" rx="5" {...SKETCH} />
      <path d="M26 6h12v8H26z" {...SKETCH} />
      <path d="M22 26l5 5l9-10" {...SKETCH} />
      <path d="M22 42h20M22 49h12" {...SKETCH} opacity="0.6" />
    </>
  ),
  verificacion: (
    <>
      <path d="M32 6L52 14V32C52 44 43 53 32 58C21 53 12 44 12 32V14L32 6Z" {...SKETCH} />
      <path d="M22 32l7 7l13-14" {...SKETCH} />
    </>
  ),
};

export const HOW_IT_WORKS: Array<{ id: keyof typeof SKETCHES; label: string; text: string }> = [
  { id: 'captura', label: 'CAPTURA', text: 'Sensores, fotos y reportes de campo, incluso sin conexión.' },
  { id: 'deteccion', label: 'DETECCIÓN', text: 'Reglas físicas y el balance de agua señalan lo anormal.' },
  { id: 'analisis', label: 'ANÁLISIS', text: 'Se cruzan las evidencias y se dice qué tan respaldada está la causa.' },
  { id: 'accion', label: 'ACCIÓN', text: 'Una persona decide y se crea la orden de trabajo.' },
  { id: 'verificacion', label: 'VERIFICACIÓN', text: 'Todo queda en un registro sellado y se contrasta con nuevas mediciones.' },
];

export const HowItWorks: React.FC = () => (
  <section aria-labelledby="how-title" className="space-y-6">
    <h2 id="how-title" className="font-display text-xl font-semibold text-ink">
      Cómo funciona
    </h2>
    <ol className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-5 lg:gap-y-0">
      {HOW_IT_WORKS.map((s, i) => (
        <li key={s.id} className="relative flex gap-4 lg:flex-col lg:gap-3">
          <svg viewBox="0 0 64 64" className="h-14 w-14 shrink-0 text-accent lg:h-16 lg:w-16" role="img" aria-label={`Boceto: ${s.label.toLowerCase()}`}>
            {SKETCHES[s.id]}
          </svg>
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-bold tracking-widest text-accent">
              <span className="text-quiet">{i + 1}.</span> {s.label}
            </p>
            <p className="text-sm leading-relaxed text-soft">{s.text}</p>
          </div>
          {i < HOW_IT_WORKS.length - 1 && <ArrowRight aria-hidden="true" className="absolute -right-3 top-6 hidden h-5 w-5 text-line-strong lg:block" />}
        </li>
      ))}
    </ol>
  </section>
);

/* ───────────── D. Acceso a la plataforma ───────────── */

export const ExploreAccess: React.FC<{ onNavigate: (view: 'map' | 'incidents' | 'orders') => void }> = ({ onNavigate }) => (
  <section aria-labelledby="explore-title" className="flex flex-wrap items-center justify-between gap-6 border-t border-line pt-8">
    <div className="max-w-xl space-y-1.5">
      <h2 id="explore-title" className="font-display text-xl font-semibold text-ink">
        Explora la plataforma
      </h2>
      <p className="text-base leading-relaxed text-soft">No necesitas cuenta. Recorre el mapa, un incidente real de la demostración y su orden de trabajo. Todo lo que ves es simulado.</p>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" onClick={() => onNavigate('map')} icon={<ArrowRight className="h-4 w-4" />}>
        Empezar a explorar
      </Button>
      <Button variant="ghost" onClick={() => onNavigate('incidents')}>
        Incidentes
      </Button>
      <Button variant="ghost" onClick={() => onNavigate('orders')}>
        Órdenes de trabajo
      </Button>
    </div>
  </section>
);

/** Introducción completa: encabezado, video, cómo funciona y acceso. */
export const IntroSection: React.FC<{ onNavigate: (view: 'map' | 'incidents' | 'orders') => void; videoState?: VideoState }> = ({ onNavigate, videoState }) => (
  <div className="space-y-12">
    <Hero>
      <IntroVideo forceState={videoState} />
    </Hero>
    <HowItWorks />
    <ExploreAccess onNavigate={onNavigate} />
  </div>
);
