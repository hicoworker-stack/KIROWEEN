/**
 * REQ-PUB-03: video explicativo de la pantalla de Inicio, configurable sin tocar la interfaz.
 *
 * Para publicar el video: copiar el archivo a public/videos/ (por defecto aqua-sentinel-explicativo.mp4) y poner
 * "enabled": true en public/config/intro-video.json. Mientras "enabled" sea false, la interfaz muestra la portada con el aviso
 * «Video explicativo próximamente» SIN pedir al servidor un archivo que se sabe ausente (evita un 404 en la consola de cada visita).
 * Con "enabled": true se comprueba que el servidor entregue de verdad un video; si no, vuelve a «próximamente». Nunca se simula una reproducción.
 *
 * La configuración es un archivo que puede editar cualquiera con acceso al servidor, así que se valida: solo se admiten
 * rutas locales de /videos y /images, o una URL https de un origen que además debe autorizar la CSP (AQUA_MEDIA_ORIGINS).
 */

import { HeroLang, isHeroLang } from './heroCopy';

export const DEFAULT_POSTER = '/images/video-poster.svg';
export const DEFAULT_CONFIG_URL = '/config/intro-video.json';
export const DEFAULT_TITLE = 'Aqua Sentinel: inteligencia para proteger cada gota';

export interface IntroVideoConfig {
  /** Ruta local (/videos/...) o URL https del video; null si todavía no hay video. */
  src: string | null;
  poster: string;
  title: string;
  /** Subtítulos WebVTT locales (/videos/...vtt), si existen. */
  captions: string | null;
  external: boolean;
  /** false: no hay video publicado todavía y no se consulta al servidor. Si falta, se asume true. */
  enabled: boolean;
}

export type VideoState = 'loading' | 'soon' | 'ready' | 'unavailable';

const LOCAL_VIDEO = /^\/videos\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:mp4|webm)$/;
const LOCAL_CAPTIONS = /^\/videos\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.vtt$/;
const LOCAL_POSTER = /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:svg|png|jpe?g|webp)$/;
const noTraversal = (p: string) => !p.split('/').some((s) => s === '..' || s === '.');

export function parseVideoConfig(raw: unknown): IntroVideoConfig {
  const base: IntroVideoConfig = { src: null, poster: DEFAULT_POSTER, title: DEFAULT_TITLE, captions: null, external: false, enabled: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;

  if (typeof r.src === 'string') {
    const s = r.src.trim();
    if (LOCAL_VIDEO.test(s) && noTraversal(s)) {
      base.src = s;
    } else {
      try {
        const u = new URL(s);
        if (u.protocol === 'https:' && !u.username && !u.password && /\.(mp4|webm)$/i.test(u.pathname)) {
          base.src = u.toString();
          base.external = true;
        }
      } catch {
        /* no es una URL: se ignora */
      }
    }
  }
  if (r.enabled === false) base.enabled = false;
  if (typeof r.poster === 'string' && LOCAL_POSTER.test(r.poster.trim()) && noTraversal(r.poster.trim())) base.poster = r.poster.trim();
  if (typeof r.captions === 'string' && LOCAL_CAPTIONS.test(r.captions.trim()) && noTraversal(r.captions.trim())) base.captions = r.captions.trim();
  if (typeof r.title === 'string') {
    const t = r.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    if (t) base.title = t;
  }
  return base;
}

// ───────────── Una versión del video por idioma (REQ-PUB-05) ─────────────

/** Portada sin texto para un idioma que aún no tiene video: así nunca se muestra una portada en el idioma equivocado. */
export const NEUTRAL_POSTER = '/images/hero-network.svg';

/**
 * Elige la entrada de configuración de UN idioma. Formato:
 *   { "versions": { "es": { src, poster, title, captions, enabled }, "en": { ... } } }
 * Si el idioma no tiene entrada, no hay video para él: NUNCA se usa la versión de otro idioma.
 * El formato anterior (sin "versions") describe un único video cuyo idioma indica "lang"; sin "lang" se asume español,
 * el único idioma que tenía la plataforma cuando se usaba ese formato.
 */
export function selectVideoVersion(raw: unknown, lang: HeroLang): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.versions !== undefined) {
    const versions = r.versions;
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return null;
    const v = (versions as Record<string, unknown>)[lang];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }
  const declared = isHeroLang(r.lang) ? r.lang : 'es';
  return declared === lang ? r : null;
}

/** Configuración validada del video de un idioma. Sin versión para ese idioma: sin video y con portada neutra. */
export function parseVideoConfigFor(raw: unknown, lang: HeroLang): IntroVideoConfig {
  const version = selectVideoVersion(raw, lang);
  if (!version) return { ...parseVideoConfig(null), poster: lang === 'es' ? DEFAULT_POSTER : NEUTRAL_POSTER, enabled: false };
  const cfg = parseVideoConfig(version);
  // Una portada no declarada para el idioma no hereda la portada por defecto (que lleva texto en español).
  if (lang !== 'es' && typeof version.poster !== 'string') cfg.poster = NEUTRAL_POSTER;
  return cfg;
}

/**
 * Decide si hay video que reproducir. Un video local solo existe si el servidor lo entrega con un tipo MIME de video:
 * una página de error o el index.html de la aplicación (que responde 200 a cualquier ruta) NO cuenta.
 */
export function resolveVideoState(config: IntroVideoConfig, headContentType: string | null | 'error'): Exclude<VideoState, 'loading' | 'unavailable'> {
  if (!config.src || !config.enabled) return 'soon';
  if (config.external) return 'ready';
  if (headContentType === null || headContentType === 'error') return 'soon';
  return /^video\//i.test(headContentType) ? 'ready' : 'soon';
}
