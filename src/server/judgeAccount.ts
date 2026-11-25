import type { AuthStore } from './authStore';
import { validatePasswordPolicy } from './passwords';

/**
 * REQ-ACC-03: cuenta de evaluación para jueces.
 *
 * La URL pública es de SOLO LECTURA (modo público). Para recorrer el ciclo completo (decidir, ordenar, cerrar, verificar)
 * un evaluador necesita escribir, así que el operador del despliegue puede definir una cuenta de rol OPERATOR con
 * AQUA_JUDGE_PASSWORD (y, opcionalmente, AQUA_JUDGE_USER). Las credenciales se entregan por el canal privado del concurso.
 *
 *  - La contraseña viene del entorno: nunca se escribe en el repositorio, en registros ni en respuestas.
 *  - Se exige la política de contraseñas normal (12+ caracteres, variedad).
 *  - El rol es OPERATOR: no puede gestionar usuarios, leer la auditoría, importar ni reiniciar el estado.
 *  - Es idempotente: si la cuenta ya existe no se toca (ni su contraseña ni su rol).
 */
export const DEFAULT_JUDGE_USER = 'judge';

export type JudgeAccountResult =
  | { status: 'disabled' }
  | { status: 'exists'; username: string }
  | { status: 'created'; username: string }
  | { status: 'rejected'; reason: string };

export async function ensureJudgeAccount(store: AuthStore, env: Record<string, string | undefined> = process.env): Promise<JudgeAccountResult> {
  const password = env.AQUA_JUDGE_PASSWORD;
  if (!password) return { status: 'disabled' };
  const username = (env.AQUA_JUDGE_USER?.trim() || DEFAULT_JUDGE_USER).toLowerCase();
  const problems = validatePasswordPolicy(password, username);
  if (problems.length > 0) return { status: 'rejected', reason: `AQUA_JUDGE_PASSWORD no cumple la política de contraseñas: ${problems.join(' ')}` };
  if (store.findByUsername(username)) return { status: 'exists', username };
  await store.createUser({ username, displayName: 'Evaluador', role: 'OPERATOR', password, createdBy: 'judge-account' });
  return { status: 'created', username };
}
