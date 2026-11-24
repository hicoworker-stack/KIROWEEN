import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clapperboard, Play } from 'lucide-react';
import { HERO_COPY, HERO_LANGS, HeroLang, DEFAULT_HERO_LANG } from '../ui/heroCopy';
import { DEFAULT_CONFIG_URL, IntroVideoConfig, parseVideoConfigFor, resolveVideoState, VideoState } from '../ui/introVideo';
import { Button } from './ui';
import { Network3DSimulation } from './Network3DSimulation';


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

/** Selector de idioma del Hero: dos botones con estado pulsado, accesible con teclado. */
export const HeroLanguageSwitch: React.FC<{ lang: HeroLang; onChange: (lang: HeroLang) => void }> = ({ lang, onChange }) => (
  <div role="group" aria-label={`${HERO_COPY.en.switchLabel} / ${HERO_COPY.es.switchLabel}`} className="inline-flex shrink-0 rounded-full border border-line bg-canvas/60 p-1 backdrop-blur-sm">
    {HERO_LANGS.map((l) => (
      <button
        key={l}
        type="button"
        lang={l}
        aria-pressed={lang === l}
        onClick={() => lang !== l && onChange(l)}
        className={`min-h-10 cursor-pointer rounded-full px-4 text-sm font-medium transition-colors ${lang === l ? 'bg-accent text-[#041018]' : 'text-soft hover:text-ink'}`}
      >
        {HERO_COPY[l].langName}
      </button>
    ))}
  </div>
);

export const Hero: React.FC<{ as?: 'h1' | 'h2'; children?: React.ReactNode; lang?: HeroLang; onLangChange?: (lang: HeroLang) => void }> = ({ as: Heading = 'h1', children, lang = 'es', onLangChange }) => (
  <section aria-labelledby="hero-title" className="relative isolate overflow-hidden rounded-2xl bg-surface bg-[url('/images/hero-network.svg')] bg-cover bg-center">
    {/* Video de fondo decorativo: sin sonido, en bucle y sin controles. Si no carga, queda la imagen de la red. */}
    <video aria-hidden="true" tabIndex={-1} className="hero-bg-video pointer-events-none absolute inset-0 -z-20 h-full w-full object-cover" src="/videos/hero-fondo.mp4" poster="/images/hero-network.svg" autoPlay muted loop playsInline preload="auto" disablePictureInPicture />
    <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-canvas via-canvas/80 to-canvas/30" />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {BUBBLES.map((b, i) => (
        <span key={i} className="hero-bubble" style={{ left: b.x, width: b.s, height: b.s, animationDelay: b.delay, animationDuration: b.dur }} />
      ))}
    </div>
    <div className={children ? 'grid min-h-[26rem] items-center gap-8 px-6 py-12 sm:px-10 sm:py-16 lg:min-h-[34rem] lg:grid-cols-2 lg:gap-12' : 'flex min-h-[26rem] items-center px-6 py-12 sm:px-10 sm:py-16 lg:min-h-[34rem]'}>
<div className="max-w-2xl space-y-4" lang={lang}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2.5 font-display text-base font-semibold tracking-tight text-accent">
          Aqua Sentinel
        </p>
        {onLangChange && <HeroLanguageSwitch lang={lang} onChange={onLangChange} />}
      </div>
      <Heading id="hero-title" className="font-display text-3xl font-semibold leading-tight text-ink sm:text-4xl xl:text-5xl">
        {HERO_COPY[lang].title}
      </Heading>
      <p className="text-base leading-relaxed text-soft sm:text-lg">{HERO_COPY[lang].subtitle}</p>
    </div>
    {children}
    </div>
  </section>
);

/* ───────────── B. Video explicativo ───────────── */

/**
 * Video bajo demanda, una versión por idioma (REQ-PUB-03, REQ-PUB-05). Nunca se reproduce solo y nunca se simula: si el
 * idioma elegido no tiene video publicado, se muestra la portada con el aviso de «próximamente» en ese idioma y JAMÁS la
 * versión de otro idioma. Las versiones se configuran en public/config/intro-video.json.
 *
 * Al cambiar de idioma hay un único <video> en pantalla: el anterior se pausa y se desmonta antes de mostrar el nuevo,
 * así que nunca suenan dos a la vez. La comprobación de cada archivo se hace una sola vez y se recuerda.
 */
export const IntroVideo: React.FC<{ configUrl?: string; forceState?: VideoState; forceConfig?: IntroVideoConfig; lang?: HeroLang }> = ({
  configUrl = DEFAULT_CONFIG_URL,
  forceState,
  forceConfig,
  lang = 'es',
}) => {
  const copy = HERO_COPY[lang].video;
  const forced = Boolean(forceState || forceConfig);
  /** Configuración sin procesar; undefined mientras se descarga. */
  const [raw, setRaw] = useState<unknown>(undefined);
  const [resolved, setResolved] = useState<{ lang: HeroLang; config: IntroVideoConfig; state: VideoState } | null>(null);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const probes = useRef(new Map<string, string | null | 'error'>());

  // 1. La configuración se descarga una vez.
  useEffect(() => {
    if (forced) return;
    let alive = true;
    (async () => {
      let data: unknown = null;
      try {
        const r = await fetch(configUrl, { cache: 'no-store' });
        if (r.ok && /json/i.test(r.headers.get('content-type') ?? '')) data = await r.json();
      } catch {
        /* sin configuración: portada y "próximamente" */
      }
      if (alive) setRaw(data);
    })();
    return () => {
      alive = false;
    };
  }, [configUrl, forced]);

  // 2. Cada cambio de idioma detiene lo que se esté reproduciendo y resuelve la versión de ese idioma.
  useEffect(() => {
    setStarted(false);
    if (forced || raw === undefined) return;
    let alive = true;
    const cfg = parseVideoConfigFor(raw, lang);
    const needsProbe = Boolean(cfg.src && cfg.enabled && !cfg.external);
    const known = cfg.src ? probes.current.get(cfg.src) : undefined;
    if (!needsProbe || known !== undefined) {
      setResolved({ lang, config: cfg, state: resolveVideoState(cfg, needsProbe ? known! : null) });
    } else {
      setResolved({ lang, config: cfg, state: 'loading' });
      (async () => {
        let type: string | null | 'error' = null;
        try {
          const head = await fetch(cfg.src!, { method: 'HEAD', cache: 'no-store' });
          type = head.ok ? head.headers.get('content-type') : null;
        } catch {
          type = 'error';
        }
        probes.current.set(cfg.src!, type);
        // Si entretanto se eligió otro idioma, este resultado ya no se muestra.
        if (alive) setResolved({ lang, config: cfg, state: resolveVideoState(cfg, type) });
      })();
    }
    return () => {
      alive = false;
      ref.current?.pause();
    };
  }, [raw, lang, forced]);

  const config = forceConfig ?? (resolved?.lang === lang ? resolved.config : parseVideoConfigFor(raw ?? null, lang));
  const state: VideoState = forceState ?? (resolved?.lang === lang ? resolved.state : 'loading');

  const play = () => {
    setStarted(true);
    void ref.current?.play().catch(() => setStarted(false));
  };
  const ready = state === 'ready';
  const showPoster = !ready;

  return (
    <figure aria-label={copy.figureLabel} lang={lang} className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-surface">
        {ready ? (
          <video
            key={`${lang}:${config.src}`}
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
              setResolved({ lang, config, state: 'unavailable' });
              setStarted(false);
            }}
          >
            {config.captions && <track kind="captions" srcLang={lang} label={copy.captionsLabel} src={config.captions} default />}
          </video>
        ) : (
          <img key={`poster:${lang}`} src={config.poster} alt={copy.posterAlt} className="absolute inset-0 h-full w-full object-cover" />
        )}

        {/* Botón de reproducción: activo solo si de verdad hay un video en este idioma. */}
        {!started && state !== 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-canvas/50 via-transparent to-transparent">
            {ready ? (
              <button
                type="button"
                onClick={play}
                aria-label={copy.play}
                className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-full bg-accent text-[#041018] shadow-xl shadow-black/40 ring-8 ring-accent/20 transition-transform hover:scale-105 sm:h-24 sm:w-24"
              >
                <Play className="ml-1 h-9 w-9 fill-current sm:h-11 sm:w-11" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-label={copy.playDisabled}
                title={copy.playSoonTitle}
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
            {state === 'unavailable' ? copy.unavailable : copy.soon}
          </p>
        )}
      </div>
      <figcaption className="sr-only">{config.src ? config.title : copy.figureLabel}</figcaption>
    </figure>
  );
};

/* ───────────── C. Cómo funciona ───────────── */

/** Paleta de las ilustraciones: la misma del sistema visual, con un solo acento. */
const C = { acc: '#22d3ee', line: '#2a5873', dim: '#18364a', fill: '#0f2736', soft: '#8fa9b8', warn: '#fb7185', ok: '#34d399', ink: '#041018' };
const L = { fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Escenas pequeñas y detalladas de una sola línea (240 × 150), a juego con el mapa. */
const SCENES: Record<string, React.ReactNode> = {
  captura: (
    <>
      {/* Nube que recibe los datos */}
      <path d="M100 50H136a9 9 0 0 0 0-18a13 13 0 0 0-25-3a11 11 0 0 0-11 21z" {...L} fill={C.fill} stroke={C.line} />
      <path d="M118 44V35M114 39l4-4l4 4" stroke={C.acc} {...L} />
      {/* Tubería con flujo y válvula */}
      <rect x="6" y="108" width="156" height="18" rx="9" {...L} fill={C.fill} stroke={C.line} />
      <path d="M20 117h10m-4-3l4 3l-4 3M108 117h10m-4-3l4 3l-4 3" stroke={C.acc} {...L} opacity="0.7" />
      <path d="M72 108V100M62 100h20" stroke={C.line} {...L} />
      <circle cx="72" cy="117" r="5" {...L} fill={C.dim} stroke={C.line} />
      {/* Sensor de presión con manómetro */}
      <path d="M36 108V90" stroke={C.line} {...L} />
      <circle cx="36" cy="78" r="12" {...L} fill={C.fill} stroke={C.acc} />
      <path d="M36 78l5-6" stroke={C.acc} {...L} />
      <path d="M28 84h16" stroke={C.dim} {...L} />
      {/* Sensor de caudal */}
      <path d="M128 108V92" stroke={C.line} {...L} />
      <rect x="116" y="70" width="24" height="22" rx="5" {...L} fill={C.fill} stroke={C.acc} />
      <path d="M122 84l4-5l4 3l4-6" stroke={C.acc} {...L} />
      {/* Enlaces */}
      <path d="M36 66Q40 52 98 44M128 70Q126 58 126 52M140 82H176" stroke={C.soft} {...L} strokeDasharray="3 4" opacity="0.7" />
      {/* Teléfono con foto y señal */}
      <rect x="178" y="26" width="46" height="94" rx="9" {...L} fill={C.fill} stroke={C.line} />
      <path d="M186 36h6M196 38v-3M200 38v-5M204 38v-7" stroke={C.soft} {...L} opacity="0.7" />
      <rect x="185" y="46" width="32" height="40" rx="3" fill={C.dim} />
      <circle cx="207" cy="56" r="3" fill={C.acc} />
      <path d="M188 80l9-13l7 9l5-6l8 10" stroke={C.acc} {...L} />
      <rect x="187" y="92" width="28" height="8" rx="4" {...L} fill="none" stroke={C.line} />
      <path d="M191 96h12" stroke={C.soft} {...L} opacity="0.6" />
      <circle cx="201" cy="110" r="4" {...L} fill={C.acc} fillOpacity="0.15" stroke={C.acc} />
    </>
  ),
  deteccion: (
    <>
      <rect x="10" y="10" width="220" height="130" rx="10" {...L} fill={C.fill} stroke={C.dim} />
      {/* Leyenda */}
      <circle cx="26" cy="24" r="3" fill={C.acc} />
      <path d="M34 24h24" stroke={C.soft} {...L} opacity="0.5" />
      <circle cx="72" cy="24" r="3" fill={C.soft} />
      <path d="M80 24h20" stroke={C.soft} {...L} opacity="0.5" />
      {/* Ejes y cuadrícula */}
      <path d="M24 36V122H218" stroke={C.line} {...L} />
      <path d="M24 64H218M24 92H218" stroke={C.dim} {...L} opacity="0.7" />
      {/* Banda anómala y umbral */}
      <rect x="128" y="36" width="34" height="86" fill={C.warn} fillOpacity="0.08" />
      <path d="M24 56H218" stroke={C.warn} {...L} strokeDasharray="4 4" opacity="0.7" />
      {/* Presión y caudal */}
      <path d="M24 100L44 98L64 101L84 97L104 99L124 98L134 80L144 48L154 84L164 100L190 99L218 98" stroke={C.acc} {...L} strokeWidth="2" />
      <path d="M24 108L48 106L72 109L96 105L120 107L138 110L150 116L162 108L190 107L218 108" stroke={C.soft} {...L} opacity="0.6" />
      {/* Alerta */}
      <circle cx="144" cy="48" r="9" fill="none" stroke={C.warn} strokeWidth="1.3" opacity="0.5" />
      <circle cx="144" cy="48" r="4" fill={C.warn} />
      <path d="M186 40l10 17h-20z" {...L} fill={C.warn} fillOpacity="0.15" stroke={C.warn} />
      <path d="M186 46v6M186 55v.5" stroke={C.warn} {...L} />
    </>
  ),
  analisis: (
    <>
      {/* Fuentes de evidencia */}
      {[18, 56, 94].map((y, i) => (
        <g key={y}>
          <rect x="10" y={y} width="30" height="30" rx="7" {...L} fill={C.fill} stroke={C.line} />
          {i === 0 && <path d="M16 38l6-3l5 4l6-9l4 3" stroke={C.acc} {...L} />}
          {i === 1 && (
            <>
              <path d="M16 82l7-9l5 6l3-3l5 6" stroke={C.acc} {...L} />
              <circle cx="31" cy="66" r="2" fill={C.acc} />
            </>
          )}
          {i === 2 && <path d="M17 108h16M17 114h16M17 120h10" stroke={C.acc} {...L} />}
          <path d={`M40 ${y + 15}Q64 ${y + 15} 88 76`} stroke={C.soft} {...L} strokeDasharray="3 4" opacity="0.6" />
        </g>
      ))}
      {/* Red hidráulica */}
      <path d="M96 76L150 98L206 62M96 76L128 36M150 98L206 118" stroke={C.line} {...L} strokeWidth="2" />
      <path d="M96 76L150 98" stroke={C.acc} {...L} strokeWidth="3" />
      {[[128, 36], [206, 62], [206, 118]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r="6" {...L} fill={C.fill} stroke={C.line} />
      ))}
      {[[96, 76], [150, 98]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r="6" {...L} fill={C.fill} stroke={C.acc} />
      ))}
      {/* Lupa sobre el tramo candidato */}
      <circle cx="123" cy="87" r="22" fill={C.acc} fillOpacity="0.06" stroke={C.acc} strokeWidth="1.6" />
      <path d="M139 103l12 12" stroke={C.acc} {...L} strokeWidth="3" />
      <circle cx="123" cy="87" r="4" fill={C.warn} />
      {/* Nivel de respaldo */}
      <rect x="104" y="132" width="110" height="6" rx="3" {...L} fill="none" stroke={C.dim} />
      <rect x="104" y="132" width="66" height="6" rx="3" fill={C.acc} />
    </>
  ),
  accion: (
    <>
      {/* Orden de trabajo */}
      <rect x="14" y="14" width="136" height="124" rx="10" {...L} fill={C.fill} stroke={C.line} />
      <rect x="62" y="8" width="40" height="12" rx="5" {...L} fill={C.dim} stroke={C.line} />
      <path d="M26 36h50" stroke={C.soft} {...L} strokeWidth="3" opacity="0.8" />
      {[58, 80, 102].map((y, i) => (
        <g key={y}>
          <rect x="26" y={y - 7} width="14" height="14" rx="3" {...L} fill="none" stroke={i < 2 ? C.acc : C.line} />
          {i < 2 && <path d={`M29 ${y}l3 3l5-6`} stroke={C.acc} {...L} />}
          <path d={`M48 ${y}h${[78, 62, 70][i]}`} stroke={C.soft} {...L} opacity="0.5" />
        </g>
      ))}
      <rect x="26" y="118" width="100" height="6" rx="3" {...L} fill="none" stroke={C.dim} />
      <rect x="26" y="118" width="64" height="6" rx="3" fill={C.acc} />
      {/* Responsable, prioridad y foto */}
      <path d="M150 60H166" stroke={C.soft} {...L} strokeDasharray="3 4" opacity="0.6" />
      <circle cx="196" cy="32" r="11" {...L} fill={C.fill} stroke={C.acc} />
      <circle cx="196" cy="29" r="3.5" {...L} fill="none" stroke={C.acc} />
      <path d="M188 40q8-8 16 0" stroke={C.acc} {...L} />
      <rect x="170" y="52" width="52" height="14" rx="7" {...L} fill={C.warn} fillOpacity="0.15" stroke={C.warn} />
      <path d="M182 59h28" stroke={C.warn} {...L} />
      <rect x="170" y="76" width="52" height="38" rx="6" {...L} fill={C.dim} stroke={C.line} />
      <path d="M176 106l11-13l8 8l6-6l14 11" stroke={C.acc} {...L} />
      <circle cx="210" cy="86" r="2.5" fill={C.acc} />
      <path d="M170 126h52" stroke={C.dim} {...L} />
      <circle cx="176" cy="126" r="3" fill={C.ok} />
    </>
  ),
  verificacion: (
    <>
      {/* Cadena de bloques sellados */}
      {[10, 92, 174].map((x) => (
        <g key={x}>
          <rect x={x} y="12" width="56" height="44" rx="8" {...L} fill={C.fill} stroke={C.line} />
          <path d={`M${x + 10} 26h22M${x + 10} 36h30M${x + 10} 46h14`} stroke={C.soft} {...L} opacity="0.5" />
          <circle cx={x + 45} cy="24" r="3" fill={C.ok} />
        </g>
      ))}
      <path d="M66 34H92M148 34H174" stroke={C.acc} {...L} />
      <circle cx="79" cy="34" r="3" fill={C.acc} />
      <circle cx="161" cy="34" r="3" fill={C.acc} />
      {/* Medición posterior */}
      <rect x="10" y="72" width="140" height="66" rx="8" {...L} fill={C.fill} stroke={C.dim} />
      <path d="M20 82V128H140" stroke={C.line} {...L} />
      <path d="M20 94H140" stroke={C.soft} {...L} strokeDasharray="3 4" opacity="0.5" />
      <path d="M20 96L44 98L60 118L76 120L92 108L110 98L140 95" stroke={C.acc} {...L} strokeWidth="2" />
      <circle cx="140" cy="95" r="4" fill={C.ok} />
      <circle cx="60" cy="118" r="3" fill={C.warn} />
      {/* Sello */}
      <path d="M198 72L222 81V102C222 115 212 124 198 130C184 124 174 115 174 102V81Z" {...L} fill={C.acc} fillOpacity="0.06" stroke={C.acc} />
      <path d="M187 100l8 8l15-16" stroke={C.acc} {...L} strokeWidth="2" />
    </>
  ),
};

export const HOW_IT_WORKS: Array<{ id: keyof typeof SCENES; label: string; title: string; text: string }> = [
  { id: 'captura', label: 'CAPTURA', title: 'Los datos llegan de todas partes', text: 'Sensores de presión y caudal, fotos y reportes de campo. Sin señal, el reporte se guarda y se envía después.' },
  { id: 'deteccion', label: 'DETECCIÓN', title: 'Lo anormal salta a la vista', text: 'Reglas físicas y el balance de agua comparan cada lectura con lo esperado y marcan lo que se sale.' },
  { id: 'analisis', label: 'ANÁLISIS', title: 'Se cruza la evidencia', text: 'Lecturas, fotos y reportes se contrastan con el modelo hidráulico y se dice qué tan respaldada está la causa.' },
  { id: 'accion', label: 'ACCIÓN', title: 'Una persona decide', text: 'Se acepta o se cambia la recomendación y se crea la orden de trabajo, con tareas, responsable y foto.' },
  { id: 'verificacion', label: 'VERIFICACIÓN', title: 'Todo queda comprobado', text: 'Cada decisión se sella en un registro encadenado. Solo hay recuperación cuando llega una medición posterior.' },
];

export const HowItWorks: React.FC = () => (
  <section aria-labelledby="how-title" className="space-y-5">
    <div className="space-y-1">
      <h2 id="how-title" className="font-display text-xl font-semibold text-ink">
        Cómo funciona
      </h2>
      <p className="text-sm text-soft">De un dato suelto a una reparación comprobada, en cinco pasos.</p>
    </div>
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {HOW_IT_WORKS.map((s, i) => (
        <li key={s.id} className={`flex flex-col gap-3 rounded-xl border border-line bg-surface/60 p-4 ${i < 3 ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <svg viewBox="0 0 240 150" className="mx-auto h-auto w-full max-w-[16rem]" role="img" aria-label={`Boceto: ${s.label.toLowerCase()}`}>
            {SCENES[s.id]}
          </svg>
          <div className="space-y-1">
            <p className="text-[11px] font-bold tracking-widest text-accent">
              <span className="text-quiet">{String(i + 1).padStart(2, '0')}</span> · {s.label}
            </p>
            <h3 className="font-display text-base font-semibold leading-snug text-ink">{s.title}</h3>
            <p className="text-sm leading-relaxed text-soft">{s.text}</p>
          </div>
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

/** Introducción completa: encabezado (con selector de idioma y su video), cómo funciona y acceso. */
export const IntroSection: React.FC<{ onNavigate: (view: 'map' | 'incidents' | 'orders') => void; videoState?: VideoState; initialLang?: HeroLang }> = ({
  onNavigate,
  videoState,
  initialLang = DEFAULT_HERO_LANG,
}) => {
  // El idioma vive solo en memoria: el modo público no guarda nada en el navegador del visitante.
  const [lang, setLang] = useState<HeroLang>(initialLang);
  return (
    <div className="space-y-12">
      <Hero lang={lang} onLangChange={setLang}>
        <IntroVideo forceState={videoState} lang={lang} />
      </Hero>
      <Network3DSimulation />
      <HowItWorks />
      <ExploreAccess onNavigate={onNavigate} />
    </div>
  );
};
