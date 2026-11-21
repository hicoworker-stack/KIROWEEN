import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { csrfForSession } from './authApi';
import { AuthStore } from './authStore';
import { hostAllowed, SecurityConfig } from './netSecurity';

/**
 * REQ-PUB-02: preparación de la instancia PÚBLICA de demostración.
 *
 * Los visitantes anónimos solo pueden leer. Para que haya algo que explorar (un incidente, su diagnóstico, una foto y una
 * orden de trabajo en curso), al arrancar una instancia pública con el estado sin estrenar se ejecuta el flujo real
 * contra la propia API (escenario de fuga, decisión, orden en curso con tareas y foto), con una sesión interna y efímera de OPERADOR. No hay atajos: pasa por la misma validación, los
 * mismos permisos, el mismo CSRF, el mismo ledger y la misma auditoría que cualquier otro usuario.
 *
 * La cuenta interna `demo.seed`:
 *  - es OPERATOR (no administradora), con una contraseña aleatoria que nunca se guarda ni se muestra;
 *  - queda DESACTIVADA al terminar y su sesión revocada;
 *  - aparece en el ledger y en la auditoría como «Preparación de la demostración (@demo.seed, OPERATOR)».
 */

export const SEED_USERNAME = 'demo.seed';
const SEED_DISPLAY_NAME = 'Preparación de la demostración';
const STALE_AFTER_MS = 12 * 3_600_000;

export interface SeedOptions {
  authStore: AuthStore;
  cfg: SecurityConfig;
  port: number;
  /** Dirección donde escucha el servidor (0.0.0.0 y :: se contactan por loopback). */
  host?: string;
  /** Carpeta con las fotos de ejemplo. Por defecto src/assets/images. */
  assetsDir?: string;
  log?: (message: string) => void;
}

export interface SeedResult {
  seeded: boolean;
  reason?: string;
  anomalyId?: string;
  orderId?: string;
}

interface Reply {
  status: number;
  data: any;
}

function call(o: { port: number; host: string; hostHeader: string; cookie?: string; csrf?: string }, method: string, url: string, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.hostHeader };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.csrf) headers['x-csrf-token'] = o.csrf;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({ host: o.host, port: o.port, path: url, method, headers, setHost: false, timeout: 60_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          /* no es JSON */
        }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function findPhoto(dir: string): { base64: string; mime: string } | null {
  try {
    const file = fs
      .readdirSync(dir)
      .filter((f) => /^incident_pipe_leak_.*\.jpe?g$/i.test(f))
      .sort()[0];
    if (!file) return null;
    return { base64: fs.readFileSync(path.join(dir, file)).toString('base64'), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Siembra la demostración si el estado está sin estrenar. Es idempotente: si ya hay incidentes u órdenes, no hace nada. */
export async function seedPublicDemo(opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const host = !opts.host || opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
  const preferred = `127.0.0.1:${opts.port}`;
  const hostHeader = hostAllowed(preferred, opts.cfg) ? preferred : (opts.cfg.allowedHosts.find((h) => !h.includes('*')) ?? preferred);
  const base = { port: opts.port, host, hostHeader };

  // El visitante anónimo ya puede leer el estado: se usa para saber si hay algo sembrado.
  const current = await call(base, 'GET', '/api/state');
  if (current.status !== 200) return { seeded: false, reason: `No se pudo leer el estado (HTTP ${current.status}).` };
  if (current.data.anomalies?.length > 0 || current.data.workOrders?.length > 0) return { seeded: false, reason: 'El estado ya tiene incidentes u órdenes.' };

  const store = opts.authStore;
  let user = store.findByUsername(SEED_USERNAME);
  if (!user) {
    const password = `${crypto.randomBytes(24).toString('base64url')}-Aa1!`;
    await store.createUser({ username: SEED_USERNAME, displayName: SEED_DISPLAY_NAME, role: 'OPERATOR', password, createdBy: 'public-demo-seed' });
    user = store.findByUsername(SEED_USERNAME);
  }
  if (!user) return { seeded: false, reason: 'No se pudo preparar la cuenta interna de sembrado.' };
  if (user.role !== 'OPERATOR') return { seeded: false, reason: `La cuenta ${SEED_USERNAME} existe con el rol ${user.role}, no OPERATOR: no se usa.` };

  await store.setActive(user.id, true);
  const { token, session } = await store.createSession(user.id, { userAgent: 'aqua-sentinel-public-demo-seed' });
  const api = { ...base, cookie: `${opts.cfg.production ? '__Host-aqua_sid' : 'aqua_sid'}=${token}`, csrf: csrfForSession(session.idHash) };
  const must = (r: Reply, what: string) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${typeof r.data === 'object' ? (r.data?.error ?? '') : ''}`.trim());
    return r.data;
  };

  try {
    const trigger = must(await call(api, 'POST', '/api/scenarios/leak/trigger', {}), 'Escenario de fuga');
    const anomaly = trigger.anomaly;
    const diagnosis = trigger.diagnosis;
    if (!anomaly || !diagnosis) throw new Error('El escenario no generó incidente y diagnóstico.');

    // El escenario ya vincula al incidente su foto de ejemplo (sin analizar: no hay proveedor de visión). Aquí solo se prepara la foto de la orden.
    const photo = findPhoto(opts.assetsDir ?? path.resolve(process.cwd(), 'src', 'assets', 'images'));
    if (!photo) log('[demo pública] No se encontró la foto de ejemplo; la orden se siembra sin fotografía.');

    const decision = must(
      await call(api, 'POST', `/api/diagnoses/${diagnosis.id}/decision`, { decision: 'accepted', operatorNote: 'Aceptada al preparar la instancia pública de demostración (datos simulados).' }),
      'Decisión'
    );
    const order = decision.createdOrder;
    if (!order) throw new Error('La decisión no creó la orden de trabajo.');

    must(await call(api, 'PATCH', `/api/work-orders/${order.id}`, { status: 'En Progreso' }), 'Iniciar la orden');
    for (const item of (order.checklist ?? []).slice(0, 2)) must(await call(api, 'PATCH', `/api/work-orders/${order.id}/checklist/${item.id}`, { done: true }), 'Tarea');
    if (photo) {
      must(await call(api, 'POST', `/api/work-orders/${order.id}/evidence`, { fileName: 'foto-de-demostracion.jpg', dataUrl: `data:${photo.mime};base64,${photo.base64}` }), 'Foto de la orden');
    }
    log(`[demo pública] Demostración sembrada: incidente ${anomaly.id}, orden ${order.id} en curso.`);
    return { seeded: true, anomalyId: anomaly.id, orderId: order.id };
  } finally {
    await store.revokeSession(session.idHash, 'seed_done').catch(() => undefined);
    await store.setActive(user.id, false).catch(() => undefined);
  }
}

/**
 * Los tiempos de una demostración envejecen («detectado hace 3 días»). Si el archivo de estado de la instancia pública
 * lleva más de 12 h sin modificarse, se elimina ANTES de arrancar para que se vuelva a sembrar con datos frescos.
 * Solo se borra ese archivo (estado sintético y desechable): usuarios, auditoría y clave de sellado no se tocan.
 * Se desactiva con AQUA_PUBLIC_KEEP_STATE=1.
 */
export function refreshStalePublicState(statePath: string, now: number = Date.now(), maxAgeMs: number = STALE_AFTER_MS): boolean {
  try {
    const age = now - fs.statSync(statePath).mtimeMs;
    if (age <= maxAgeMs) return false;
    fs.rmSync(statePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
