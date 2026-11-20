import crypto from 'node:crypto';

/**
 * REQ-AUTH-01: contraseñas con scrypt nativo de Node (sin dependencias). Los parámetros se guardan con cada hash,
 * de modo que se pueden endurecer sin invalidar las contraseñas existentes.
 * Parámetros por defecto: N=2^15, r=8, p=3 (combinación equivalente a las recomendaciones de OWASP para scrypt).
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

export interface PasswordRecord extends ScryptParams {
  algo: 'scrypt';
  salt: string; // base64
  hash: string; // base64
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 3, keyLen: 64 };
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // acota el coste de CPU/memoria de una petición

const COMMON = new Set(
  [
    'password1234',
    '123456789012',
    'qwertyuiop12',
    'contrasena123',
    'administrador',
    'aquasentinel1',
    'aquasentinel',
    'letmein12345',
    'changeme1234',
  ].map((s) => s.toLowerCase())
);

export function validatePasswordPolicy(password: unknown, username?: string): string[] {
  const problems: string[] = [];
  if (typeof password !== 'string') return ['La contraseña debe ser texto.'];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  if (password.length > MAX_PASSWORD_LENGTH) problems.push(`La contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres.`);
  if (/^(.)\1+$/.test(password)) problems.push('La contraseña no puede repetir un solo carácter.');
  if (username && password.toLowerCase().includes(username.toLowerCase()) && username.length >= 3) problems.push('La contraseña no puede contener el nombre de usuario.');
  if (COMMON.has(password.toLowerCase())) problems.push('La contraseña es demasiado común.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 3) problems.push('Usa al menos 3 tipos de carácter (minúscula, mayúscula, número, símbolo) o 16 caracteres o más.');
  return problems;
}

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<PasswordRecord> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) throw new Error('Contraseña inválida.');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, params);
  return { algo: 'scrypt', ...params, salt: salt.toString('base64'), hash: key.toString('base64') };
}

export async function verifyPassword(password: unknown, record: PasswordRecord): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  if (record.algo !== 'scrypt') return false;
  try {
    const expected = Buffer.from(record.hash, 'base64');
    const key = await scrypt(password, Buffer.from(record.salt, 'base64'), { N: record.N, r: record.r, p: record.p, keyLen: expected.length });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Registro ficticio para igualar el tiempo de respuesta cuando el usuario no existe (evita enumeración por tiempo). */
let dummy: PasswordRecord | null = null;
export async function burnPasswordTime(password: unknown, params: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  if (!dummy || dummy.N !== params.N || dummy.p !== params.p) dummy = await hashPassword('no-existe-' + crypto.randomBytes(8).toString('hex'), params);
  await verifyPassword(password, dummy);
}
