import { apiFetch } from './api';

/**
 * REQ-SEC-05 (cliente): las operaciones destructivas piden la contraseña del administrador, obtienen un token de
 * UN solo uso (60 s) y lo envían con la confirmación explícita. Nada se guarda en el navegador.
 */
export type DestructiveOp = 'reset' | 'demo' | 'import';

type Prompter = (message: string) => Promise<string | null>;
let prompter: Prompter | null = null;
export const setPasswordPrompter = (fn: Prompter | null) => {
  prompter = fn;
};

const jsonResponse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

export async function destructiveFetch(url: string, op: DestructiveOp, init: { body?: unknown } = {}): Promise<Response> {
  const labels: Record<DestructiveOp, string> = { reset: 'reiniciar la red', demo: 'ejecutar la demostración (reinicia el estado)', import: 'importar un snapshot (reemplaza el estado)' };
  const password = prompter ? await prompter(`Para ${labels[op]} confirma tu contraseña. Se conservará una copia del estado actual.`) : null;
  if (!password) return jsonResponse(499, 'Operación cancelada: no se confirmó la contraseña.');
  const tokenRes = await apiFetch('/api/admin/operation-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: op, password }),
  });
  if (!tokenRes.ok) return tokenRes;
  const { token } = (await tokenRes.json()) as { token: string };
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aqua-Confirm': op, 'X-Operation-Token': token },
    body: JSON.stringify(init.body ?? {}),
  });
}

export async function readServerMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}
