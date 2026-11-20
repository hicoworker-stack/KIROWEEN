import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * REQ-AUTHZ-01: matriz de permisos aplicada en el servidor. La interfaz puede ocultar botones, pero la decisión
 * siempre se toma aquí, con el rol vigente del usuario leído en cada petición.
 *
 *  - VIEWER:   consulta (estado, ledger, evidencias, verificación de expedientes).
 *  - OPERATOR: además ingesta, escenarios, IA, decisiones, órdenes, evidencias, exportar expedientes y sincronizar.
 *  - ADMIN:    además usuarios, auditoría, snapshot, sonda de IA y operaciones destructivas.
 */

import { can, Permission } from '../core/permissions';

// La matriz vive en src/core/permissions.ts (la comparte la interfaz solo para mostrar u ocultar acciones).
export { can, PERMISSIONS, ROLE_PERMISSIONS } from '../core/permissions';
export type { Permission } from '../core/permissions';

/** Rutas sin sesión. Todo lo demás exige autenticación (denegación por defecto). */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/seal/public-key' },
  { method: 'GET', path: '/api/auth/status' },
  { method: 'GET', path: '/api/auth/csrf' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/setup' },
];

export const isPublicRoute = (method: string, path: string) => PUBLIC_ROUTES.some((r) => r.method === method && r.path === path);

/** Marca una ruta con el permiso que exige; el middleware global lo aplica y una prueba comprueba que ninguna ruta lo omita. */
export const PERMISSION_TAG = '__aquaPermission';
export const AUTHENTICATED_ONLY = 'authenticated' as const;

export function needs(permission: Permission | typeof AUTHENTICATED_ONLY): RequestHandler {
  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const user = req.auth?.user;
    if (!user) {
      res.status(401).json({ error: 'Autenticación requerida.' });
      return;
    }
    if (permission !== AUTHENTICATED_ONLY && !can(user.role, permission)) {
      req.auditDenied = { reason: `permiso ${permission} no concedido al rol ${user.role}` };
      res.status(403).json({ error: 'Tu rol no tiene permiso para esta operación.', required: permission });
      return;
    }
    next();
  };
  (handler as unknown as Record<string, unknown>)[PERMISSION_TAG] = permission;
  return handler;
}
