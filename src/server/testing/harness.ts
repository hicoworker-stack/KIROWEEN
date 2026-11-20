import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthStore } from '../authStore';

/**
 * Arnés de pruebas e2e: arranca server.ts como proceso real y habla con él por HTTP, con sesiones reales.
 * Antes de arrancar crea usuarios en auth.json como lo haría el CLI de recuperación (no hay credenciales por defecto
 * en el código: estas existen solo en archivos temporales de prueba). Sus hashes usan parámetros scrypt reducidos
 * (se guardan con cada hash) para que las pruebas no tarden; el servidor de producción usa los parámetros completos.
 */
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keyLen: 32 };
export const TEST_USERS = {
  admin: { username: 'admin.test', password: 'Admin-Prueba-2026!', role: 'ADMIN' as const, displayName: 'Admin de Prueba' },
  operator: { username: 'operador.test', password: 'Operador-Prueba-2026!', role: 'OPERATOR' as const, displayName: 'Operador de Prueba' },
  viewer: { username: 'lector.test', password: 'Lector-Prueba-2026!', role: 'VIEWER' as const, displayName: 'Lector de Prueba' },
};
export type TestUserKey = keyof typeof TEST_USERS;

export const FAKE_GEMINI = pathToFileURL(path.resolve(process.cwd(), 'src/server/testing/fakeGemini.mjs')).href;

export interface RunningServer {
  base: string;
  dir: string;
  statePath: string;
  authPath: string;
  auditPath: string;
  modeFile: string;
  geminiLog: string;
  logs(): string;
  isAlive(): boolean;
  stop(): Promise<void>;
  restart(extraEnv?: Record<string, string>): Promise<void>;
  setMode(mode: string): void;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ───────────── Sesiones de prueba ─────────────

export class Session {
  cookies = new Map<string, string>();
  csrf = '';
  user: { id: string; username: string; role: string } | null = null;
  constructor(readonly base: string) {}

  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/;\s*Max-Age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get sid() {
    for (const [k, v] of this.cookies) if (/aqua_sid$/.test(k)) return v;
    return '';
  }
  set sid(value: string) {
    for (const k of [...this.cookies.keys()]) if (/aqua_sid$/.test(k)) this.cookies.set(k, value);
  }
  async status() {
    const res = await fetch(`${this.base}/api/auth/status`, { headers: this.cookies.size ? { cookie: this.cookieHeader() } : {} });
    this.absorb(res);
    const data = await res.json();
    this.csrf = data.csrfToken ?? this.csrf;
    return data;
  }
  async login(username: string, password: string): Promise<{ status: number; data: any }> {
    await this.status();
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookieHeader(), 'x-csrf-token': this.csrf },
      body: JSON.stringify({ username, password }),
    });
    this.absorb(res);
    const data = await res.json().catch(() => ({}));
    if (res.status === 200) {
      this.csrf = data.csrfToken;
      this.user = data.user;
    }
    return { status: res.status, data };
  }
  async as(user: TestUserKey) {
    const r = await this.login(TEST_USERS[user].username, TEST_USERS[user].password);
    if (r.status !== 200) throw new Error(`No se pudo iniciar sesión como ${user}: ${r.status} ${JSON.stringify(r.data)}`);
    return this;
  }
  async request<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const h: Record<string, string> = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    if (this.cookies.size && !('cookie' in h)) h.cookie = this.cookieHeader();
    if (this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf;
    const res = await fetch(`${this.base}${url}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    this.absorb(res);
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* no JSON */
    }
    return { status: res.status, data, headers: res.headers };
  }
  /** Token de operación destructiva (reautenticación con la contraseña). */
  async opHeaders(op: 'reset' | 'demo' | 'import', password: string): Promise<Record<string, string>> {
    const r = await this.request('POST', '/api/admin/operation-token', { operation: op, password });
    if (r.status !== 200) throw new Error(`No se obtuvo token de operación: ${r.status} ${JSON.stringify(r.data)}`);
    return { 'x-aqua-confirm': op, 'x-operation-token': r.data.token };
  }
}

const defaultSessions = new Map<string, Session>();
let lastBase = '';

export async function startServer(
  options: { env?: Record<string, string>; fakeGemini?: boolean; dir?: string; rateLimits?: 'default' | Record<string, unknown>; noDefaultLogin?: boolean; noUsers?: boolean; production?: boolean } = {}
): Promise<RunningServer> {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-e2e-'));
  const statePath = path.join(dir, 'state.json');
  const authPath = path.join(dir, 'auth.json');
  const auditPath = path.join(dir, 'audit.jsonl');
  const modeFile = path.join(dir, 'gemini-mode.txt');
  const geminiLog = path.join(dir, 'gemini.log');
  fs.writeFileSync(modeFile, 'ok');
  fs.writeFileSync(geminiLog, '');
  if (!options.noUsers && !fs.existsSync(authPath)) {
    const store = AuthStore.open(authPath, { scrypt: FAST_SCRYPT });
    for (const u of Object.values(TEST_USERS)) await store.createUser({ username: u.username, displayName: u.displayName, role: u.role, password: u.password, createdBy: 'test-harness' });
  }
  let proc: ChildProcess | null = null;
  let logs = '';
  let base = '';
  let envNow: Record<string, string> = { ...(options.env ?? {}) };

  async function boot(extra: Record<string, string> = {}) {
    envNow = { ...envNow, ...extra };
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const args = ['--import', 'tsx'];
    if (options.fakeGemini) args.push('--import', FAKE_GEMINI);
    args.push('server.ts');
    const loosened = options.rateLimits === 'default' ? undefined : JSON.stringify(options.rateLimits ?? { admin: { max: 1000, windowMs: 600000 }, ai: { max: 1000, windowMs: 60000 }, upload: { max: 1000, windowMs: 600000 }, 'ai-probe': { max: 1000, windowMs: 600000 } });
    proc = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: options.production === false ? 'development' : 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        AQUA_STATE_PATH: statePath,
        AQUA_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
        AQUA_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        ...(loosened ? { AQUA_RATE_LIMITS: loosened } : {}),
        GEMINI_API_KEY: options.fakeGemini ? 'AIzaSyTEST_FAKE_KEY_0000000000000000' : '',
        FAKE_GEMINI_MODE_FILE: modeFile,
        FAKE_GEMINI_LOG: geminiLog,
        ...envNow,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => (logs += d.toString()));
    proc.stderr?.on('data', (d) => (logs += d.toString()));
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* aún no escucha */
      }
      if (proc.exitCode !== null) throw new Error(`El servidor terminó al arrancar (código ${proc.exitCode}). Logs:\n${logs}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`El servidor no arrancó a tiempo. Logs:\n${logs}`);
    lastBase = base;
    if (!options.noDefaultLogin && !options.noUsers) {
      const s = new Session(base);
      await s.as('admin');
      defaultSessions.set(base, s);
    }
  }

  async function stop() {
    if (!proc) return;
    const p = proc;
    proc = null;
    defaultSessions.delete(base);
    await new Promise<void>((resolve) => {
      if (p.exitCode !== null) return resolve();
      p.once('exit', () => resolve());
      p.kill();
      setTimeout(resolve, 3000);
    });
  }

  await boot();
  const handle: RunningServer = {
    get base() {
      return base;
    },
    dir,
    statePath,
    authPath,
    auditPath,
    modeFile,
    geminiLog,
    logs: () => logs,
    isAlive: () => proc !== null && proc.exitCode === null,
    stop,
    restart: async (extra) => {
      await stop();
      await boot(extra);
    },
    setMode: (m) => fs.writeFileSync(modeFile, m),
  };
  return handle;
}

/** Sesión por defecto (ADMIN) del servidor de prueba: así las pruebas existentes siguen escribiéndose igual. */
export const defaultSession = (base: string) => {
  const s = defaultSessions.get(base);
  if (!s) throw new Error(`No hay sesión por defecto para ${base}`);
  return s;
};

export async function api<T = any>(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const s = defaultSessions.get(base);
  if (s) {
    const r = await s.request<T>(method, url, body, headers);
    return { status: r.status, data: r.data };
  }
  return anonApi<T>(base, method, url, body, headers);
}

/** fetch crudo con la sesión por defecto (cookie y CSRF), para respuestas binarias o cuerpos no JSON. */
export const authedFetch = (base: string, url: string, init: RequestInit = {}): Promise<Response> => {
  const s = defaultSession(base);
  const h = new Headers(init.headers);
  if (s.cookies.size) h.set('cookie', s.cookieHeader());
  if (s.csrf) h.set('x-csrf-token', s.csrf);
  return fetch(`${base}${url}`, { ...init, headers: h });
};

/** Petición SIN sesión ni cookies. */
export async function anonApi<T = any>(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* no JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

/** Cabeceras de una operación destructiva con token de un solo uso, usando la sesión por defecto (ADMIN). */
export const admin = async (op: 'reset' | 'demo' | 'import', base?: string): Promise<Record<string, string>> =>
  defaultSession(base ?? [...defaultSessions.keys()].pop() ?? lastBase).opHeaders(op, TEST_USERS.admin.password);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera hasta que la condición se cumpla o falla con el último valor observado. */
export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000, everyMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(everyMs);
    last = await fn();
  }
  return last;
}

/** PNG de 1x1 válido (firma real). */
export const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
