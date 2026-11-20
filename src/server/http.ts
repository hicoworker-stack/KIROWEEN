import crypto from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * REQ-RES-06: capa HTTP. Ningún error de una ruta asíncrona termina el proceso (Express 4 no captura promesas rechazadas).
 * La protección de operaciones destructivas vive ahora en authApi.ts (REQ-SEC-05).
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
  const wrapped: RequestHandler = (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
  // Conserva las marcas (p. ej. el permiso que exige la ruta) para que se puedan auditar.
  Object.assign(wrapped, handler);
  return wrapped;
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
  // Errores del almacén de autenticación: sus mensajes están redactados para el cliente (sin rutas ni detalles internos).
  if (err instanceof Error && err.name === 'AuthStoreError' && typeof e.status === 'number') {
    res.status(e.status).json({ error: err.message, code: (err as { code?: string }).code });
    return;
  }
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

/** Comparación en tiempo constante de dos cadenas (tokens, códigos). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}