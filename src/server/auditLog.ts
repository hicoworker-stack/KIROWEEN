import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../core/canonical';
import { atomicWriteFile } from './authStore';
import { Mutex } from './runtime';
import { SealKeys, signJson, verifyJson } from './sealing';

/**
 * REQ-AUD-01: registro de auditoría independiente del ledger de la red (audit.jsonl).
 *  - Una línea JSON por evento, encadenada por hash (cada entrada incluye el hash de la anterior).
 *  - La cabeza de la cadena se firma con la clave de sellado en audit.head.json.
 *  - Escritura serializada y con fsync. Si una escritura falla, la cadena no avanza y se informa.
 *
 * LIMITACIÓN DECLARADA: la cadena y la firma detectan modificaciones, truncados y reordenamientos hechos por terceros
 * SIN acceso a la clave. NO protegen frente a quien controla el servidor: un administrador del sistema puede reescribir
 * el archivo, volver a encadenar y volver a firmar. Tampoco hay rotación ni retención automática: el archivo crece
 * mientras no se archive. Para una garantía real, copia periódicamente la cabeza (audit.head.json o /api/audit/head) a un
 * sistema que el operador del servidor no controle.
 */

export type AuditOutcome = 'success' | 'denied' | 'failure' | 'error';

export interface AuditActor {
  kind: 'user' | 'anonymous' | 'system' | 'cli';
  id: string | null;
  username?: string;
  role?: string | null;
}

export interface AuditInput {
  actor: AuditActor;
  ip?: string | null;
  action: string;
  resource?: string | null;
  outcome: AuditOutcome;
  status?: number;
  reason?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}

export interface AuditEntry extends Omit<AuditInput, 'meta'> {
  seq: number;
  ts: string;
  prevHash: string;
  meta?: Record<string, string | number | boolean | null>;
  hash: string;
}

export interface AuditHead {
  payload: { count: number; headHash: string; signedAt: string; keyId: string };
  signature: string;
}

export interface AuditStatus {
  status: 'ok' | 'degraded' | 'compromised';
  count: number;
  headHash: string;
  issues: string[];
  failedWrites: number;
  lastError: string | null;
}

export class AuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditWriteError';
  }
}

const GENESIS = '0'.repeat(64);
const SENSITIVE_KEY = /pass|token|secret|cookie|authorization|private|apikey|api_key|csrf|bearer|code$/i;

const cleanText = (s: unknown, max: number): string => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

export function sanitizeMeta(meta: Record<string, unknown> | undefined): AuditEntry['meta'] {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(meta).slice(0, 20)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k) || SENSITIVE_KEY.test(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'string') out[k] = cleanText(v, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

const hashEntry = (e: Omit<AuditEntry, 'hash'>) => crypto.createHash('sha256').update(canonicalJson(e)).digest('hex');

export interface AuditOptions {
  keys?: SealKeys;
  now?: () => number;
  /** Inyectable para simular fallos de disco. */
  appendLine?: (file: string, line: string) => void;
}

function defaultAppendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class AuditLog {
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private readonly appendLine: (file: string, line: string) => void;
  private lastHash = GENESIS;
  private count = 0;
  private needsNewline = false;
  private lastSize = -1;
  private issues: string[] = [];
  private compromised = false;
  failedWrites = 0;
  lastError: string | null = null;

  readonly headFile: string;

  private constructor(
    readonly file: string,
    private readonly opts: AuditOptions
  ) {
    this.now = opts.now ?? Date.now;
    this.appendLine = opts.appendLine ?? defaultAppendLine;
    this.headFile = `${file.replace(/\.jsonl$/, '')}.head.json`;
  }

  static open(file: string, opts: AuditOptions = {}): AuditLog {
    const log = new AuditLog(file, opts);
    log.load();
    return log;
  }

  private parseLines(): { entries: AuditEntry[]; torn: boolean; badMiddle: number[] } {
    if (!fs.existsSync(this.file)) return { entries: [], torn: false, badMiddle: [] };
    const raw = fs.readFileSync(this.file, 'utf8');
    const endsClean = raw.length === 0 || raw.endsWith('\n');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const entries: AuditEntry[] = [];
    const badMiddle: number[] = [];
    let torn = !endsClean;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (typeof e?.hash !== 'string' || typeof e.seq !== 'number') throw new Error('forma');
        entries.push(e);
      } catch {
        if (i === lines.length - 1) torn = true;
        else badMiddle.push(i + 1);
      }
    });
    return { entries, torn, badMiddle };
  }

  /** Verifica la cadena completa y la cabeza firmada. */
  verify(): AuditStatus {
    const issues: string[] = [];
    let compromised = false;
    const { entries, torn, badMiddle } = this.parseLines();
    if (badMiddle.length) {
      // Una línea ilegible no altera la cadena: si hubiera reemplazado a una entrada, la siguiente no encadenaría.
      issues.push(`Líneas ilegibles ignoradas en el archivo de auditoría (${badMiddle.slice(0, 5).join(', ')}): restos de escrituras cortadas.`);
    }
    let prev = GENESIS;
    let n = 0;
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || e.seq !== n + 1 || hashEntry(rest) !== hash) {
        compromised = true;
        issues.push(`Cadena de auditoría rota en la entrada #${e.seq}.`);
        break;
      }
      prev = hash;
      n++;
    }
    if (torn) issues.push('La última línea del archivo de auditoría está incompleta (posible corte durante una escritura); no forma parte de la cadena.');
    // Cabeza firmada: detecta truncados y reescrituras sin la clave.
    if (fs.existsSync(this.headFile)) {
      try {
        const head = JSON.parse(fs.readFileSync(this.headFile, 'utf8')) as AuditHead;
        if (this.opts.keys) {
          if (head.payload.keyId !== this.opts.keys.keyId) {
            issues.push('La cabeza de auditoría está firmada con otra clave de sellado: no se puede comprobar.');
          } else if (!verifyJson(this.opts.keys.publicKeyPem, head.payload, head.signature)) {
            compromised = true;
            issues.push('La firma de la cabeza de auditoría no es válida.');
          } else if (head.payload.count > n) {
            compromised = true;
            issues.push(`El archivo de auditoría tiene ${n} entradas pero la cabeza firmada registra ${head.payload.count}: truncado.`);
          } else if (head.payload.count > 0 && entries[head.payload.count - 1]?.hash !== head.payload.headHash) {
            compromised = true;
            issues.push('La cabeza firmada no coincide con la entrada correspondiente de la cadena: reescritura.');
          }
        }
      } catch {
        compromised = true;
        issues.push('El archivo de cabeza de auditoría no se puede leer.');
      }
    } else if (n > 0 && this.opts.keys) {
      issues.push('Falta audit.head.json: el truncado del final del registro no se puede detectar.');
    }
    return {
      status: compromised ? 'compromised' : this.failedWrites > 0 || issues.length ? 'degraded' : 'ok',
      count: n,
      headHash: prev,
      issues,
      failedWrites: this.failedWrites,
      lastError: this.lastError,
    };
  }

  /** Otro proceso (p. ej. el CLI de administración) pudo añadir entradas: se retoma la cadena desde el final real del archivo. */
  private syncWithDisk() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size === this.lastSize) return;
    const { entries, torn } = this.parseLines();
    this.count = entries.length;
    this.lastHash = entries.length ? entries[entries.length - 1].hash : GENESIS;
    this.needsNewline = torn;
    this.lastSize = size;
  }

  private load() {
    const v = this.verify();
    const { entries, torn } = this.parseLines();
    this.count = entries.length;
    this.lastHash = entries.length ? entries[entries.length - 1].hash : GENESIS;
    this.needsNewline = torn;
    this.issues = v.issues;
    this.compromised = v.status === 'compromised';
    try {
      this.lastSize = fs.statSync(this.file).size;
    } catch {
      this.lastSize = 0;
    }
  }

  status(): AuditStatus {
    const status = this.compromised ? 'compromised' : this.failedWrites > 0 || this.issues.length ? 'degraded' : 'ok';
    return { status, count: this.count, headHash: this.lastHash, issues: this.issues.slice(0, 10), failedWrites: this.failedWrites, lastError: this.lastError };
  }

  head(): AuditHead | null {
    try {
      return JSON.parse(fs.readFileSync(this.headFile, 'utf8')) as AuditHead;
    } catch {
      return null;
    }
  }

  /** Registra un evento. Lanza AuditWriteError si no se pudo escribir (la cadena no avanza). */
  record(input: AuditInput): Promise<AuditEntry> {
    return this.mutex.runExclusive(() => {
      this.syncWithDisk();
      const draft: Omit<AuditEntry, 'hash'> = {
        seq: this.count + 1,
        ts: new Date(this.now()).toISOString(),
        prevHash: this.lastHash,
        actor: { kind: input.actor.kind, id: input.actor.id, username: input.actor.username ? cleanText(input.actor.username, 64) : undefined, role: input.actor.role ?? null },
        ip: input.ip ? cleanText(input.ip, 64) : null,
        action: cleanText(input.action, 120),
        resource: input.resource ? cleanText(input.resource, 160) : null,
        outcome: input.outcome,
        status: input.status,
        reason: input.reason ? cleanText(input.reason, 240) : undefined,
        requestId: input.requestId ? cleanText(input.requestId, 40) : undefined,
        meta: sanitizeMeta(input.meta),
      };
      const base = JSON.parse(JSON.stringify(draft)) as Omit<AuditEntry, 'hash'>; // forma exacta que se guarda (sin undefined)
      const entry: AuditEntry = { ...base, hash: hashEntry(base) };
      try {
        this.appendLine(this.file, `${this.needsNewline ? '\n' : ''}${JSON.stringify(entry)}\n`);
      } catch (err) {
        this.failedWrites++;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.needsNewline = true; // una escritura parcial podría haber dejado una línea sin terminar
        throw new AuditWriteError('No se pudo escribir el registro de auditoría.');
      }
      this.needsNewline = false;
      try {
        this.lastSize = fs.statSync(this.file).size;
      } catch {
        this.lastSize = -1;
      }
      this.count = entry.seq;
      this.lastHash = entry.hash;
      this.writeHead();
      return entry;
    });
  }

  /** Como record, pero un fallo no interrumpe la operación: se contabiliza y se informa por el estado. */
  async recordBestEffort(input: AuditInput): Promise<AuditEntry | null> {
    try {
      return await this.record(input);
    } catch (err) {
      console.error('[auditoría] No se pudo registrar el evento:', input.action, err instanceof Error ? err.message : '');
      return null;
    }
  }

  private writeHead() {
    if (!this.opts.keys) return;
    try {
      const payload = { count: this.count, headHash: this.lastHash, signedAt: new Date(this.now()).toISOString(), keyId: this.opts.keys.keyId };
      const head: AuditHead = { payload, signature: signJson(this.opts.keys, payload) };
      atomicWriteFile(this.headFile, JSON.stringify(head));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.failedWrites++;
    }
  }

  async flush(): Promise<void> {
    await this.mutex.runExclusive(() => undefined);
  }

  /** Últimas entradas (más recientes primero). */
  async read(limit = 100, offset = 0): Promise<{ entries: AuditEntry[]; total: number }> {
    await this.flush();
    const { entries } = this.parseLines();
    const lim = Math.min(Math.max(1, Math.floor(limit) || 100), 500);
    const off = Math.max(0, Math.floor(offset) || 0);
    const ordered = [...entries].reverse();
    return { entries: ordered.slice(off, off + lim), total: entries.length };
  }
}
