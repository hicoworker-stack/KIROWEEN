import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * npm run verify:kiro
 *
 * Verifica la trazabilidad REQ-* de .kiro/specs contra el código y las pruebas REALES, y después ejecuta los checks del hook.
 * Un requisito solo cuenta como verificado si:
 *   1. se define una sola vez (`- **REQ-X-NN**:`),
 *   2. tiene una fila en la tabla de trazabilidad,
 *   3. todos los archivos que cita existen,
 *   4. cita al menos un archivo de PRUEBA, y
 *   5. alguno de esos archivos de prueba menciona el identificador del requisito (en el título o el cuerpo de una prueba).
 * `npm run lint` o «verificado por compilación» ya no cuentan como prueba. Tampoco vale una tabla que cite un archivo que no
 * menciona el requisito: así un requisito no puede quedar «cubierto» solo en el papel.
 */
interface HookCheck {
  id: string;
  command: string;
  required: boolean;
}
interface VerifyIntegrityHook {
  name: string;
  version: string;
  traceability?: { specsDir?: string; requirePrefix?: string; validateReferencedFiles?: boolean };
  checks: HookCheck[];
}
const ROOT = process.cwd();
const HOOK_PATH = path.resolve(ROOT, '.kiro/verify-integrity.json');
const FILE_RE = /^(?:src|scripts)\/[A-Za-z0-9_./-]+\.[a-z]+$|^server\.ts$/;
const TEST_RE = /\.test\.tsx?$/;

function fail(message: string): never {
  console.error(`\n[verify:kiro] ERROR: ${message}`);
  process.exit(1);
}
function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) results.push(...collectTestFiles(full));
    else if (TEST_RE.test(entry)) results.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return results.sort();
}

export interface TraceReport {
  requirements: string[];
  problems: string[];
}

/** Núcleo puro de la comprobación: recibe los textos de las especificaciones y el contenido de las pruebas. */
export function traceRequirements(
  specs: Record<string, string>,
  tests: Record<string, string>,
  exists: (rel: string) => boolean,
  prefix = 'REQ-'
): TraceReport {
  const problems: string[] = [];
  const idRe = new RegExp(`${prefix}[A-Z]+-\\d+`, 'g');
  const defined = new Map<string, string[]>();
  const rows = new Map<string, Array<{ spec: string; files: string[] }>>();
  for (const [spec, content] of Object.entries(specs)) {
    if ((content.match(idRe) ?? []).length === 0) problems.push(`${spec}: no declara requisitos con prefijo ${prefix}.`);
    if (!content.includes('| Requisito |')) problems.push(`${spec}: no contiene la tabla "| Requisito |".`);
    for (const line of content.split(/\r?\n/)) {
      for (const m of line.matchAll(new RegExp(`\\*\\*(${prefix}[A-Z]+-\\d+)\\*\\*`, 'g'))) defined.set(m[1], [...(defined.get(m[1]) ?? []), spec]);
      if (!/^\|\s*`REQ-/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim());
      const ids = cells[1].match(idRe) ?? [];
      const files = [...(cells[2] + ' ' + (cells[3] ?? '')).matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => FILE_RE.test(c));
      for (const id of ids) rows.set(id, [...(rows.get(id) ?? []), { spec, files }]);
    }
  }
  for (const [id, where] of defined) if (where.length > 1) problems.push(`${id} se define más de una vez (${where.join(', ')}): renumera uno.`);
  for (const id of defined.keys()) if (!rows.has(id)) problems.push(`${id} no tiene fila en la tabla de trazabilidad.`);
  for (const id of rows.keys()) if (!defined.has(id)) problems.push(`${id} aparece en una tabla pero no se define con **${id}**.`);
  for (const [id, list] of rows) {
    const idMention = new RegExp(`${id}(?!\\d)`);
    const files = [...new Set(list.flatMap((r) => r.files))];
    for (const f of files) if (!exists(f)) problems.push(`${id}: el archivo citado no existe: ${f}`);
    const testFiles = files.filter((f) => TEST_RE.test(f) && exists(f));
    if (testFiles.length === 0) {
      problems.push(`${id}: no cita ningún archivo de prueba (npm run lint no cuenta como prueba).`);
      continue;
    }
    if (!testFiles.some((f) => idMention.test(tests[f] ?? ''))) problems.push(`${id}: ninguna de las pruebas citadas (${testFiles.join(', ')}) menciona el requisito.`);
  }
  return { requirements: [...defined.keys()].sort(), problems };
}

function validateSpecsAndTraceability(hook: VerifyIntegrityHook): string[] {
  const specsRel = hook.traceability?.specsDir ?? '.kiro/specs';
  const prefix = hook.traceability?.requirePrefix ?? 'REQ-';
  const specsDir = path.resolve(ROOT, specsRel);
  if (!fs.existsSync(specsDir)) fail(`No existe el directorio de especificaciones: ${specsRel}`);
  const specFiles = fs.readdirSync(specsDir).filter((f) => f.endsWith('.md')).sort();
  if (specFiles.length === 0) fail(`No se encontraron archivos .md en ${specsRel}`);

  const diskTests = collectTestFiles(path.resolve(ROOT, 'src'));
  if (diskTests.length === 0) fail('No hay archivos de prueba en src/.');
  const unitCheckCmd = hook.checks.map((c) => c.command).join(' ');
  const coversAll = unitCheckCmd.includes('src/**/*.test.ts') && unitCheckCmd.includes('src/**/*.test.tsx');
  for (const t of diskTests) if (!coversAll && !unitCheckCmd.includes(t)) fail(`El archivo de prueba ${t} no está incluido en .kiro/verify-integrity.json`);

  const specs = Object.fromEntries(specFiles.map((f) => [`${specsRel}/${f}`, fs.readFileSync(path.join(specsDir, f), 'utf8')]));
  const tests = Object.fromEntries(diskTests.map((f) => [f, fs.readFileSync(path.resolve(ROOT, f), 'utf8')]));
  const report = traceRequirements(specs, tests, (rel) => fs.existsSync(path.resolve(ROOT, rel)), prefix);
  if (report.problems.length > 0) fail(`Trazabilidad incompleta (${report.problems.length}):\n  - ${report.problems.join('\n  - ')}`);
  console.log(`[verify:kiro] Trazabilidad OK: ${report.requirements.length} requisitos, cada uno con una prueba que lo menciona, en ${specFiles.length} especificaciones; ${diskTests.length} archivos de prueba.`);
  return report.requirements;
}

function main() {
  if (!fs.existsSync(HOOK_PATH)) fail('No se encontró .kiro/verify-integrity.json');
  const hook = JSON.parse(fs.readFileSync(HOOK_PATH, 'utf8')) as VerifyIntegrityHook;
  if (!Array.isArray(hook.checks) || hook.checks.length === 0) fail('verify-integrity.json no define checks.');
  console.log(`[verify:kiro] Ejecutando pipeline "${hook.name}" v${hook.version}...`);
  validateSpecsAndTraceability(hook);
  for (const check of hook.checks) {
    console.log(`\n[verify:kiro] -> [${check.id}] ${check.command}`);
    try {
      execSync(check.command, { cwd: ROOT, stdio: 'inherit' });
    } catch (err) {
      if (check.required) fail(`Check obligatorio "${check.id}" falló: ${err instanceof Error ? err.message : String(err)}`);
      console.warn(`[verify:kiro] Check opcional "${check.id}" falló.`);
    }
  }
  console.log('\n[verify:kiro] Todas las verificaciones Kiro completadas con éxito.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPathSafe(import.meta.url))) main();

function fileURLToPathSafe(u: string): string {
  return decodeURIComponent(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}
