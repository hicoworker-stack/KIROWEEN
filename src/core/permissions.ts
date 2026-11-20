/**
 * Matriz de permisos por rol: ÚNICA fuente de verdad.
 *  - El servidor la aplica en cada ruta (src/server/authz.ts).
 *  - La interfaz solo la consulta para mostrar u ocultar acciones: ocultar un botón NUNCA sustituye la autorización del servidor.
 *
 *  - VIEWER:   consulta (estado, ledger, evidencias, verificación de expedientes).
 *  - OPERATOR: además ingesta, escenarios, IA, decisiones, órdenes, evidencias, exportar expedientes y sincronizar.
 *  - ADMIN:    además usuarios, auditoría, snapshot, sonda de IA y operaciones destructivas.
 */

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export const PERMISSIONS = [
  'state:read',
  'evidence:read',
  'dossier:verify',
  'kiro:read',
  'telemetry:ingest',
  'scenario:trigger',
  'ai:use',
  'diagnosis:decide',
  'order:write',
  'order:evidence',
  'dossier:export',
  'ledger:anchor',
  'offline:sync',
  'ai:probe',
  'snapshot:export',
  'destructive:reset',
  'destructive:demo',
  'destructive:import',
  'destructive:token',
  'users:manage',
  'audit:read',
  'health:detail',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = ['state:read', 'evidence:read', 'dossier:verify', 'kiro:read'];
const OPERATOR: readonly Permission[] = [
  ...VIEWER,
  'telemetry:ingest',
  'scenario:trigger',
  'ai:use',
  'diagnosis:decide',
  'order:write',
  'order:evidence',
  'dossier:export',
  'ledger:anchor',
  'offline:sync',
  'health:detail',
];
const ADMIN: readonly Permission[] = [...OPERATOR, 'ai:probe', 'snapshot:export', 'destructive:reset', 'destructive:demo', 'destructive:import', 'destructive:token', 'users:manage', 'audit:read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  VIEWER: new Set(VIEWER),
  OPERATOR: new Set(OPERATOR),
  ADMIN: new Set(ADMIN),
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return Boolean(role && ROLE_PERMISSIONS[role]?.has(permission));
}

export const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Administrador', OPERATOR: 'Operador', VIEWER: 'Lector' };
