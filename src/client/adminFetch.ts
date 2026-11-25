import { apiFetch } from './api';
import { tr } from '../ui/engineText';
import { t } from '../ui/i18n';

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
  const labels: Record<DestructiveOp, string> = {
    reset: t('reiniciar la red', 'reset the network'),
    demo: t('ejecutar la demostración (reinicia el estado)', 'run the demonstration (it resets the state)'),
    import: t('importar un snapshot (reemplaza el estado)', 'import a snapshot (it replaces the state)'),
  };
  const password = prompter ? await prompter(t(`Para ${labels[op]} confirma tu contraseña. Se conservará una copia del estado actual.`, `To ${labels[op]}, confirm your password. A copy of the current state will be kept.`)) : null;
  if (!password) return jsonResponse(499, t('Operación cancelada: no se confirmó la contraseña.', 'Operation cancelled: the password was not confirmed.'));
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
    return typeof data.error === 'string' ? tr(data.error) : fallback;
  } catch {
    return fallback;
  }
}
