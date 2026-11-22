import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './runtime';
import { DEFAULT_SCRYPT, hashPassword, PasswordRecord, ScryptParams, validatePasswordPolicy, verifyPassword } from './passwords';

/**
 * REQ-AUTH-01/02/03: almacén local de usuarios y sesiones (auth.json), independiente del estado de la red.
 *  - reset, demo e import NO lo tocan: viven en un archivo distinto y ningún código del estado lo referencia.
 *  - Escritura atómica (temporal + fsync + rename) bajo un cerrojo en proceso y un cerrojo de archivo, de modo que el
 *    servidor y el CLI de recuperación no se pisan.
 *  - Si el archivo existe pero está corrupto, el servidor NO arranca: reinicializarlo reabriría la configuración inicial.
 *  - Los tokens de sesión nunca se guardan: solo su SHA-256. El token tiene 256 bits de entropía.
 */

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
export const ROLES: readonly Role[] = ['ADMIN', 'OPERATOR', 'VIEWER'];

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  password: PasswordRecord;
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  passwordChangedAt: string;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  /** Rol vigente al emitir la sesión: si el rol del usuario cambia, la sesión deja de valer. */
  role: Role;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
  ip?: string;
  userAgent?: string;
}

interface SetupState {
  codeHash: string;
  expiresAt: string;
  failedAttempts: number;
}

interface AuthData {
  version: 1;
  users: UserRecord[];
  sessions: SessionRecord[];
  setup: SetupState | null;
  /** Una vez creado el primer usuario el asistente de configuración queda deshabilitado de forma definitiva. */
  setupDisabled: boolean;
  updatedAt: string;
}

export class AuthStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AuthStoreError';
  }
}

export interface AuthStoreOptions {
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
  maxSessionsPerUser?: number;
  setupTtlMs?: number;
  scrypt?: ScryptParams;
  /** Inyectable para simular fallos de disco en las pruebas. */
  writeAtomic?: (file: string, data: string) => void;
}

export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_ABSOLUTE_MS = 12 * 3_600_000;
const SETUP_MAX_ATTEMPTS = 5;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 30_000;
const TOUCH_PERSIST_MS = 5 * 60_000;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function atomicWriteFile(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = -1;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new AuthStoreError(503, 'No se pudo bloquear el almacén de autenticación.', 'lock_failed');
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
      } catch {
        /* otro proceso lo liberó */
      }
      if (Date.now() > deadline) throw new AuthStoreError(503, 'El almacén de autenticación está ocupado.', 'lock_timeout');
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nada */
    }
    fs.rmSync(lockPath, { force: true });
  }
}

const emptyData = (now: string): AuthData => ({ version: 1, users: [], sessions: [], setup: null, setupDisabled: false, updatedAt: now });

function parseData(raw: string): AuthData {
  const data = JSON.parse(raw) as AuthData;
  if (!data || data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.sessions)) throw new Error('estructura inválida');
  for (const u of data.users) {
    if (!u || typeof u.id !== 'string' || typeof u.username !== 'string' || !ROLES.includes(u.role) || !u.password || u.password.algo !== 'scrypt') throw new Error('usuario inválido');
  }
  return data;
}

export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const u = input.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

export interface SessionContext {
  user: UserRecord;
  session: SessionRecord;
}

export class AuthStore {
  private data: AuthData;
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly maxSessions: number;
  private readonly setupTtlMs: number;
  private readonly scryptParams: ScryptParams;
  private readonly writeAtomic: (file: string, data: string) => void;
  private lastStat = { mtimeMs: -1, size: -1 };
  private lastStatCheck = 0;
  private lastSeen = new Map<string, number>(); // idHash → ms (memoria)
  private lastPersistedSeen = new Map<string, number>();
  private dirtyTouch = false;
  private readonly listeners = new Set<(ev: { userId?: string; idHash?: string }) => void>();
  lastWriteError: string | null = null;

  private constructor(
    private readonly file: string,
    data: AuthData,
    opts: AuthStoreOptions
  ) {
    this.data = data;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.absoluteMs = opts.absoluteMs ?? DEFAULT_ABSOLUTE_MS;
    this.maxSessions = opts.maxSessionsPerUser ?? 10;
    this.setupTtlMs = opts.setupTtlMs ?? 15 * 60_000;
    this.scryptParams = opts.scrypt ?? DEFAULT_SCRYPT;
    this.writeAtomic = opts.writeAtomic ?? atomicWriteFile;
    this.snapshotStat();
  }

  static open(file: string, opts: AuthStoreOptions = {}): AuthStore {
    let data: AuthData;
    if (fs.existsSync(file)) {
      try {
        data = parseData(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new AuthStoreError(
          500,
          `El archivo de autenticación (${file}) existe pero no se puede leer (${err instanceof Error ? err.message : 'corrupto'}). El servidor no arranca para no reabrir la configuración inicial. Restaura una copia (${file}.bak) o corrige el archivo.`,
          'corrupt'
        );
      }
    } else {
      data = emptyData(new Date((opts.now ?? Date.now)()).toISOString());
    }
    return new AuthStore(file, data, opts);
  }

  get filePath() {
    return this.file;
  }
  get scrypt() {
    return this.scryptParams;
  }

  onRevoked(cb: (ev: { userId?: string; idHash?: string }) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ───────────── Lectura ─────────────

  private snapshotStat() {
    try {
      const st = fs.statSync(this.file);
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      this.lastStat = { mtimeMs: -1, size: -1 };
    }
  }

  /** Recarga si otro proceso (p. ej. el CLI de recuperación) modificó el archivo. */
  private reloadIfChanged() {
    const t = Date.now();
    if (t - this.lastStatCheck < 500) return;
    this.lastStatCheck = t;
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this.lastStat.mtimeMs && st.size === this.lastStat.size) return;
      this.data = parseData(fs.readFileSync(this.file, 'utf8'));
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      /* si no se puede leer se conserva la copia en memoria (nunca se abre el acceso por un fallo de lectura) */
    }
  }

  hasUsers(): boolean {
    this.reloadIfChanged();
    return this.data.users.length > 0;
  }

  listUsers(): Array<Omit<UserRecord, 'password'>> {
    this.reloadIfChanged();
    return this.data.users.map(({ password: _p, ...rest }) => rest);
  }

  getUser(id: string): UserRecord | undefined {
    this.reloadIfChanged();
    return this.data.users.find((u) => u.id === id);
  }

  findByUsername(username: unknown): UserRecord | undefined {
    const u = normalizeUsername(username);
    if (!u) return undefined;
    this.reloadIfChanged();
    return this.data.users.find((x) => x.username === u);
  }

  setupAvailable(): boolean {
    this.reloadIfChanged();
    const s = this.data.setup;
    return !this.data.setupDisabled && this.data.users.length === 0 && Boolean(s) && new Date(s!.expiresAt).getTime() > this.now();
  }
  setupDisabledPermanently(): boolean {
    this.reloadIfChanged();
    return this.data.setupDisabled || this.data.users.length > 0;
  }

  // ───────────── Escritura ─────────────

  private async mutate<T>(fn: (d: AuthData) => T): Promise<T> {
    return this.mutex.runExclusive(() =>
      withFileLock(`${this.file}.lock`, async () => {
        // Se parte siempre del contenido más reciente del disco (otro proceso pudo escribir).
        let base: AuthData;
        if (fs.existsSync(this.file)) {
          try {
            base = parseData(fs.readFileSync(this.file, 'utf8'));
          } catch {
            throw new AuthStoreError(503, 'El archivo de autenticación está dañado; la operación se rechazó.', 'corrupt');
          }
        } else {
          base = this.data.users.length > 0 ? this.data : emptyData(new Date(this.now()).toISOString());
        }
        const draft = structuredClone(base);
        const result = fn(draft);
        draft.updatedAt = new Date(this.now()).toISOString();
        this.purge(draft);
        try {
          if (fs.existsSync(this.file)) {
            try {
              fs.copyFileSync(this.file, `${this.file}.bak`);
            } catch {
              /* la copia es un extra */
            }
          }
          this.writeAtomic(this.file, JSON.stringify(draft));
        } catch (err) {
          this.lastWriteError = err instanceof Error ? err.message : String(err);
          throw new AuthStoreError(503, 'No se pudo guardar el almacén de autenticación; la operación no se aplicó.', 'write_failed');
        }
        this.lastWriteError = null;
        this.data = draft;
        for (const s of draft.sessions) {
          const seen = this.lastSeen.get(s.idHash);
          if (seen !== undefined && seen > new Date(s.lastSeenAt).getTime() && !s.revokedAt) s.lastSeenAt = new Date(seen).toISOString();
          this.lastPersistedSeen.set(s.idHash, new Date(s.lastSeenAt).getTime());
        }
        this.snapshotStat();
        this.lastStatCheck = Date.now();
        return result;
      })
    );
  }

  private purge(d: AuthData) {
    const cutoff = this.now() - 24 * 3_600_000;
    d.sessions = d.sessions.filter((s) => {
      const end = s.revokedAt ? new Date(s.revokedAt).getTime() : new Date(s.absoluteExpiresAt).getTime();
      return end > cutoff;
    });
    for (const k of this.lastSeen.keys()) if (!d.sessions.some((s) => s.idHash === k)) this.lastSeen.delete(k);
  }

  private activeAdmins(d: AuthData, excludingId?: string) {
    return d.users.filter((u) => u.active && u.role === 'ADMIN' && u.id !== excludingId).length;
  }

  private revokeIn(d: AuthData, pred: (s: SessionRecord) => boolean, reason: string): number {
    const at = new Date(this.now()).toISOString();
    let n = 0;
    for (const s of d.sessions) {
      if (!s.revokedAt && pred(s)) {
        s.revokedAt = at;
        s.revokedReason = reason;
        n++;
      }
    }
    return n;
  }

  private emit(ev: { userId?: string; idHash?: string }) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* un oyente defectuoso no afecta a la revocación */
      }
    }
  }

  // ───────────── Usuarios ─────────────

  async createUser(input: { username: unknown; displayName?: unknown; role: Role; password: string; createdBy: string }): Promise<Omit<UserRecord, 'password'>> {
    const username = normalizeUsername(input.username);
    if (!username) throw new AuthStoreError(400, 'Nombre de usuario inválido: 3 a 40 caracteres entre a-z, 0-9, punto, guion y guion bajo.', 'bad_username');
    if (!ROLES.includes(input.role)) throw new AuthStoreError(400, 'Rol inválido.', 'bad_role');
    const problems = validatePasswordPolicy(input.password, username);
    if (problems.length) throw new AuthStoreError(400, problems.join(' '), 'weak_password');
    const displayName = (typeof input.displayName === 'string' ? input.displayName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '') || username;
    const password = await hashPassword(input.password, this.scryptParams);
    return this.mutate((d) => {
      if (d.users.some((u) => u.username === username)) throw new AuthStoreError(409, 'Ya existe un usuario con ese nombre.', 'duplicate');
      const nowIso = new Date(this.now()).toISOString();
      const user: UserRecord = {
        id: `usr_${crypto.randomBytes(8).toString('hex')}`,
        username,
        displayName,
        role: input.role,
        password,
        active: true,
        createdAt: nowIso,
        createdBy: input.createdBy,
        updatedAt: nowIso,
        passwordChangedAt: nowIso,
      };
      d.users.push(user);
      d.setupDisabled = true;
      d.setup = null;
      const { password: _p, ...rest } = user;
      return rest;
    });
  }

  async setPassword(userId: string, newPassword: string, opts: { keepSessionHash?: string; reason?: string } = {}): Promise<void> {
    const user = this.getUser(userId);
    if (!user) throw new AuthStoreError(404, 'Usuario no encontrado.', 'not_found');
    const problems = validatePasswordPolicy(newPassword, user.username);
    if (problems.length) throw new AuthStoreError(400, problems.join(' '), 'weak_password');
    const password = await hashPassword(newPassword, this.scryptParams);
    await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) throw new AuthStoreError(404, 'Usuario no encontrado.', 'not_found');
      const nowIso = new Date(this.now()).toISOString();
      u.password = password;
      u.passwordChangedAt = nowIso;
      u.updatedAt = nowIso;
      this.revokeIn(d, (s) => s.userId === userId && s.idHash !== opts.keepSessionHash, opts.reason ?? 'password_changed');
    });
    this.emit({ userId });
  }

  async setRole(userId: string, role: Role): Promise<void> {
    if (!ROLES.includes(role)) throw new AuthStoreError(400, 'Rol inválido.', 'bad_role');
    await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) throw new AuthStoreError(404, 'Usuario no encontrado.', 'not_found');
      if (u.role === 'ADMIN' && role !== 'ADMIN' && u.active && this.activeAdmins(d, u.id) === 0) throw new AuthStoreError(409, 'No se puede quitar el rol al último administrador activo.', 'last_admin');
      u.role = role;
      u.updatedAt = new Date(this.now()).toISOString();
      this.revokeIn(d, (s) => s.userId === userId, 'role_changed');
    });
    this.emit({ userId });
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) throw new AuthStoreError(404, 'Usuario no encontrado.', 'not_found');
      if (!active && u.role === 'ADMIN' && u.active && this.activeAdmins(d, u.id) === 0) throw new AuthStoreError(409, 'No se puede desactivar al último administrador activo.', 'last_admin');
      u.active = active;
      u.updatedAt = new Date(this.now()).toISOString();
      if (!active) this.revokeIn(d, (s) => s.userId === userId, 'user_deactivated');
    });
    if (!active) this.emit({ userId });
  }

  /** Verifica credenciales. No distingue usuario inexistente de contraseña errónea (el llamador iguala el tiempo). */
  async verifyCredentials(username: unknown, password: unknown): Promise<UserRecord | null> {
    const user = this.findByUsername(username);
    if (!user || !user.active) return null;
    return (await verifyPassword(password, user.password)) ? user : null;
  }

  // ───────────── Sesiones ─────────────

  async createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; session: SessionRecord }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const idHash = sha256Hex(token);
    const session = await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u || !u.active) throw new AuthStoreError(401, 'Usuario inactivo.', 'inactive');
      const nowMs = this.now();
      const mine = d.sessions.filter((s) => s.userId === userId && !s.revokedAt && new Date(s.absoluteExpiresAt).getTime() > nowMs).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      while (mine.length >= this.maxSessions) {
        const oldest = mine.shift()!;
        oldest.revokedAt = new Date(nowMs).toISOString();
        oldest.revokedReason = 'session_limit';
      }
      const s: SessionRecord = {
        idHash,
        userId,
        role: u.role,
        createdAt: new Date(nowMs).toISOString(),
        lastSeenAt: new Date(nowMs).toISOString(),
        absoluteExpiresAt: new Date(nowMs + this.absoluteMs).toISOString(),
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160),
      };
      d.sessions.push(s);
      return s;
    });
    this.lastSeen.set(idHash, this.now());
    return { token, session };
  }

  /** Resuelve y valida una sesión en cada petición: vigencia, inactividad, usuario activo y rol sin cambios. */
  resolveSession(token: unknown): SessionContext | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    this.reloadIfChanged();
    const idHash = sha256Hex(token);
    const s = this.data.sessions.find((x) => x.idHash === idHash);
    if (!s || s.revokedAt) return null;
    const nowMs = this.now();
    if (nowMs >= new Date(s.absoluteExpiresAt).getTime()) return null;
    const seen = this.lastSeen.get(idHash) ?? new Date(s.lastSeenAt).getTime();
    if (nowMs - seen >= this.idleMs) return null;
    const user = this.data.users.find((u) => u.id === s.userId);
    if (!user || !user.active) return null;
    if (user.role !== s.role) {
      void this.revokeSession(idHash, 'role_changed').catch(() => undefined);
      return null;
    }
    this.lastSeen.set(idHash, nowMs);
    const persisted = this.lastPersistedSeen.get(idHash) ?? new Date(s.lastSeenAt).getTime();
    if (nowMs - persisted > TOUCH_PERSIST_MS && !this.dirtyTouch) {
      this.dirtyTouch = true;
      void this.mutate((d) => {
        const m = d.sessions.find((x) => x.idHash === idHash);
        if (m && !m.revokedAt) m.lastSeenAt = new Date(nowMs).toISOString();
      })
        .catch(() => undefined)
        .finally(() => {
          this.dirtyTouch = false;
        });
    }
    return { user, session: s };
  }

  /**
   * Validez de una sesión SIN renovarla (no actualiza la última actividad). La usa el flujo de eventos, que es pasivo:
   * mantener abierto el flujo no cuenta como actividad. Comprueba también la inactividad (corrección de F3).
   */
  isSessionValid(idHash: string): boolean {
    this.reloadIfChanged();
    const s = this.data.sessions.find((x) => x.idHash === idHash);
    if (!s || s.revokedAt) return false;
    const nowMs = this.now();
    if (nowMs >= new Date(s.absoluteExpiresAt).getTime()) return false;
    const seen = this.lastSeen.get(idHash) ?? new Date(s.lastSeenAt).getTime();
    if (nowMs - seen >= this.idleMs) return false;
    const user = this.data.users.find((u) => u.id === s.userId);
    return Boolean(user && user.active && user.role === s.role);
  }

  async revokeSession(idHash: string, reason: string): Promise<void> {
    // Se revoca primero en memoria (dirección segura) y después se persiste.
    const mem = this.data.sessions.find((x) => x.idHash === idHash);
    if (mem && !mem.revokedAt) {
      mem.revokedAt = new Date(this.now()).toISOString();
      mem.revokedReason = reason;
    }
    this.emit({ idHash });
    await this.mutate((d) => {
      this.revokeIn(d, (s) => s.idHash === idHash, reason);
    });
  }

  async revokeUserSessions(userId: string, reason: string, exceptHash?: string): Promise<number> {
    const n = await this.mutate((d) => this.revokeIn(d, (s) => s.userId === userId && s.idHash !== exceptHash, reason));
    this.emit({ userId });
    return n;
  }

  activeSessionCount(userId?: string): number {
    const nowMs = this.now();
    return this.data.sessions.filter((s) => !s.revokedAt && new Date(s.absoluteExpiresAt).getTime() > nowMs && (!userId || s.userId === userId)).length;
  }

  // ───────────── Configuración inicial (primer administrador) ─────────────

  /**
   * Genera un código de un solo uso (160 bits de un CSPRNG). Solo se guarda su hash; el texto plano se devuelve
   * una vez para mostrarlo en la consola del servidor. Devuelve null si ya existe algún usuario.
   */
  async issueSetupCode(): Promise<{ code: string; expiresAt: string } | null> {
    if (this.hasUsers() || this.setupDisabledPermanently()) return null;
    const raw = crypto.randomBytes(20);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    let bits = 0;
    let value = 0;
    for (const b of raw) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        code += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    const grouped = code.match(/.{1,4}/g)!.join('-');
    const expiresAt = new Date(this.now() + this.setupTtlMs).toISOString();
    await this.mutate((d) => {
      if (d.users.length > 0 || d.setupDisabled) throw new AuthStoreError(409, 'La configuración inicial ya no está disponible.', 'setup_disabled');
      d.setup = { codeHash: sha256Hex(normalizeSetupCode(grouped)), expiresAt, failedAttempts: 0 };
    });
    return { code: grouped, expiresAt };
  }

  async consumeSetup(code: unknown, input: { username: unknown; displayName?: unknown; password: string }): Promise<Omit<UserRecord, 'password'>> {
    if (this.setupDisabledPermanently()) throw new AuthStoreError(404, 'No encontrado.', 'setup_disabled');
    const username = normalizeUsername(input.username);
    if (!username) throw new AuthStoreError(400, 'Nombre de usuario inválido: 3 a 40 caracteres entre a-z, 0-9, punto, guion y guion bajo.', 'bad_username');
    const problems = validatePasswordPolicy(input.password, username);
    if (problems.length) throw new AuthStoreError(400, problems.join(' '), 'weak_password');
    const displayName = (typeof input.displayName === 'string' ? input.displayName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '') || username;
    const password = await hashPassword(input.password, this.scryptParams);
    const provided = typeof code === 'string' ? sha256Hex(normalizeSetupCode(code)) : '';
    // La comprobación del código y la creación son una sola operación atómica: dos canjes simultáneos no pueden ganar los dos.
    let failure: AuthStoreError | null = null;
    const created = await this.mutate((d) => {
      const s = d.setup;
      if (d.setupDisabled || d.users.length > 0) throw new AuthStoreError(404, 'No encontrado.', 'setup_disabled');
      if (!s || new Date(s.expiresAt).getTime() <= this.now()) throw new AuthStoreError(410, 'El código de configuración expiró o no existe. Reinicia el servidor o usa el CLI.', 'setup_expired');
      const ok = provided.length === 64 && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(s.codeHash));
      if (!ok) {
        s.failedAttempts++;
        if (s.failedAttempts >= SETUP_MAX_ATTEMPTS) d.setup = null;
        failure = new AuthStoreError(s.failedAttempts >= SETUP_MAX_ATTEMPTS ? 410 : 403, s.failedAttempts >= SETUP_MAX_ATTEMPTS ? 'Demasiados intentos: el código se invalidó. Reinicia el servidor o usa el CLI.' : 'Código de configuración incorrecto.', 'bad_code');
        return null;
      }
      const nowIso = new Date(this.now()).toISOString();
      const user: UserRecord = {
        id: `usr_${crypto.randomBytes(8).toString('hex')}`,
        username,
        displayName,
        role: 'ADMIN',
        password,
        active: true,
        createdAt: nowIso,
        createdBy: 'setup',
        updatedAt: nowIso,
        passwordChangedAt: nowIso,
      };
      d.users.push(user);
      d.setup = null;
      d.setupDisabled = true;
      const { password: _p, ...rest } = user;
      return rest;
    });
    if (failure) throw failure;
    return created!;
  }
}

export function normalizeSetupCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
