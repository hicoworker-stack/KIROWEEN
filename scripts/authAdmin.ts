import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { AuditLog } from '../src/server/auditLog';
import { AuthStore, AuthStoreError, normalizeUsername, ROLES, Role } from '../src/server/authStore';
import { DEFAULT_STATE_PATH } from '../src/server/persistence';
import { loadOrCreateSealKeys } from '../src/server/sealing';

/**
 * CLI de administración de usuarios. Es la forma RECOMENDADA de crear el primer administrador en producción y de
 * recuperar el acceso. Actúa directamente sobre auth.json (junto al estado, o AQUA_STATE_PATH), con el mismo cerrojo y
 * la misma validación que el servidor, de modo que se puede usar con el servidor en marcha: sus cambios se aplican
 * al instante (una contraseña restablecida o un usuario desactivado cierran sus sesiones vivas).
 *
 *   npm run auth -- create-admin <usuario> [--name "Nombre"] [--password-stdin]
 *   npm run auth -- create-user  <usuario> --role ADMIN|OPERATOR|VIEWER [--name "Nombre"] [--password-stdin]
 *   npm run auth -- reset-password <usuario> [--password-stdin]
 *   npm run auth -- set-role <usuario> <ROL>
 *   npm run auth -- disable <usuario>     |  enable <usuario>
 *   npm run auth -- revoke-sessions <usuario>
 *   npm run auth -- list
 *
 * La contraseña NUNCA se pasa por argumentos (quedaría en el historial y en la lista de procesos): se pide por
 * terminal sin eco o, para automatización, se lee de la entrada estándar con --password-stdin.
 * Códigos de salida: 0 correcto · 1 error · 2 uso incorrecto.
 */

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--') && ['--name', '--role', '--auth-file'].includes(arr[i - 1])));

function usage(): never {
  console.error('Uso: npm run auth -- <create-admin|create-user|reset-password|set-role|disable|enable|revoke-sessions|list> ...\nVer el encabezado de scripts/authAdmin.ts.');
  process.exit(2);
}

async function readSecret(prompt: string): Promise<string> {
  if (has('--password-stdin') || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(prompt);
    w._writeToOutput = () => undefined; // sin eco
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readNewPassword(): Promise<string> {
  const first = await readSecret('Contraseña nueva: ');
  if (!has('--password-stdin') && process.stdin.isTTY) {
    const second = await readSecret('Repite la contraseña: ');
    if (first !== second) {
      console.error('Las contraseñas no coinciden.');
      process.exit(1);
    }
  }
  return first;
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage();
  const statePath = process.env.AQUA_STATE_PATH ? path.resolve(process.env.AQUA_STATE_PATH) : DEFAULT_STATE_PATH;
  const dir = path.dirname(statePath);
  const authFile = flag('--auth-file') ?? path.join(dir, 'auth.json');
  const store = AuthStore.open(authFile);
  const keys = loadOrCreateSealKeys({ dir, envPem: process.env.AQUA_SEAL_PRIVATE_KEY_PEM });
  const audit = AuditLog.open(path.join(dir, 'audit.jsonl'), { keys });
  const osUser = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'desconocido';
    }
  })();
  const record = (action: string, resource: string | null, outcome: 'success' | 'failure', reason?: string) =>
    audit.recordBestEffort({ actor: { kind: 'cli', id: null, username: osUser, role: null }, ip: null, action: `cli.${action}`, resource, outcome, reason });

  const username = positional[0];
  const target = () => {
    const u = store.findByUsername(username);
    if (!u) {
      console.error(`No existe el usuario "${username}".`);
      process.exit(1);
    }
    return u;
  };

  try {
    switch (cmd) {
      case 'create-admin':
      case 'create-user': {
        if (!username || !normalizeUsername(username)) {
          console.error('Indica un nombre de usuario válido (3-40 caracteres: a-z, 0-9, punto, guion, guion bajo).');
          process.exit(2);
        }
        const role = (cmd === 'create-admin' ? 'ADMIN' : (flag('--role') ?? '').toUpperCase()) as Role;
        if (!ROLES.includes(role)) {
          console.error('Indica --role ADMIN|OPERATOR|VIEWER.');
          process.exit(2);
        }
        const password = await readNewPassword();
        const created = await store.createUser({ username, displayName: flag('--name'), role, password, createdBy: `cli:${osUser}` });
        await record('create-user', created.id, 'success');
        console.log(`Usuario "${created.username}" creado con rol ${created.role}.`);
        break;
      }
      case 'reset-password': {
        const u = target();
        const password = await readNewPassword();
        await store.setPassword(u.id, password, { reason: 'password_reset_by_cli' });
        await record('reset-password', u.id, 'success');
        console.log(`Contraseña de "${u.username}" restablecida; sus sesiones abiertas se cerraron.`);
        break;
      }
      case 'set-role': {
        const u = target();
        const role = (positional[1] ?? '').toUpperCase() as Role;
        if (!ROLES.includes(role)) usage();
        await store.setRole(u.id, role);
        await record('set-role', u.id, 'success', role);
        console.log(`"${u.username}" ahora es ${role}; sus sesiones abiertas se cerraron.`);
        break;
      }
      case 'disable':
      case 'enable': {
        const u = target();
        await store.setActive(u.id, cmd === 'enable');
        await record(cmd, u.id, 'success');
        console.log(`"${u.username}" ${cmd === 'enable' ? 'activado' : 'desactivado (sus sesiones se cerraron)'}.`);
        break;
      }
      case 'revoke-sessions': {
        const u = target();
        const n = await store.revokeUserSessions(u.id, 'revoked_by_cli');
        await record('revoke-sessions', u.id, 'success');
        console.log(`${n} sesión(es) de "${u.username}" revocada(s).`);
        break;
      }
      case 'list': {
        for (const u of store.listUsers()) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(9)} ${u.active ? 'activo' : 'DESACTIVADO'}  ${u.displayName}`);
        if (store.listUsers().length === 0) console.log('(sin usuarios)');
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof AuthStoreError) {
      await record(cmd, username ?? null, 'failure', err.code);
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
