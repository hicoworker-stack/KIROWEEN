/**
 * REQ-AUTH-04 (cliente): acceso a la API con sesión por cookie HttpOnly.
 *  - El token de sesión NUNCA es visible para el JavaScript de la página ni se guarda en localStorage/sessionStorage.
 *  - El token CSRF (derivado de la sesión) vive solo en memoria y se envía en cada escritura.
 *  - Una respuesta 401 de la API cierra la sesión local y vuelve a mostrar el inicio de sesión.
 */

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}
export interface AuthStatus {
  authenticated: boolean;
  user: SessionUser | null;
  csrfToken: string;
  setupAvailable: boolean;
  needsAdmin: boolean;
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!SAFE.has(method) && csrfToken && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken);
  const res = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401 && !input.startsWith('/api/auth/')) onUnauthorized?.();
  return res;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('No se pudo consultar el estado de autenticación.');
  const data = (await res.json()) as AuthStatus;
  csrfToken = data.csrfToken;
  return data;
}

async function postAuth(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  return { ok: res.ok, status: res.status, data };
}

export const loginRequest = (username: string, password: string) => postAuth('/api/auth/login', { username, password });
export const setupRequest = (input: { code: string; username: string; displayName: string; password: string }) => postAuth('/api/auth/setup', input);

export async function logoutRequest(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
  csrfToken = '';
}
