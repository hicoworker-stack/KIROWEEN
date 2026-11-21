import crypto from 'node:crypto';
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import './requestContext';
import { AuditActor, AuditLog } from './auditLog';
import { AUTHENTICATED_ONLY, can, isPublicRoute, needs, Permission } from './authz';
import { AuthStore, normalizeUsername, ROLES, Role, sha256Hex, UserRecord } from './authStore';
import { HttpError } from './http';
import { clientIpOf, hostGuard, originGuard, SecurityConfig, securityHeaders, useSecureCookie } from './netSecurity';
import { DESTRUCTIVE_OPERATIONS, DestructiveOperation, OperationTokens } from './operationTokens';
import { burnPasswordTime, verifyPassword } from './passwords';
import { isPublicReadRoute } from './publicMode';
import { BucketName, HitResult, RateLimiter } from './rateLimit';

/**
 * REQ-AUTH-01..04, REQ-AUTHZ-01, REQ-SEC-03..05: tubería de seguridad y rutas de autenticación.
 *
 * Orden de la tubería (todo ocurre ANTES de leer cuerpos grandes o de ejecutar lógica de negocio):
 *   contexto → cabeceras → Host → Origin → auditoría → sesión/CSRF/límites → cuerpo JSON pequeño → rutas (permiso + cupo).
 * Las rutas no públicas exigen sesión por defecto (denegación por defecto); cada ruta declara además su permiso.
 */

export interface SecurityDeps {
  cfg: SecurityConfig;
  store: AuthStore;
  audit: AuditLog;
  limiter: RateLimiter;
  opTokens: OperationTokens;
  /** ¿Está habilitado el asistente de primer administrador por HTTP? (en producción se prefiere el CLI). */
  setupEnabled: boolean;
  sessionMaxAgeSec: number;
  /** Secreto del proceso para los tokens CSRF previos a la sesión (se regenera en cada arranque). */
  processSecret?: Buffer;
  /** MODO PÚBLICO (AQUA_PUBLIC_MODE): admite visitantes anónimos solo en las rutas GET de publicMode.ts. */
  publicMode?: boolean;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sidName = (secure: boolean) => (secure ? '__Host-aqua_sid' : 'aqua_sid');
const preName = (secure: boolean) => (secure ? '__Host-aqua_pre' : 'aqua_pre');

/** Rutas cuyas lecturas también se auditan (datos sensibles o costosos). */
const SENSITIVE_READS = [/^\/api\/state\/export$/, /^\/api\/work-orders\/[^/]+\/dossier$/, /^\/api\/audit/, /^\/api\/users/, /^\/api\/ledger\/anchor$/];

/** Rutas que aceptan cuerpos grandes: su lector JSON va DESPUÉS de comprobar sesión y permiso. */
export const BIG_BODY_ROUTES: Array<{ re: RegExp; limit: string }> = [
  { re: /^\/api\/state\/import$/, limit: '12mb' },
  { re: /^\/api\/ai\/vision-analyze$/, limit: '9mb' },
  { re: /^\/api\/work-orders\/[^/]+\/evidence$/, limit: '9mb' },
  { re: /^\/api\/sync\/offline$/, limit: '12mb' },
  { re: /^\/api\/(dossier|ledger)\/verify$/, limit: '12mb' },
  { re: /^\/api\/telemetry\/ingest$/, limit: '3mb' },
];

const parsers = new Map<string, RequestHandler>();
export function jsonBody(limit: string): RequestHandler {
  let p = parsers.get(limit);
  if (!p) {
    p = express.json({ limit, strict: true });
    parsers.set(limit, p);
  }
  return p;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || header.length > 4096) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) out[k] = v; // si hay duplicados manda el primero
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, opts: { secure: boolean; maxAgeSec: number }) {
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${opts.secure ? '; Secure' : ''}; Max-Age=${opts.maxAgeSec}`);
}

export const csrfForSession = (idHash: string) => crypto.createHmac('sha256', idHash).update('aqua-csrf-v1').digest('base64url');

const equal = (a: string, b: string) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const userView = (u: Pick<UserRecord, 'id' | 'username' | 'displayName' | 'role' | 'active'>) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active });

export const actorOf = (req: Request): AuditActor =>
  req.auditActor ?? (req.auth ? { kind: 'user', id: req.auth.user.id, username: req.auth.user.username, role: req.auth.user.role } : { kind: 'anonymous', id: null });

/** Texto de actor para el ledger: identidad AUTENTICADA, nunca un nombre declarado por el cliente. */
export const actorLabel = (user: Pick<UserRecord, 'displayName' | 'username' | 'role'>) => `${user.displayName} (@${user.username}, ${user.role})`;

function tooMany(res: Response, r: HitResult, what = 'solicitudes') {
  res.setHeader('Retry-After', String(r.retryAfterSec));
  res.setHeader('RateLimit-Limit', String(r.limit));
  res.setHeader('RateLimit-Remaining', String(r.remaining));
  res.status(429).json({ error: `Demasiadas ${what}. Espera ${r.retryAfterSec} s antes de reintentar.`, retryAfterSec: r.retryAfterSec });
}

/** Cupo por usuario autenticado para una ruta concreta (IA, fotografías, administración). */
export function limitUser(deps: SecurityDeps, bucket: BucketName): RequestHandler {
  return (req, res, next) => {
    const r = deps.limiter.hit(bucket, req.auth?.user.id ?? req.clientIp);
    if (!r.allowed) {
      req.auditDenied = { reason: `cupo ${bucket} agotado` };
      return tooMany(res, r);
    }
    next();
  };
}

/** Lector JSON para rutas grandes: se coloca DESPUÉS de needs() y limitUser(). */
export const bigBody = (path: RegExp | string): RequestHandler => {
  const limit = BIG_BODY_ROUTES.find((b) => (typeof path === 'string' ? b.re.test(path) : b.re.source === path.source))?.limit ?? '100kb';
  return jsonBody(limit);
};

export function installSecurityPipeline(app: Express, deps: SecurityDeps): void {
  const { cfg, store, audit, limiter } = deps;
  const secret = deps.processSecret ?? crypto.randomBytes(32);
  app.set('trust proxy', false); // las cabeceras de proxy las interpreta netSecurity, solo desde proxys listados

  const denyAudit = (req: Request, reason: string) => {
    if (!limiter.hit('deny-log', req.clientIp).allowed) return;
    void audit.recordBestEffort({ actor: { kind: 'anonymous', id: null }, ip: req.clientIp, action: 'network.denied', resource: req.method, outcome: 'denied', status: 403, reason, requestId: req.requestId, meta: { path: req.path.slice(0, 80) } });
  };

  app.use((req, res, next) => {
    req.requestId = crypto.randomBytes(6).toString('hex');
    req.clientIp = clientIpOf(req, cfg);
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(securityHeaders(cfg));
  app.use(hostGuard(cfg, denyAudit));
  app.use(originGuard(cfg, denyAudit));

  // Auditoría: toda escritura, toda denegación y las lecturas sensibles. Nunca el cuerpo ni las cabeceras.
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      const status = res.statusCode;
      const pathOnly = req.originalUrl.split('?')[0];
      const denied = status === 401 || status === 403 || status === 429 || status === 421;
      const sensitive = req.method === 'GET' && SENSITIVE_READS.some((re) => re.test(pathOnly));
      if (!UNSAFE.has(req.method) && !denied && !sensitive) return;
      if (denied && !limiter.hit('deny-log', req.clientIp).allowed) return;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : pathOnly;
      const x = req.auditExtra;
      void audit.recordBestEffort({
        actor: actorOf(req),
        ip: req.clientIp,
        action: x?.action ?? `${req.method} ${route}`,
        resource: x?.resource ?? (typeof (req.params as Record<string, unknown> | undefined)?.id === 'string' ? String((req.params as Record<string, unknown>).id) : null),
        outcome: denied ? 'denied' : status >= 500 ? 'error' : status >= 400 ? 'failure' : 'success',
        status,
        reason: req.auditDenied?.reason,
        requestId: req.requestId,
        meta: { ...x?.meta },
      });
    });
    next();
  });

  // Sesión, CSRF y cupos.
  app.use('/api', (req, res, next) => {
    const secure = useSecureCookie(req, cfg);
    const token = parseCookies(req.headers.cookie)[sidName(secure)];
    const resolved = token ? store.resolveSession(token) : null;
    if (resolved) req.auth = { user: resolved.user, session: resolved.session, csrf: csrfForSession(resolved.session.idHash) };

    const r = req.auth ? limiter.hit('api-user', req.auth.user.id) : limiter.hit('api-anon', req.clientIp);
    if (!r.allowed) {
      req.auditDenied = { reason: 'cupo general agotado' };
      return tooMany(res, r);
    }
    const pathOnly = req.originalUrl.split('?')[0];
    // MODO PÚBLICO: lista cerrada de rutas GET de solo lectura. Si hay una cookie de sesión inválida se trata igual que sin sesión.
    if (!req.auth && deps.publicMode && isPublicReadRoute(req.method, pathOnly)) req.publicVisitor = true;
    if (!req.auth && !req.publicVisitor && !isPublicRoute(req.method === 'HEAD' ? 'GET' : req.method, pathOnly)) {
      req.auditDenied = { reason: token ? 'sesión inválida, caducada o revocada' : 'sin sesión' };
      if (token) res.append('Set-Cookie', `${sidName(secure)}=; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=0`);
      res.status(401).json({ error: 'Autenticación requerida.', code: 'unauthenticated' });
      return;
    }
    if (req.auth && UNSAFE.has(req.method)) {
      const sent = req.headers['x-csrf-token'];
      const v = Array.isArray(sent) ? sent[0] : sent;
      if (typeof v !== 'string' || !equal(v, req.auth.csrf)) {
        req.auditDenied = { reason: 'token CSRF ausente o inválido' };
        res.status(403).json({ error: 'Token CSRF ausente o inválido.', code: 'csrf' });
        return;
      }
    }
    next();
  });

  // Cuerpo JSON pequeño por defecto; las rutas grandes lo leen más tarde, tras comprobar su permiso.
  app.use('/api', (req, res, next) => {
    const pathOnly = req.originalUrl.split('?')[0];
    if (BIG_BODY_ROUTES.some((b) => b.re.test(pathOnly))) return next();
    return jsonBody(pathOnly.startsWith('/api/auth/') ? '16kb' : '100kb')(req, res, next);
  });

  // ───────────── CSRF previo a la sesión (login y configuración inicial) ─────────────

  const preTokenFor = (value: string) => crypto.createHmac('sha256', secret).update(`aqua-pre-v1:${value}`).digest('base64url');

  function ensurePre(req: Request, res: Response): { value: string; token: string } {
    const secure = useSecureCookie(req, cfg);
    const existing = parseCookies(req.headers.cookie)[preName(secure)];
    if (existing && /^[A-Za-z0-9_-]{22}$/.test(existing)) return { value: existing, token: preTokenFor(existing) };
    const value = crypto.randomBytes(16).toString('base64url');
    setCookie(res, preName(secure), value, { secure, maxAgeSec: 3600 });
    return { value, token: preTokenFor(value) };
  }

  const requirePreCsrf: RequestHandler = (req, res, next) => {
    const secure = useSecureCookie(req, cfg);
    const cookie = parseCookies(req.headers.cookie)[preName(secure)];
    const sent = req.headers['x-csrf-token'];
    const v = Array.isArray(sent) ? sent[0] : sent;
    // Un navegador con sesión viva que cambia de cuenta puede presentar su token CSRF de sesión en lugar del previo.
    if (req.auth && typeof v === 'string' && equal(v, req.auth.csrf)) return next();
    if (!cookie || !/^[A-Za-z0-9_-]{22}$/.test(cookie) || typeof v !== 'string' || !equal(v, preTokenFor(cookie))) {
      req.auditDenied = { reason: 'token CSRF previo a la sesión ausente o inválido' };
      res.status(403).json({ error: 'Token CSRF ausente o inválido. Recarga la página.', code: 'csrf' });
      return;
    }
    next();
  };

  async function startSession(req: Request, res: Response, user: UserRecord) {
    const secure = useSecureCookie(req, cfg);
    // Fijación de sesión: nunca se reutiliza ni se acepta un identificador previo; el anterior se revoca.
    const old = parseCookies(req.headers.cookie)[sidName(secure)];
    if (old) await deps.store.revokeSession(sha256Hex(old), 'replaced_by_login').catch(() => undefined);
    const { token, session } = await store.createSession(user.id, { ip: req.clientIp, userAgent: req.headers['user-agent'] });
    setCookie(res, sidName(secure), token, { secure, maxAgeSec: deps.sessionMaxAgeSec });
    req.auditActor = { kind: 'user', id: user.id, username: user.username, role: user.role };
    return { csrfToken: csrfForSession(session.idHash) };
  }

  // ───────────── Rutas públicas ─────────────

  app.get('/api/auth/status', (req, res) => {
    const pre = req.auth ? null : ensurePre(req, res);
    res.json({
      authenticated: Boolean(req.auth),
      user: req.auth ? userView(req.auth.user) : null,
      csrfToken: req.auth ? req.auth.csrf : pre!.token,
      publicMode: Boolean(deps.publicMode),
      setupAvailable: deps.setupEnabled && store.setupAvailable(),
      needsAdmin: !store.hasUsers(),
    });
  });
  app.get('/api/auth/csrf', (req, res) => {
    const pre = req.auth ? null : ensurePre(req, res);
    res.json({ csrfToken: req.auth ? req.auth.csrf : pre!.token });
  });

  app.post('/api/auth/login', requirePreCsrf, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.slice(0, 80) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = sha256Hex(username.trim().toLowerCase()).slice(0, 32);
    const found = store.findByUsername(username);
    req.auditExtra = { action: 'auth.login', resource: found ? found.id : `desconocido:${key.slice(0, 12)}` };
    const ipHit = limiter.hit('login-ip', req.clientIp);
    if (!ipHit.allowed) {
      req.auditDenied = { reason: 'demasiados intentos de inicio de sesión desde esta IP' };
      return tooMany(res, ipHit, 'intentos de inicio de sesión');
    }
    const lock = limiter.peek('login-user', key);
    if (!lock.allowed) {
      req.auditDenied = { reason: 'cuenta bloqueada temporalmente por intentos fallidos' };
      return tooMany(res, lock, 'intentos fallidos para esta cuenta');
    }
    const user = await store.verifyCredentials(username, password);
    if (!user) {
      if (!found || !found.active) await burnPasswordTime(password, store.scrypt); // igualar tiempos: no revelar si la cuenta existe
      limiter.fail('login-user', key);
      req.auditDenied = { reason: 'credenciales inválidas' };
      res.status(401).json({ error: 'Credenciales inválidas.', code: 'bad_credentials' });
      return;
    }
    limiter.reset('login-user', key);
    const { csrfToken } = await startSession(req, res, user);
    res.json({ user: userView(user), csrfToken });
  });

  app.post('/api/auth/setup', requirePreCsrf, async (req, res) => {
    if (!deps.setupEnabled || store.setupDisabledPermanently()) {
      res.status(404).json({ error: 'No encontrado.' });
      return;
    }
    req.auditExtra = { action: 'auth.setup' };
    const hit = limiter.hit('setup', req.clientIp);
    if (!hit.allowed) {
      req.auditDenied = { reason: 'demasiados intentos de configuración inicial' };
      return tooMany(res, hit, 'intentos de configuración');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const admin = await store.consumeSetup(body.code, { username: body.username, displayName: body.displayName, password: typeof body.password === 'string' ? body.password : '' });
    const full = store.getUser(admin.id)!;
    req.auditExtra = { action: 'auth.setup', resource: admin.id };
    const { csrfToken } = await startSession(req, res, full);
    res.status(201).json({ user: userView(admin), csrfToken });
  });

  // ───────────── Rutas autenticadas ─────────────

  app.post('/api/auth/logout', needs(AUTHENTICATED_ONLY), async (req, res) => {
    const secure = useSecureCookie(req, cfg);
    const hash = req.auth!.session.idHash;
    deps.opTokens.revokeSession(hash);
    req.auditExtra = { action: 'auth.logout', resource: req.auth!.user.id };
    res.append('Set-Cookie', `${sidName(secure)}=; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=0`);
    await store.revokeSession(hash, 'logout').catch((err) => {
      // La sesión ya quedó revocada en memoria; si el disco falla se informa pero no se deja al usuario "dentro".
      console.error('[auth] No se pudo persistir el cierre de sesión:', err instanceof Error ? err.message : '');
    });
    res.json({ ok: true });
  });

  app.post('/api/auth/password', needs(AUTHENTICATED_ONLY), async (req, res) => {
    const user = req.auth!.user;
    req.auditExtra = { action: 'auth.password.change', resource: user.id };
    const lock = limiter.peek('reauth', user.id);
    if (!lock.allowed) {
      req.auditDenied = { reason: 'demasiados intentos de reautenticación' };
      return tooMany(res, lock, 'intentos de contraseña');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!(await verifyPassword(body.currentPassword, user.password))) {
      limiter.fail('reauth', user.id);
      req.auditDenied = { reason: 'contraseña actual incorrecta' };
      res.status(403).json({ error: 'La contraseña actual no es correcta.', code: 'bad_password' });
      return;
    }
    limiter.reset('reauth', user.id);
    await store.setPassword(user.id, typeof body.newPassword === 'string' ? body.newPassword : '', { reason: 'password_changed' });
    deps.opTokens.revokeSession(req.auth!.session.idHash);
    const fresh = store.getUser(user.id)!;
    const { csrfToken } = await startSession(req, res, fresh);
    res.json({ ok: true, csrfToken, note: 'Se cerraron todas tus demás sesiones.' });
  });

  // ───────────── Administración de usuarios ─────────────

  const adminChain = (perm: Permission): RequestHandler[] => [needs(perm), limitUser(deps, 'admin')];

  app.get('/api/users', ...adminChain('users:manage'), (_req, res) => {
    res.json({ users: store.listUsers().map(userView), roles: ROLES });
  });

  app.post('/api/users', ...adminChain('users:manage'), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!ROLES.includes(body.role as Role)) throw new HttpError(400, 'Rol inválido: ADMIN, OPERATOR o VIEWER.');
    const created = await store.createUser({ username: body.username, displayName: body.displayName, role: body.role as Role, password: typeof body.password === 'string' ? body.password : '', createdBy: req.auth!.user.id });
    req.auditExtra = { action: 'user.create', resource: created.id, meta: { role: created.role } };
    res.status(201).json({ user: userView(created) });
  });

  app.patch('/api/users/:id', ...adminChain('users:manage'), async (req, res) => {
    const id = String(req.params.id);
    const target = store.getUser(id);
    if (!target) throw new HttpError(404, 'Usuario no encontrado.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (id === req.auth!.user.id) throw new HttpError(409, 'No puedes cambiar tu propio rol ni tu estado: pídeselo a otro administrador.');
    const meta: Record<string, unknown> = {};
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role as Role)) throw new HttpError(400, 'Rol inválido.');
      await store.setRole(id, body.role as Role);
      meta.role = body.role as string;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new HttpError(400, '"active" debe ser booleano.');
      await store.setActive(id, body.active);
      meta.active = body.active;
    }
    req.auditExtra = { action: 'user.update', resource: id, meta };
    res.json({ user: userView(store.getUser(id)!) });
  });

  app.post('/api/users/:id/password', ...adminChain('users:manage'), async (req, res) => {
    const id = String(req.params.id);
    if (id === req.auth!.user.id) throw new HttpError(409, 'Para cambiar tu propia contraseña usa /api/auth/password.');
    if (!store.getUser(id)) throw new HttpError(404, 'Usuario no encontrado.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    await store.setPassword(id, typeof body.newPassword === 'string' ? body.newPassword : '', { reason: 'password_reset_by_admin' });
    req.auditExtra = { action: 'user.password.reset', resource: id };
    res.json({ ok: true, note: 'Se cerraron todas las sesiones de ese usuario.' });
  });

  // ───────────── Auditoría ─────────────

  app.get('/api/audit', ...adminChain('audit:read'), async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    const page = await audit.read(limit, offset);
    res.json({ ...page, status: audit.status(), verification: audit.verify() });
  });
  app.get('/api/audit/head', ...adminChain('audit:read'), (_req, res) => {
    res.json({ head: audit.head(), status: audit.status() });
  });

  // ───────────── Operaciones destructivas: token de un solo uso con reautenticación ─────────────

  app.post('/api/admin/operation-token', needs('destructive:token'), limitUser(deps, 'admin'), async (req, res) => {
    const user = req.auth!.user;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const op = body.operation as DestructiveOperation;
    if (!DESTRUCTIVE_OPERATIONS.includes(op)) throw new HttpError(400, 'operation debe ser reset, demo o import.');
    req.auditExtra = { action: 'destructive.token.request', resource: op };
    if (!can(user.role, `destructive:${op}` as Permission)) {
      req.auditDenied = { reason: `permiso destructive:${op} no concedido` };
      res.status(403).json({ error: 'Tu rol no puede realizar esta operación.' });
      return;
    }
    const lock = limiter.peek('reauth', user.id);
    if (!lock.allowed) {
      req.auditDenied = { reason: 'demasiados intentos de reautenticación' };
      return tooMany(res, lock, 'intentos de contraseña');
    }
    if (!(await verifyPassword(body.password, user.password))) {
      limiter.fail('reauth', user.id);
      req.auditDenied = { reason: 'contraseña incorrecta al pedir token de operación' };
      res.status(403).json({ error: 'La contraseña no es correcta.', code: 'bad_password' });
      return;
    }
    limiter.reset('reauth', user.id);
    const issued = deps.opTokens.issue(user.id, req.auth!.session.idHash, op);
    res.json({ ...issued, operation: op, ttlSeconds: 60, note: 'Válido para una sola ejecución de esta operación.' });
  });
}

/**
 * Guardia de una operación destructiva. Orden: permiso ADMIN (needs) → cupo → confirmación explícita → token de un
 * solo uso → autorización escrita en la auditoría (si no se puede registrar, la operación NO se ejecuta).
 */
export function destructiveGuard(deps: SecurityDeps, operation: DestructiveOperation): RequestHandler[] {
  const guard: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const user = req.auth!.user;
    req.auditExtra = { action: `destructive.${operation}`, resource: operation };
    if (req.get('x-aqua-confirm') !== operation) {
      req.auditDenied = { reason: 'confirmación explícita ausente' };
      res.status(400).json({ error: `Operación destructiva sin confirmar: envía la cabecera X-Aqua-Confirm: ${operation}.`, code: 'confirmation_required' });
      return;
    }
    const token = req.get('x-operation-token');
    if (!deps.opTokens.consume(token, user.id, req.auth!.session.idHash, operation)) {
      req.auditDenied = { reason: 'token de operación ausente, caducado, ya usado o de otra operación' };
      res.status(401).json({ error: 'Token de operación ausente, caducado o ya utilizado. Solicita uno nuevo reautenticándote.', code: 'operation_token_required' });
      return;
    }
    try {
      const entry = await deps.audit.record({
        actor: { kind: 'user', id: user.id, username: user.username, role: user.role },
        ip: req.clientIp,
        action: `destructive.${operation}.authorized`,
        resource: operation,
        outcome: 'success',
        requestId: req.requestId,
        meta: { operation },
      });
      res.locals.authorizationSeq = entry.seq;
      res.locals.auditHeadHash = entry.hash;
      req.auditExtra = { action: `destructive.${operation}`, resource: operation, meta: { authorizationSeq: entry.seq } };
    } catch {
      res.status(503).json({ error: 'Operación NO ejecutada: no se pudo registrar su autorización en la auditoría.', code: 'audit_unavailable' });
      return;
    }
    next();
  };
  return [needs(`destructive:${operation}` as Permission), limitUser(deps, 'admin'), guard];
}

export { normalizeUsername };
