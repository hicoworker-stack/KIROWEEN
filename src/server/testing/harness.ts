import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Arnés de pruebas e2e: arranca server.ts como proceso real y habla con él por HTTP. */

export const ADMIN_TOKEN = 'token-de-prueba-0123456789';
export const FAKE_GEMINI = pathToFileURL(path.resolve(process.cwd(), 'src/server/testing/fakeGemini.mjs')).href;

export interface RunningServer {
  base: string;
  dir: string;
  statePath: string;
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

export async function startServer(options: { env?: Record<string, string>; fakeGemini?: boolean; dir?: string } = {}): Promise<RunningServer> {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-e2e-'));
  const statePath = path.join(dir, 'state.json');
  const modeFile = path.join(dir, 'gemini-mode.txt');
  const geminiLog = path.join(dir, 'gemini.log');
  fs.writeFileSync(modeFile, 'ok');
  fs.writeFileSync(geminiLog, '');
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
    proc = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        AQUA_STATE_PATH: statePath,
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
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) return;
      } catch {
        /* aún no escucha */
      }
      if (proc.exitCode !== null) throw new Error(`El servidor terminó al arrancar (código ${proc.exitCode}). Logs:\n${logs}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`El servidor no arrancó a tiempo. Logs:\n${logs}`);
  }

  async function stop() {
    if (!proc) return;
    const p = proc;
    proc = null;
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

export async function api<T = any>(
  base: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
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
  return { status: res.status, data };
}

export const admin = (op: 'reset' | 'demo' | 'import', token: string | null = ADMIN_TOKEN): Record<string, string> => ({
  'x-aqua-confirm': op,
  ...(token ? { 'x-admin-token': token } : {}),
});

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
