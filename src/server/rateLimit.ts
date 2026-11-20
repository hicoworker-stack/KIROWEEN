/**
 * REQ-SEC-03: limitador de tasa en memoria con ventana fija, un cupo distinto por tipo de operación.
 *
 * LIMITACIONES DECLARADAS:
 *  - El estado vive en la memoria de UN proceso: se reinicia al reiniciar el servidor y no se comparte entre varios
 *    procesos o réplicas (cada una tendría su propio contador, multiplicando el cupo efectivo).
 *  - La ventana fija permite una ráfaga de hasta 2×max en el cambio de ventana.
 *  - La clave por IP depende de que el servidor conozca la IP real (ver netSecurity: solo se confía en
 *    X-Forwarded-For desde proxies configurados explícitamente). Tras un proxy sin configurar, todos comparten la IP del proxy.
 *  - El bloqueo por cuenta en el login puede usarse para molestar a un usuario concreto (denegación de servicio dirigida);
 *    es el compromiso habitual frente a la fuerza bruta distribuida.
 */

export interface LimitSpec {
  max: number;
  windowMs: number;
}

export type BucketName = 'login-ip' | 'login-user' | 'setup' | 'api-anon' | 'api-user' | 'ai' | 'ai-probe' | 'upload' | 'admin' | 'reauth' | 'deny-log';

export const DEFAULT_LIMITS: Record<BucketName, LimitSpec> = {
  'login-ip': { max: 30, windowMs: 15 * 60_000 }, // intentos de inicio de sesión por IP
  'login-user': { max: 8, windowMs: 15 * 60_000 }, // intentos FALLIDOS por cuenta
  setup: { max: 10, windowMs: 15 * 60_000 },
  'api-anon': { max: 120, windowMs: 60_000 }, // peticiones sin sesión por IP
  'api-user': { max: 900, windowMs: 60_000 }, // peticiones autenticadas por usuario
  ai: { max: 20, windowMs: 60_000 }, // diagnóstico y análisis de imagen por usuario
  'ai-probe': { max: 5, windowMs: 10 * 60_000 },
  upload: { max: 30, windowMs: 10 * 60_000 }, // fotografías por usuario
  admin: { max: 40, windowMs: 10 * 60_000 }, // gestión de usuarios, exportación, auditoría, operaciones destructivas
  reauth: { max: 5, windowMs: 10 * 60_000 }, // contraseñas erróneas al pedir un token de operación
  'deny-log': { max: 30, windowMs: 60_000 }, // denegaciones que se escriben en la auditoría por IP (evita inundarla)
};

export interface HitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
}

interface Slot {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 50_000;

export class RateLimiter {
  private readonly slots = new Map<string, Slot>();
  readonly limits: Record<BucketName, LimitSpec>;

  constructor(
    overrides: Partial<Record<BucketName, Partial<LimitSpec>>> = {},
    private readonly now: () => number = Date.now
  ) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const [name, o] of Object.entries(overrides) as Array<[BucketName, Partial<LimitSpec>]>) {
      const base = this.limits[name];
      if (!base || !o) continue;
      const max = Number.isFinite(o.max) ? Math.max(1, Math.floor(o.max!)) : base.max;
      const windowMs = Number.isFinite(o.windowMs) ? Math.max(50, Math.floor(o.windowMs!)) : base.windowMs;
      this.limits[name] = { max, windowMs };
    }
  }

  private slot(bucket: BucketName, key: string): Slot {
    const id = `${bucket}\u0000${key}`;
    const t = this.now();
    let s = this.slots.get(id);
    if (!s || s.resetAt <= t) {
      if (this.slots.size >= MAX_KEYS) this.evict(t);
      s = { count: 0, resetAt: t + this.limits[bucket].windowMs };
      this.slots.set(id, s);
    }
    return s;
  }

  private evict(t: number) {
    for (const [k, s] of this.slots) if (s.resetAt <= t) this.slots.delete(k);
    if (this.slots.size >= MAX_KEYS) {
      // Si todavía no cabe se descartan las más antiguas: la memoria nunca crece sin límite.
      const sorted = [...this.slots.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [k] of sorted.slice(0, Math.ceil(MAX_KEYS / 10))) this.slots.delete(k);
    }
  }

  private result(bucket: BucketName, s: Slot, allowed: boolean): HitResult {
    const { max } = this.limits[bucket];
    return {
      allowed,
      limit: max,
      remaining: Math.max(0, max - s.count),
      retryAfterSec: Math.max(1, Math.ceil((s.resetAt - this.now()) / 1000)),
      resetAt: s.resetAt,
    };
  }

  /** Cuenta una petición y dice si cabe en el cupo. */
  hit(bucket: BucketName, key: string): HitResult {
    const s = this.slot(bucket, key);
    s.count++;
    return this.result(bucket, s, s.count <= this.limits[bucket].max);
  }

  /** Consulta sin contar (para bloqueos que solo cuentan fallos). */
  peek(bucket: BucketName, key: string): HitResult {
    const s = this.slot(bucket, key);
    return this.result(bucket, s, s.count < this.limits[bucket].max);
  }

  /** Cuenta un fallo (sin comprobar). */
  fail(bucket: BucketName, key: string): HitResult {
    const s = this.slot(bucket, key);
    s.count++;
    return this.result(bucket, s, s.count < this.limits[bucket].max);
  }

  reset(bucket: BucketName, key: string): void {
    this.slots.delete(`${bucket}\u0000${key}`);
  }

  get size(): number {
    return this.slots.size;
  }
}

/** Lee AQUA_RATE_LIMITS (JSON) y valida cada cubeta; los valores inválidos se ignoran. */
export function parseRateLimitEnv(raw: string | undefined): Partial<Record<BucketName, Partial<LimitSpec>>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<LimitSpec>>;
    const out: Partial<Record<BucketName, Partial<LimitSpec>>> = {};
    for (const name of Object.keys(DEFAULT_LIMITS) as BucketName[]) {
      const v = parsed?.[name];
      if (v && typeof v === 'object') out[name] = { max: Number(v.max), windowMs: Number(v.windowMs) };
    }
    return out;
  } catch {
    return {};
  }
}
