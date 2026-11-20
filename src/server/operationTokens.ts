import crypto from 'node:crypto';
import { sha256Hex } from './authStore';

/**
 * REQ-SEC-05: token de operación destructiva. Se obtiene reautenticando con la contraseña, vive 60 s, sirve para UNA
 * operación concreta (reset, demo o import), está ligado al usuario y a su sesión y se consume al usarse.
 * Solo se guarda su hash, en memoria: un reinicio del servidor invalida los tokens pendientes (es lo deseable).
 */

export type DestructiveOperation = 'reset' | 'demo' | 'import';
export const DESTRUCTIVE_OPERATIONS: readonly DestructiveOperation[] = ['reset', 'demo', 'import'];

interface Entry {
  userId: string;
  sessionHash: string;
  operation: DestructiveOperation;
  expiresAt: number;
}

export const OPERATION_TOKEN_TTL_MS = 60_000;
const MAX_PENDING = 200;

export class OperationTokens {
  private readonly tokens = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = OPERATION_TOKEN_TTL_MS
  ) {}

  issue(userId: string, sessionHash: string, operation: DestructiveOperation): { token: string; expiresAt: string } {
    this.purge();
    if (this.tokens.size >= MAX_PENDING) {
      const oldest = [...this.tokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.tokens.delete(oldest[0]);
    }
    // Un usuario solo mantiene un token pendiente por operación: pedir otro invalida el anterior.
    for (const [k, e] of this.tokens) if (e.userId === userId && e.operation === operation) this.tokens.delete(k);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(sha256Hex(token), { userId, sessionHash, operation, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Consume el token. Devuelve true solo una vez, para el mismo usuario, sesión y operación, y antes de caducar. */
  consume(token: unknown, userId: string, sessionHash: string, operation: DestructiveOperation): boolean {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return false;
    const key = sha256Hex(token);
    const e = this.tokens.get(key);
    if (!e) return false;
    this.tokens.delete(key); // un intento con datos erróneos también lo quema: no se puede probar variantes
    return e.expiresAt > this.now() && e.userId === userId && e.sessionHash === sessionHash && e.operation === operation;
  }

  revokeSession(sessionHash: string) {
    for (const [k, e] of this.tokens) if (e.sessionHash === sessionHash) this.tokens.delete(k);
  }

  private purge() {
    const t = this.now();
    for (const [k, e] of this.tokens) if (e.expiresAt <= t) this.tokens.delete(k);
  }

  get pending(): number {
    this.purge();
    return this.tokens.size;
  }
}
