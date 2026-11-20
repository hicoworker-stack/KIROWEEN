/**
 * REQ-SEC-01 (cliente): las operaciones destructivas exigen la cabecera X-Aqua-Confirm con el nombre de la operación
 * y, si el servidor tiene AQUA_ADMIN_TOKEN, el token. El token se pide una vez por sesión del navegador y no se guarda en disco.
 */
export type DestructiveOp = 'reset' | 'demo' | 'import';

const TOKEN_KEY = 'aquaAdminToken';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(value: string | null): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

export async function destructiveFetch(
  url: string,
  op: DestructiveOp,
  init: { body?: unknown; askToken?: () => string | null } = {}
): Promise<Response> {
  const send = (token: string | null) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aqua-Confirm': op,
        ...(token ? { 'X-Admin-Token': token } : {}),
      },
      body: JSON.stringify(init.body ?? {}),
    });
  const first = await send(getAdminToken());
  if (first.status !== 401) return first;
  const ask = init.askToken ?? (() => (typeof window !== 'undefined' ? window.prompt('Este servidor exige un token de administración para esta operación:') : null));
  const token = ask();
  if (!token) return first;
  setAdminToken(token);
  const second = await send(token);
  if (second.status === 401) setAdminToken(null);
  return second;
}

export async function readServerMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}
