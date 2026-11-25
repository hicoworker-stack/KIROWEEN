import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { traceRequirements } from '../scripts/verifyKiro';

/**
 * REQ-KIRO-01: `npm run verify:kiro` comprueba evidencias reales, no solo que existan archivos. Estas pruebas fijan que el
 * verificador RECHAZA los atajos con los que un requisito podía quedar «cubierto» solo en el papel, y que el repositorio real cumple.
 */
const TABLE = '| Requisito | Implementación | Prueba |\n| --- | --- | --- |\n';
const spec = (defs: string[], rows: string[]) => ({ 'a.md': `${defs.map((d) => `- **${d}**: x`).join('\n')}\n${TABLE}${rows.join('\n')}\n` });
const exists = (rel: string) => rel !== 'src/falta.ts';

test('REQ-KIRO-01: un requisito con prueba que lo menciona se acepta', () => {
  const r = traceRequirements(spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': "test('hace x (REQ-A-01)')" }, exists);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.requirements, ['REQ-A-01']);
});

test('REQ-KIRO-01: «npm run lint» como única prueba se rechaza', () => {
  const r = traceRequirements(spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `npm run lint` |']), {}, exists);
  assert.match(r.problems.join('\n'), /REQ-A-01: no cita ningún archivo de prueba/);
});

test('REQ-KIRO-01: citar un archivo de prueba que no menciona el requisito se rechaza (cobertura solo en el papel)', () => {
  const r = traceRequirements(spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': "test('otra cosa (REQ-A-02)')" }, exists);
  assert.match(r.problems.join('\n'), /REQ-A-01: ninguna de las pruebas citadas/);
});

test('REQ-KIRO-01: REQ-A-1 no se da por mencionado por REQ-A-10 (comparación exacta)', () => {
  const r = traceRequirements(spec(['REQ-A-1'], ['| `REQ-A-1` | `src/a.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': "test('x (REQ-A-10)')" }, exists);
  assert.match(r.problems.join('\n'), /REQ-A-1: ninguna de las pruebas citadas/);
});

test('REQ-KIRO-01: archivos inexistentes, identificadores duplicados, huérfanos y filas sin definición se rechazan', () => {
  const missing = traceRequirements(spec(['REQ-A-01'], ['| `REQ-A-01` | `src/falta.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': 'REQ-A-01' }, exists);
  assert.match(missing.problems.join('\n'), /el archivo citado no existe: src\/falta\.ts/);
  const dup = traceRequirements({ 'a.md': spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |'])['a.md'], 'b.md': spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |'])['a.md'] }, { 'src/a.test.ts': 'REQ-A-01' }, exists);
  assert.match(dup.problems.join('\n'), /REQ-A-01 se define más de una vez/);
  const orphan = traceRequirements(spec(['REQ-A-01', 'REQ-A-02'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': 'REQ-A-01' }, exists);
  assert.match(orphan.problems.join('\n'), /REQ-A-02 no tiene fila/);
  const ghost = traceRequirements(spec(['REQ-A-01'], ['| `REQ-A-01` | `src/a.ts` | `src/a.test.ts` |', '| `REQ-A-09` | `src/a.ts` | `src/a.test.ts` |']), { 'src/a.test.ts': 'REQ-A-01 REQ-A-09' }, exists);
  assert.match(ghost.problems.join('\n'), /REQ-A-09 aparece en una tabla pero no se define/);
});

test('REQ-KIRO-01: el repositorio real cumple la regla estricta: cada requisito tiene una prueba que lo menciona', () => {
  const root = process.cwd();
  const specsDir = path.join(root, '.kiro/specs');
  const specs = Object.fromEntries(fs.readdirSync(specsDir).filter((f) => f.endsWith('.md')).map((f) => [f, fs.readFileSync(path.join(specsDir, f), 'utf8')]));
  const tests: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(e.name)) tests[path.relative(root, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.join(root, 'src'));
  const report = traceRequirements(specs, tests, (rel) => fs.existsSync(path.join(root, rel)));
  assert.deepEqual(report.problems, []);
  assert.ok(report.requirements.length >= 80, `${report.requirements.length} requisitos`);
});
