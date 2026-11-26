import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hooks de Kiro del repositorio (.kiro/hooks/*.json) y el guard que ejecutan (scripts/kiro-guard.mjs).
 *
 * Kiro compila el "matcher" como expresión regular de JavaScript. Un matcher que no compila deja el hook desactivado sin
 * ningún error visible en el chat: solo un aviso en el registro de Kiro. Eso ocurrió con el modificador "(?i)", que JavaScript
 * no admite. Esta prueba lo impide, y fija las decisiones del guard (bloquear, preguntar o permitir).
 */
const ROOT = process.cwd();
const HOOKS_DIR = path.join(ROOT, '.kiro', 'hooks');

type Hook = { name: string; trigger: string; matcher?: string; action: { type: 'command' | 'agent'; command?: string; prompt?: string } };

const hookFiles = () => fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.json'));

test('los hooks de .kiro/hooks usan el formato v1 de Kiro, sus matchers compilan en JavaScript y su script existe', () => {
  const files = hookFiles();
  assert.ok(files.length > 0, 'hay hooks en .kiro/hooks');
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8')) as { version: string; hooks: Hook[] };
    assert.equal(doc.version, 'v1', `${f}: formato v1`);
    assert.ok(Array.isArray(doc.hooks) && doc.hooks.length > 0, `${f}: lista de hooks`);
    for (const h of doc.hooks) {
      assert.ok(h.name && h.trigger && h.action?.type, `${f}: name, trigger y action.type son obligatorios`);
      if (h.matcher !== undefined) assert.doesNotThrow(() => new RegExp(h.matcher!), `${f}: el matcher "${h.matcher}" compila como RegExp de JavaScript`);
      if (h.action.type === 'command') {
        const script = h.action.command?.match(/\bnode\s+(\S+\.m?js)\b/)?.[1];
        if (script) assert.ok(fs.existsSync(path.join(ROOT, script)), `${f}: el script ${script} existe relativo a la raíz del repositorio`);
      }
    }
  }
});

test('los matchers seleccionan las herramientas previstas: shell para el historial, escritura para el núcleo', () => {
  const byFile = (name: string) => (JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, name), 'utf8')).hooks[0] as Hook).matcher!;
  const git = new RegExp(byFile('aqua-guard-git-history.json'));
  const core = new RegExp(byFile('aqua-guard-verified-core.json'));
  for (const tool of ['execute_pwsh', 'executeBash']) assert.ok(git.test(tool), `historial: ${tool}`);
  for (const tool of ['fs_write', 'str_replace', 'read_file']) assert.ok(!git.test(tool), `historial no se aplica a ${tool}`);
  for (const tool of ['fs_write', 'fsWrite', 'str_replace', 'strReplace', 'smart_relocate', 'semantic_rename']) assert.ok(core.test(tool), `núcleo: ${tool}`);
  for (const tool of ['execute_pwsh', 'read_file']) assert.ok(!core.test(tool), `núcleo no se aplica a ${tool}`);
});

test('el guard bloquea reescrituras del historial, pide confirmación para el núcleo verificado y deja pasar el resto', () => {
  const cases: Array<[string, unknown, 'block' | 'ask' | 'allow']> = [
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git push --force upstream main' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git push -f origin main' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git push origin +main' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git push --force-with-lease upstream main' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git reset --hard HEAD~1' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git commit --amend -m x' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git rebase -i HEAD~3' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git filter-branch --tree-filter x' } }, 'block'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git push upstream main' } }, 'allow'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git commit -m "fix: force-feed the parser"' } }, 'allow'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'git reset HEAD file.txt' } }, 'allow'],
    ['git', { tool_name: 'execute_pwsh', tool_input: { command: 'npm run verify:kiro' } }, 'allow'],
    ['core', { tool_name: 'str_replace', tool_input: { path: 'C:\\x\\src\\core\\repairVerification.ts', oldStr: 'a', newStr: 'b' } }, 'ask'],
    ['core', { tool_name: 'fs_write', tool_input: { path: '/w/src/core/cryptoLedger.ts', text: 'x' } }, 'ask'],
    ['core', { tool_name: 'fs_write', tool_input: { path: '/w/src/core/hydraulicDiagnosis.ts', text: 'x' } }, 'ask'],
    ['core', { toolName: 'smart_relocate', input: { sourcePath: 'src/core/dossier.ts', destinationPath: 'src/x.ts' } }, 'ask'],
    ['core', { tool_name: 'fs_write', tool_input: { path: '/w/src/core/dossier.test.ts', text: 'x' } }, 'allow'],
    ['core', { tool_name: 'fs_write', tool_input: { path: '/w/src/core/workOrders.ts', text: 'x' } }, 'allow'],
    ['core', { tool_name: 'fs_write', tool_input: { path: '/w/docs/SUBMISSION.md', text: 'see src/core/dossier.ts' } }, 'allow'],
    ['core', 'not json at all', 'allow'],
  ];
  for (const [mode, ev, want] of cases) {
    const input = typeof ev === 'string' ? ev : JSON.stringify(ev);
    const r = spawnSync(process.execPath, ['scripts/kiro-guard.mjs', mode], { input, encoding: 'utf8' });
    const got = r.status === 2 ? 'block' : /"permissionDecision":"ask"/.test(r.stdout) ? 'ask' : 'allow';
    assert.equal(got, want, `${mode}: ${input.slice(0, 90)}`);
  }
});
