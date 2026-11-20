import net from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * REQ-SEC-04: seguridad de red.
 *  - Hosts y orígenes permitidos configurados de forma explícita (anti DNS rebinding y anti CSRF entre sitios).
 *  - Ninguna cabecera de proxy (X-Forwarded-For/Host/Proto, Forwarded) se usa salvo que el socket venga de un proxy
 *    listado en AQUA_TRUSTED_PROXIES. X-Forwarded-Host NUNCA se usa: el proxy debe conservar la cabecera Host.
 *  - Cabeceras de seguridad y política CORS cerrada (sin Access-Control-*).
 *
 * Variables:
 *   AQUA_ALLOWED_HOSTS     lista separada por comas de valores de la cabecera Host (host o host:puerto; host:* acepta cualquier puerto).
 *   AQUA_ALLOWED_ORIGINS   lista de orígenes (https://aqua.ejemplo.org) que pueden enviar peticiones de escritura.
 *   AQUA_TRUSTED_PROXIES   lista de IP de proxys inversos de confianza.
 * En producción las dos primeras son obligatorias; en desarrollo se aceptan localhost, 127.0.0.1 y [::1].
 */

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigError';
  }
}

export interface SecurityConfig {
  production: boolean;
  allowedHosts: string[];
  /** null = desarrollo: se aceptan orígenes loopback. */
  allowedOrigins: string[] | null;
  trustedProxies: string[];
}

const LOOPBACK_HOSTS = ['localhost:*', '127.0.0.1:*', '[::1]:*', 'localhost', '127.0.0.1', '[::1]'];

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function loadSecurityConfig(env: Record<string, string | undefined> = process.env): SecurityConfig {
  const production = env.NODE_ENV === 'production';
  const hosts = list(env.AQUA_ALLOWED_HOSTS);
  const origins = list(env.AQUA_ALLOWED_ORIGINS);
  const proxies = list(env.AQUA_TRUSTED_PROXIES).map(normalizeIp);
  for (const h of hosts) if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:(\d{1,5}|\*))?$/.test(h)) throw new SecurityConfigError(`AQUA_ALLOWED_HOSTS contiene un valor inválido: "${h}".`);
  for (const o of origins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new SecurityConfigError(`AQUA_ALLOWED_ORIGINS contiene un origen inválido: "${o}".`);
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== o.replace(/\/$/, '')) throw new SecurityConfigError(`AQUA_ALLOWED_ORIGINS debe contener solo orígenes (esquema://host[:puerto]): "${o}".`);
  }
  for (const p of proxies) if (!net.isIP(p)) throw new SecurityConfigError(`AQUA_TRUSTED_PROXIES contiene una IP inválida: "${p}".`);
  if (production) {
    if (hosts.length === 0) throw new SecurityConfigError('En producción debes definir AQUA_ALLOWED_HOSTS (valores permitidos de la cabecera Host).');
    if (origins.length === 0) throw new SecurityConfigError('En producción debes definir AQUA_ALLOWED_ORIGINS (orígenes permitidos para peticiones de escritura).');
    if (hosts.some((h) => h === '*' || h.startsWith('*'))) throw new SecurityConfigError('AQUA_ALLOWED_HOSTS no admite comodines de host.');
  }
  return {
    production,
    allowedHosts: hosts.length ? hosts : LOOPBACK_HOSTS,
    allowedOrigins: origins.length ? origins.map((o) => o.replace(/\/$/, '')) : production ? [] : null,
    trustedProxies: proxies,
  };
}

export function hostAllowed(hostHeader: string | undefined, cfg: SecurityConfig): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  if (h.length > 255 || !/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(h)) return false;
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h)!;
  const [, name, port] = m;
  return cfg.allowedHosts.some((a) => {
    if (a === h) return true;
    const am = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}|\*))?$/.exec(a);
    if (!am) return false;
    return am[1] === name && am[2] === '*' && port !== undefined;
  });
}

export function originAllowed(origin: string | undefined, cfg: SecurityConfig): boolean {
  if (origin === undefined) return true; // sin Origin: petición que no es de un navegador entre sitios (ver CSRF)
  if (origin === 'null') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  if (cfg.allowedOrigins === null) return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:');
  return cfg.allowedOrigins.includes(origin.toLowerCase());
}

export function normalizeIp(ip: string): string {
  let v = (ip ?? '').trim().toLowerCase();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
  return v;
}

/** IP del cliente. Solo se leen cabeceras de proxy si el socket pertenece a un proxy de confianza. */
export function clientIpOf(req: Pick<Request, 'socket' | 'headers'>, cfg: SecurityConfig): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  if (!cfg.trustedProxies.includes(remote)) return remote || 'desconocida';
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!net.isIP(chain[i])) return remote; // cadena manipulada o ilegible: no se confía en ella
    if (!cfg.trustedProxies.includes(chain[i])) return chain[i];
  }
  return remote;
}

export function isSecureRequest(req: Pick<Request, 'socket' | 'headers'>, cfg: SecurityConfig): boolean {
  if ((req.socket as unknown as { encrypted?: boolean }).encrypted) return true;
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  if (!cfg.trustedProxies.includes(remote)) return false;
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0].trim().toLowerCase() === 'https';
}

/** ¿Debe llevar el atributo Secure la cookie de sesión? Siempre en producción o sobre HTTPS. */
export const useSecureCookie = (req: Pick<Request, 'socket' | 'headers'>, cfg: SecurityConfig) => cfg.production || isSecureRequest(req, cfg);

export function cspFor(cfg: SecurityConfig): string {
  const base = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  ];
  if (cfg.production) return [...base, "script-src 'self'", "connect-src 'self'"].join('; ');
  // Desarrollo: Vite inyecta un script en línea (React Refresh) y usa WebSocket para HMR.
  return [...base, "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "connect-src 'self' ws: wss:"].join('; ');
}

export function securityHeaders(cfg: SecurityConfig): RequestHandler {
  const csp = cspFor(cfg);
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (isSecureRequest(req, cfg)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/** Rechaza cualquier petición cuya cabecera Host no esté permitida (anti DNS rebinding). */
export function hostGuard(cfg: SecurityConfig, onDeny?: (req: Request, reason: string) => void): RequestHandler {
  return (req, res, next) => {
    if (hostAllowed(req.headers.host, cfg)) return next();
    onDeny?.(req, 'host no permitido');
    res.status(421).type('text/plain').send('Host no permitido.');
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Rechaza orígenes no permitidos. Con cabecera Origin presente debe estar en la lista; si falta en una petición de
 * escritura y el navegador declara Sec-Fetch-Site: cross-site, también se rechaza. No se emiten cabeceras CORS:
 * ningún otro origen puede leer respuestas de la API.
 */
export function originGuard(cfg: SecurityConfig, onDeny?: (req: Request, reason: string) => void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const o = Array.isArray(origin) ? origin[0] : origin;
    let denied: string | null = null;
    if (o !== undefined && !originAllowed(o, cfg)) denied = 'origen no permitido';
    else if (o === undefined && UNSAFE.has(req.method) && req.headers['sec-fetch-site'] === 'cross-site') denied = 'petición entre sitios';
    if (!denied) return next();
    onDeny?.(req, denied);
    res.status(403).json({ error: 'Origen no permitido.' });
  };
}
