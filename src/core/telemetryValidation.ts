import { ReadingSource, TelemetryReading } from './types';

/**
 * REQ-RES-01: validación estricta de lecturas en el límite de confianza (API, CSV, simulador).
 *
 * Se distinguen dos niveles:
 *  - Validez ESTRUCTURAL (este módulo): tipos, valores finitos, marca temporal válida, magnitudes no absurdas.
 *    Una lectura que no la cumple se RECHAZA y nunca llega al estado.
 *  - Plausibilidad FÍSICA (deterministicEngine): un pH de 15 o una turbidez negativa son números finitos que el
 *    motor debe poder marcar como falla de sensor, por eso no se rechazan aquí.
 */

export const NUMERIC_FIELDS = [
  'pressureBar',
  'flowLs',
  'levelPct',
  'turbidityNtu',
  'chlorineMgL',
  'ph',
] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** Cotas estructurales deliberadamente amplias: solo descartan valores absurdos (1e9, etc.). */
export const STRUCTURAL_BOUNDS: Record<NumericField, readonly [number, number]> = {
  pressureBar: [-100, 1000],
  flowLs: [-100000, 100000],
  levelPct: [-1000, 1000],
  turbidityNtu: [-10000, 100000],
  chlorineMgL: [-1000, 10000],
  ph: [-50, 50],
};

export const MAX_BATCH_SIZE = 500;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const VALVE_STATES = ['open', 'closed', 'throttled'] as const;
const ID_PATTERN = /^[\w.:-]{1,100}$/;

export interface ValidationContext {
  knownNodeIds: ReadonlySet<string>;
  nowMs?: number;
}

export interface ValidationOptions {
  source: ReadingSource;
  /**
   * Si es false (por defecto) toda lectura externa se marca sintética: el servidor no puede verificar la
   * procedencia de un dato recibido por red, así que no acepta que un cliente se autodeclare "dato real".
   */
  trustSyntheticFlag?: boolean;
}

export type ReadingValidation =
  | { ok: true; reading: TelemetryReading }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkTimestamp(raw: unknown, nowMs: number, errors: string[]): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) {
    errors.push('timestamp: se requiere una cadena ISO-8601.');
    return null;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    errors.push(`timestamp: fecha inválida (${raw.slice(0, 40)}).`);
    return null;
  }
  if (ms < MIN_TIMESTAMP_MS || ms > MAX_TIMESTAMP_MS) {
    errors.push('timestamp: fuera del rango 2000–2100.');
    return null;
  }
  if (ms > nowMs + MAX_FUTURE_SKEW_MS) {
    errors.push('timestamp: está en el futuro más allá de la tolerancia de reloj (24 h).');
    return null;
  }
  return new Date(ms).toISOString();
}

export function validateReading(
  raw: unknown,
  ctx: ValidationContext,
  options: ValidationOptions
): ReadingValidation {
  if (!isPlainObject(raw)) return { ok: false, errors: ['La lectura debe ser un objeto.'] };
  const errors: string[] = [];
  const nowMs = ctx.nowMs ?? Date.now();

  const nodeId = raw.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    errors.push('nodeId: se requiere una cadena.');
  } else if (!ctx.knownNodeIds.has(nodeId)) {
    errors.push(`nodeId: nodo desconocido (${nodeId.slice(0, 40)}).`);
  }

  const timestamp = checkTimestamp(raw.timestamp, nowMs, errors);

  const numbers = {} as Record<NumericField, number>;
  for (const field of NUMERIC_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${field}: se requiere un número finito.`);
      continue;
    }
    const [min, max] = STRUCTURAL_BOUNDS[field];
    if (value < min || value > max) {
      errors.push(`${field}: valor absurdo (${value}), fuera de [${min}, ${max}].`);
      continue;
    }
    numbers[field] = value;
  }

  let valveState: TelemetryReading['valveState'];
  if (raw.valveState !== undefined) {
    if (typeof raw.valveState === 'string' && (VALVE_STATES as readonly string[]).includes(raw.valveState)) {
      valveState = raw.valveState as TelemetryReading['valveState'];
    } else {
      errors.push('valveState: debe ser open, closed o throttled.');
    }
  }

  let id: string | undefined;
  if (raw.id !== undefined) {
    if (typeof raw.id === 'string' && ID_PATTERN.test(raw.id)) id = raw.id;
    else errors.push('id: formato inválido.');
  }

  if (errors.length > 0 || typeof nodeId !== 'string' || timestamp === null) {
    return { ok: false, errors };
  }

  const synthetic = options.trustSyntheticFlag ? raw.synthetic !== false : true;
  const reading: TelemetryReading = {
    id: id ?? `${options.source}-${nodeId}-${timestamp}`,
    timestamp,
    nodeId,
    pressureBar: numbers.pressureBar,
    flowLs: numbers.flowLs,
    levelPct: numbers.levelPct,
    turbidityNtu: numbers.turbidityNtu,
    chlorineMgL: numbers.chlorineMgL,
    ph: numbers.ph,
    ...(valveState ? { valveState } : {}),
    synthetic,
    source: options.source,
  };
  return { ok: true, reading };
}

export interface BatchValidation {
  accepted: TelemetryReading[];
  rejected: Array<{ index: number; errors: string[] }>;
}

export function validateReadingBatch(
  raws: unknown,
  ctx: ValidationContext,
  options: ValidationOptions
): BatchValidation | { fatal: string } {
  if (!Array.isArray(raws)) return { fatal: 'readings debe ser una lista.' };
  if (raws.length === 0) return { fatal: 'No hay lecturas que procesar.' };
  if (raws.length > MAX_BATCH_SIZE) {
    return { fatal: `Demasiadas lecturas (${raws.length}); el máximo por petición es ${MAX_BATCH_SIZE}.` };
  }
  const accepted: TelemetryReading[] = [];
  const rejected: Array<{ index: number; errors: string[] }> = [];
  raws.forEach((raw, index) => {
    const v = validateReading(raw, ctx, options);
    if (v.ok) accepted.push(v.reading);
    else rejected.push({ index, errors: v.errors });
  });
  return { accepted, rejected };
}

/** Clave de deduplicación: un nodo no puede tener dos lecturas con la misma marca temporal. */
export function readingDedupKey(r: Pick<TelemetryReading, 'nodeId' | 'timestamp'>): string {
  return `${r.nodeId}|${new Date(r.timestamp).toISOString()}`;
}

/** Huella del contenido medido: distingue un reenvío idéntico de un conflicto (misma marca, valores distintos). */
export function readingFingerprint(r: TelemetryReading): string {
  return [...NUMERIC_FIELDS.map((f) => r[f]), r.valveState ?? ''].join('|');
}

/** Validez estructural de una lectura ya almacenada (estado persistido o recibido por SSE). */
export function isStructurallyValidReading(r: unknown): r is TelemetryReading {
  if (!isPlainObject(r)) return false;
  if (typeof r.id !== 'string' || typeof r.nodeId !== 'string') return false;
  if (typeof r.timestamp !== 'string' || !Number.isFinite(Date.parse(r.timestamp))) return false;
  if (typeof r.synthetic !== 'boolean') return false;
  for (const field of NUMERIC_FIELDS) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    const [min, max] = STRUCTURAL_BOUNDS[field];
    if (v < min || v > max) return false;
  }
  return true;
}
