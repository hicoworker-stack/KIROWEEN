import { sha256Hex } from './cryptoLedger';

/**
 * REQ-LED-03: serialización canónica (claves ordenadas, sin undefined) para que un mismo contenido
 * produzca siempre el mismo digest, con independencia del orden de inserción de las claves.
 */
function normalize(v: unknown): unknown {
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: número no finito');
    return v;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalize(x)));
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const n = normalize(src[key]);
      if (n !== undefined) out[key] = n;
    }
    return out;
  }
  throw new Error(`canonicalJson: tipo no soportado (${typeof v})`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
