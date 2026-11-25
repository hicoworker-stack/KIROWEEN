import { useSyncExternalStore } from 'react';

/**
 * REQ-I18N-01: idioma de la interfaz, ligero y sin duplicar componentes. Español e inglés conviven en el mismo componente:
 * `t('texto en español', 'English text')`. Si falta la versión en inglés, se muestra el español: nunca queda un texto vacío.
 *
 * Alcance honesto: traduce lo que dibuja la interfaz. El contenido que GENERA el servidor y queda guardado en el estado
 * (texto del diagnóstico, tareas de la orden, resúmenes del ledger) se escribe en español y no se traduce.
 *
 * Elección del idioma: `?lang=en` o `?lang=es` en la URL; si no, el idioma del navegador (español solo si es español).
 * No se guarda nada en el navegador: el enlace con `?lang=` es la preferencia, así que sirve para compartir una demostración.
 */
export type Lang = 'es' | 'en';
export const LANGS: readonly Lang[] = ['es', 'en'];
export const isLang = (v: unknown): v is Lang => v === 'es' || v === 'en';

let current: Lang = 'es';
const listeners = new Set<() => void>();

export const getLang = (): Lang => current;
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

/** Texto en el idioma actual. */
export const t = (es: string, en?: string): string => (current === 'en' && en !== undefined ? en : es);

/** Elige el idioma inicial en el navegador. En el servidor y en las pruebas no hay `window`: se queda en español. */
export function detectLang(): Lang {
  if (typeof window === 'undefined') return current;
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (isLang(fromUrl)) return fromUrl;
  const browser = (typeof navigator !== 'undefined' ? navigator.language : '') ?? '';
  return browser.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Cambia el idioma y deja el enlace actual con `?lang=` (sin recargar ni añadir entradas al historial). */
export function chooseLang(lang: Lang): void {
  setLang(lang);
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('lang', lang);
  window.history.replaceState(null, '', url);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** Suscribe el componente al idioma: cuando cambia, vuelve a dibujarse él y todo lo que cuelga de él. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** `1 minuto` / `2 minutos`, `1 minute` / `2 minutes`. */
export const plural = (n: number, es: [string, string], en: [string, string]): string => (current === 'en' ? (n === 1 ? en[0] : en[1]) : n === 1 ? es[0] : es[1]);

/**
 * Tabla cuyo contenido depende del idioma activo. Se lee igual que un objeto (`META[clave].label`), pero cada lectura vuelve a
 * evaluar la fábrica con el idioma de ese momento. Evita tener que cambiar cada sitio que consulta la tabla.
 */
export function live<T extends object>(make: () => T): T {
  return new Proxy({} as T, {
    get: (_target, key) => (make() as Record<PropertyKey, unknown>)[key],
    has: (_target, key) => key in make(),
    ownKeys: () => Reflect.ownKeys(make()),
    getOwnPropertyDescriptor: (_target, key) => {
      const d = Object.getOwnPropertyDescriptor(make(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}