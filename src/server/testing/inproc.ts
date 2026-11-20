import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AppHandle, AppOptions, createApp } from '../app';
import { AuthStore } from '../authStore';
import { loadSecurityConfig } from '../netSecurity';
import { FAST_SCRYPT, Session, TEST_USERS, TestUserKey } from './harness';

/**
 * Servidor en el mismo proceso, con red real (socket en 127.0.0.1) y reloj inyectable. Sirve para probar caducidad de
 * sesiones, ventanas de límites de tasa y fallos de disco sin esperar tiempo real. Las pruebas HTTP son reales: pasan por
 * toda la tubería de Express (Host, Origin, cookies, CSRF, permisos, auditoría).
 */
export interface InProc {
  base: string;
  port: number;
  dir: string;
  statePath: string;
  handle: AppHandle;
  clock: { now(): number; advance(ms: number): number };
  session(user: TestUserKey): Promise<Session>;
  anon(): Session;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface InProcOptions {
  production?: boolean;
  env?: Record<string, string>;
  rateLimits?: AppOptions['rateLimits'];
  noUsers?: boolean;
  setupEnabled?: boolean;
  auditAppendLine?: AppOptions['auditAppendLine'];
  authStoreOptions?: AppOptions['authStoreOptions'];
  dir?: string;
  trustedProxies?: string;
}

export async function startInProc(opts: InProcOptions = {}): Promise<InProc> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-inproc-'));
  const statePath = path.join(dir, 'state.json');
  const port = await freePort();
  let t = Date.parse('2026-06-01T12:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const production = opts.production !== false;
  const securityEnv: Record<string, string | undefined> = production
    ? { NODE_ENV: 'production', AQUA_ALLOWED_HOSTS: `127.0.0.1:${port}`, AQUA_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`, AQUA_TRUSTED_PROXIES: opts.trustedProxies }
    : { AQUA_TRUSTED_PROXIES: opts.trustedProxies };
  const cfg = loadSecurityConfig(securityEnv);
  const authPath = path.join(dir, 'auth.json');
  if (!opts.noUsers && !fs.existsSync(authPath)) {
    const store = AuthStore.open(authPath, { scrypt: FAST_SCRYPT });
    for (const u of Object.values(TEST_USERS)) await store.createUser({ username: u.username, displayName: u.displayName, role: u.role, password: u.password, createdBy: 'test-harness' });
  }
  const handle = await createApp({
    statePath,
    security: cfg,
    now: clock.now,
    rateLimits: opts.rateLimits ?? { admin: { max: 1000, windowMs: 600000 }, ai: { max: 1000, windowMs: 60000 }, upload: { max: 1000, windowMs: 600000 }, 'ai-probe': { max: 1000, windowMs: 600000 }, reauth: { max: 1000, windowMs: 600000 } },
    env: { ...(production ? { NODE_ENV: 'production' } : {}), GEMINI_API_KEY: '', ...opts.env },
    authStoreOptions: { scrypt: FAST_SCRYPT, ...opts.authStoreOptions },
    auditAppendLine: opts.auditAppendLine,
    setupEnabled: opts.setupEnabled,
  });
  const server = http.createServer(handle.app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    dir,
    statePath,
    handle,
    clock,
    session: async (user) => new Session(base).as(user),
    anon: () => new Session(base),
    close: async () => {
      handle.shutdown();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Petición HTTP con control total de la cabecera Host (fetch no permite sobrescribirla). */
export function rawRequest(
  base: string,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), path: opts.path, method: opts.method ?? 'GET', headers: opts.headers, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
