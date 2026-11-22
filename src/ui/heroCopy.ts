/**
 * REQ-PUB-05: textos del Hero en los dos idiomas del selector (inglés por defecto).
 * Solo el Hero (título, subtítulo y video) cambia de idioma; el resto de la plataforma sigue en español.
 */

export type HeroLang = 'en' | 'es';
export const HERO_LANGS: readonly HeroLang[] = ['en', 'es'];
export const DEFAULT_HERO_LANG: HeroLang = 'en';

export const isHeroLang = (v: unknown): v is HeroLang => v === 'en' || v === 'es';

export interface HeroCopy {
  /** Nombre del idioma en su propio idioma, para el selector. */
  langName: string;
  switchLabel: string;
  title: string;
  subtitle: string;
  video: {
    figureLabel: string;
    posterAlt: string;
    play: string;
    playDisabled: string;
    playSoonTitle: string;
    /** Aviso cuando no hay video publicado en este idioma. */
    soon: string;
    unavailable: string;
    captionsLabel: string;
  };
}

export const HERO_COPY: Record<HeroLang, HeroCopy> = {
  en: {
    langName: 'English',
    switchLabel: 'Language',
    title: 'Intelligence to protect every drop.',
    subtitle: 'We detect anomalies, analyze water infrastructure and turn information into verifiable actions.',
    video: {
      figureLabel: 'Aqua Sentinel explainer video',
      posterAlt: 'Cover of the explainer video: an outline of a water network',
      play: 'Play the explainer video',
      playDisabled: 'Play the explainer video (not available yet)',
      playSoonTitle: 'The English video will be published soon',
      soon: 'English version coming soon',
      unavailable: 'The video could not be loaded',
      captionsLabel: 'English',
    },
  },
  es: {
    langName: 'Español',
    switchLabel: 'Idioma',
    title: 'Inteligencia para proteger cada gota.',
    subtitle: 'Detectamos anomalías, analizamos infraestructuras de agua y transformamos información en acciones verificables.',
    video: {
      figureLabel: 'Video explicativo de Aqua Sentinel',
      posterAlt: 'Portada del video explicativo: una gota de agua sobre una red de tuberías y el nombre Aqua Sentinel',
      play: 'Reproducir el video explicativo',
      playDisabled: 'Reproducir el video explicativo (todavía no disponible)',
      playSoonTitle: 'El video se publicará pronto',
      soon: 'Video explicativo próximamente',
      unavailable: 'No se pudo cargar el video',
      captionsLabel: 'Español',
    },
  },
};
