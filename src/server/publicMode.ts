import { NetworkNode } from '../core/types';

/**
 * REQ-PUB-01/02: MODO PÚBLICO (AQUA_PUBLIC_MODE=1). Es explícito, acotado y reversible: con la variable apagada
 * el servidor se comporta exactamente como antes (toda ruta exige sesión).
 *
 * Qué hace:
 *  - Admite visitantes SIN sesión únicamente en una lista cerrada de rutas GET de solo lectura (PUBLIC_READ_ROUTES).
 *  - A esos visitantes les aplica el rol VISITOR de la matriz de permisos (state:read y evidence:read, nada más).
 *  - Les entrega una versión redactada del estado (redactForVisitor): sin rutas de disco, sin mensajes internos.
 *
 * Qué NO hace:
 *  - No convierte las solicitudes anónimas en operador ni en administrador: cualquier otra ruta, y todo POST, PATCH,
 *    PUT y DELETE, siguen exigiendo sesión, CSRF y el permiso del rol, como siempre.
 *  - No toca auth.json, la auditoría ni la clave de sellado.
 *  - No sirve estado con lecturas de campo: assertPublicStateIsSynthetic() impide arrancar si las hay.
 */

export function isPublicModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.AQUA_PUBLIC_MODE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Lista CERRADA de rutas sin sesión del modo público. Todas son GET y ninguna modifica estado. */
export const PUBLIC_READ_ROUTES: ReadonlyArray<{ method: 'GET'; re: RegExp; doc: string }> = [
  { method: 'GET', re: /^\/api\/state$/, doc: '/api/state' },
  { method: 'GET', re: /^\/api\/events$/, doc: '/api/events' },
  { method: 'GET', re: /^\/api\/evidence\/[a-f0-9]{64}$/, doc: '/api/evidence/:sha256' },
  // Vista previa determinista de una fuga para la maqueta 3D: calcula con los motores reales y no lee ni escribe el estado.
  { method: 'GET', re: /^\/api\/preview\/leak$/, doc: '/api/preview/leak' },
];

export function isPublicReadRoute(method: string, path: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method;
  return PUBLIC_READ_ROUTES.some((r) => r.method === m && r.re.test(path));
}

/**
 * El modo público solo sirve datos de demostración. Si el estado contiene lecturas que no son sintéticas
 * (por ejemplo, porque se apuntó al estado operativo real) el servidor se niega a arrancar.
 */
export class PublicModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicModeError';
  }
}

export function assertPublicStateIsSynthetic(nodes: Pick<NetworkNode, 'id' | 'current'>[]): void {
  const real = nodes.filter((n) => n.current && n.current.synthetic !== true).map((n) => n.id);
  if (real.length > 0) {
    throw new PublicModeError(
      `El modo público solo sirve datos de demostración, pero el estado contiene lecturas NO sintéticas (${real.slice(0, 3).join(', ')}). ` +
        'Usa una instancia pública con su propio AQUA_STATE_PATH (por defecto data/public-demo/) y no apuntes al estado operativo.'
    );
  }
}

/**
 * Versión del estado para visitantes anónimos. El ledger se entrega íntegro (si se redactara, su cadena de hashes
 * dejaría de poder verificarse); lo que se quita es información interna del servidor.
 */
export function redactForVisitor<T extends Record<string, unknown>>(payload: T): T {
  const out: Record<string, unknown> = { ...payload };
  const persistence = payload.persistence as { mode?: string } | undefined;
  if (persistence) out.persistence = { mode: persistence.mode ?? 'disk', lastError: null };
  const integrity = payload.integrity as { status?: string; checkedAt?: string } | undefined;
  if (integrity) out.integrity = { status: integrity.status ?? 'ok', issues: [], checkedAt: integrity.checkedAt };
  return out as T;
}
