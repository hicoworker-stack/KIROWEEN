import crypto from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * REQ-SEC-01 y REQ-RES-06: capa HTTP.
 *  - Ningún error de una ruta asíncrona termina el proceso (Express 4 no captura promesas rechazadas).
 *  - Las operaciones destructivas exigen configuración explícita, cabecera de confirmación y, si se configura, token.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type AnyHandler = (req: Request, res: Response, next: NextFunction) => unknown;

export function wrapAsync(handler: AnyHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Envuelve app.get/post/patch/put/delete para que todo handler pase por wrapAsync. */
export function installAsyncSafety(app: Express): void {
  for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
    const original = (app[method] as (...args: unknown[]) => unknown).bind(app);
    (app as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      // app.get('setting') con un único argumento string es la API de configuración de Express.
      if (method === 'get' && args.length === 1) return original(...args);
      return original(...args.map((a) => (typeof a === 'function' ? wrapAsync(a as AnyHandler) : a)));
    };
  }
}

interface ErrorLike {
  status?: number;
  statusCode?: number;
  type?: string;
  message?: string;
  extra?: Record<string, unknown>;
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = (err ?? {}) as ErrorLike;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    return;
  }
  // WorkOrderError y errores de body-parser exponen un status HTTP.
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 0;
  if (status >= 400 && status < 500) {
    const message =
      e.type === 'entity.parse.failed'
        ? 'El cuerpo de la petición no es JSON válido.'
        : e.type === 'entity.too.large'
          ? 'El cuerpo de la petición supera el tamaño máximo.'
          : (e.message ?? 'Petición inválida.');
    res.status(status).json({ error: message });
    return;
  }
  console.error('[http] Error no controlado en una ruta:', err);
  res.status(500).json({ error: 'Error interno del servidor. El servidor sigue en funcionamiento.' });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export type DestructiveOperation = 'reset' | 'demo' | 'import';

export interface DestructivePolicyEnv {
  AQUA_ADMIN_TOKEN?: string;
  AQUA_ALLOW_DESTRUCTIVE?: string;
  NODE_ENV?: string;
}

export type PolicyDecision = { allow: true } | { allow: false; status: number; message: string };

/**
 * Política pura (testeable):
 *  1. Siempre se exige la cabecera X-Aqua-Confirm con el nombre de la operación. Es una cabecera personalizada:
 *     una página web ajena no puede enviarla en una petición "simple" (bloquea CSRF contra localhost).
 *  2. Con AQUA_ADMIN_TOKEN configurado, además se exige X-Admin-Token.
 *  3. Sin token: solo con AQUA_ALLOW_DESTRUCTIVE=1, o fuera de producción y desde loopback.
 */
export function evaluateDestructivePolicy(
  operation: DestructiveOperation,
  req: { header(name: string): string | undefined; loopback: boolean },
  env: DestructivePolicyEnv
): PolicyDecision {
  if (req.header('x-aqua-confirm') !== operation) {
    return {
      allow: false,
      status: 400,
      message: `Operación destructiva sin confirmar: envía la cabecera X-Aqua-Confirm: ${operation}.`,
    };
  }
  const token = env.AQUA_ADMIN_TOKEN;
  if (token) {
    const provided = req.header('x-admin-token') ?? '';
    if (!provided || !timingSafeEqual(provided, token)) {
      return { allow: false, status: 401, message: 'Token de administración ausente o incorrecto.' };
    }
    return { allow: true };
  }
  if (env.AQUA_ALLOW_DESTRUCTIVE === '1') return { allow: true };
  if (env.NODE_ENV !== 'production' && req.loopback) return { allow: true };
  return {
    allow: false,
    status: 403,
    message:
      'Operación destructiva deshabilitada. Configura AQUA_ADMIN_TOKEN (recomendado) o AQUA_ALLOW_DESTRUCTIVE=1 en un entorno de demostración.',
  };
}

export function destructiveGuard(operation: DestructiveOperation): RequestHandler {
  return (req, res, next) => {
    const decision = evaluateDestructivePolicy(
      operation,
      { header: (n) => req.header(n) ?? undefined, loopback: isLoopback(req) },
      {
        AQUA_ADMIN_TOKEN: process.env.AQUA_ADMIN_TOKEN,
        AQUA_ALLOW_DESTRUCTIVE: process.env.AQUA_ALLOW_DESTRUCTIVE,
        NODE_ENV: process.env.NODE_ENV,
      }
    );
    if (decision.allow) {
      next();
      return;
    }
    res.status(decision.status).json({ error: decision.message });
  };
}
