import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * REQ-ARCH-04: reglas de arquitectura ejecutables.
 *  1. src/core es lógica pura: no importa src/sim, src/server, componentes, React, Express ni módulos de Node.
 *  2. src/sim (generador de datos sintéticos) solo puede depender de los TIPOS y los DATOS DE RED de core,
 *     nunca de los detectores: así el diagnóstico no puede "saber" qué escenario produjo las lecturas (resultado circular de la auditoría).
 *  3. Los componentes de cliente no importan src/server ni src/sim.
 */

const SRC = path.resolve(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const found: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(text)) !== null) found.push(m[1]);
  return found;
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');
const resolveLocal = (from: string, spec: string) => (spec.startsWith('.') ? rel(path.resolve(path.dirname(from), spec) + '.ts') : null);

test('src/core no importa sim, server, componentes, React, Express ni módulos de Node (REQ-ARCH-04)', () => {
  const offenders: string[] = [];
  for (const f of walk(path.join(SRC, 'core'))) {
    for (const spec of importsOf(f)) {
      const local = spec.startsWith('.') ? path.relative(SRC, path.resolve(path.dirname(f), spec)).replace(/\\/g, '/') : null;
      const bad =
        (local && /^(sim|server|components)(\/|$)/.test(local)) ||
        /^(react|react-dom|express|vite|motion|lucide-react|@google\/genai|epanet-js)(\/|$)/.test(spec) ||
        /^node:/.test(spec) ||
        ['fs', 'path', 'crypto', 'http', 'child_process'].includes(spec);
      if (bad) offenders.push(`${rel(f)} importa "${spec}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/sim solo importa tipos y datos de red de core, jamás los detectores (REQ-ARCH-04, REQ-HYD-04)', () => {
  const allowedCore = new Set(['core/types', 'core/networkData']);
  const offenders: string[] = [];
  const files = walk(path.join(SRC, 'sim'));
  assert.ok(files.length >= 2, 'debe existir el generador y el solver');
  for (const f of files) {
    if (rel(f) === 'sim/evaluation.ts') continue; // el arnés de evaluación SÍ ejecuta los detectores: es quien los mide
    for (const spec of importsOf(f)) {
      if (!spec.startsWith('.')) continue;
      const local = path.relative(SRC, path.resolve(path.dirname(f), spec)).replace(/\\/g, '/');
      if (local.startsWith('core/') && !allowedCore.has(local)) offenders.push(`${rel(f)} importa "${spec}"`);
      if (/^(server|components)(\/|$)/.test(local)) offenders.push(`${rel(f)} importa "${spec}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('los componentes de cliente no importan server ni sim (REQ-ARCH-04)', () => {
  const offenders: string[] = [];
  for (const f of [...walk(path.join(SRC, 'components')), path.join(SRC, 'App.tsx'), path.join(SRC, 'main.tsx')].filter((x) => fs.existsSync(x))) {
    for (const spec of importsOf(f)) {
      if (!spec.startsWith('.')) continue;
      const local = path.relative(SRC, path.resolve(path.dirname(f), spec)).replace(/\\/g, '/');
      if (/^(server|sim)(\/|$)/.test(local)) offenders.push(`${rel(f)} importa "${spec}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('el módulo antiguo de forense circular ya no existe (REQ-HYD-04)', () => {
  assert.equal(fs.existsSync(path.join(SRC, 'core', 'leakForensics.ts')), false);
  void resolveLocal;
});
