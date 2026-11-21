import type { SessionRecord, UserRecord } from './authStore';

/** Datos que los middlewares de seguridad adjuntan a cada petición. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Identidad autenticada resuelta desde la cookie de sesión (nunca desde el cuerpo ni cabeceras del cliente). */
      auth?: { user: UserRecord; session: SessionRecord; csrf: string };
      /** Visitante anónimo admitido por el MODO PÚBLICO en una ruta de solo lectura de la lista cerrada. Nunca implica sesión. */
      publicVisitor?: boolean;
      /** IP del cliente: la del socket, o la que declara un proxy configurado explícitamente como de confianza. */
      clientIp: string;
      requestId: string;
      /** Un middleware de autorización deja aquí el motivo de una denegación para la auditoría. */
      auditDenied?: { reason: string };
      /** Datos que el handler añade al registro de auditoría de su petición (se sanean antes de guardarlos). */
      /** Identidad a registrar cuando aún no hay sesión (p. ej. inicio de sesión fallido). */
      auditActor?: import('./auditLog').AuditActor;
      auditExtra?: { resource?: string; meta?: Record<string, unknown>; action?: string };
    }
  }
}

export {};
