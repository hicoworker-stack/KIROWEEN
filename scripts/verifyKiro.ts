import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

interface HookCheck {
  id: string;
  command: string;
  required: boolean;
}

interface VerifyIntegrityHook {
  name: string;
  version: string;
  traceability?: {
    specsDir?: string;
    requirePrefix?: string;
    validateReferencedFiles?: boolean;
  };
  checks: HookCheck[];
}

const ROOT = process.cwd();
const HOOK_PATH = path.resolve(ROOT, '.kiro/hooks/verify-integrity.json');

function fail(message: string): never {
  console.error(`\n[verify:kiro] ERROR: ${message}`);
  process.exit(1);
}

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTestFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      results.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

function validateSpecsAndTraceability(hook: VerifyIntegrityHook): string[] {
  const specsRel = hook.traceability?.specsDir ?? '.kiro/specs';
  const prefix = hook.traceability?.requirePrefix ?? 'REQ-';
  const specsDir = path.resolve(ROOT, specsRel);

  if (!fs.existsSync(specsDir)) {
    fail(`No existe el directorio de especificaciones: ${specsRel}`);
  }

  const specFiles = fs
    .readdirSync(specsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (specFiles.length === 0) {
    fail(`No se encontraron archivos .md en ${specsRel}`);
  }

  const reqRegex = new RegExp(`\\b${prefix}[A-Z]+-\\d+\\b`, 'g');
  const fileRefRegex = /`((?:src|scripts)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.ts)`/g;
  const allReqIds = new Set<string>();
  const referencedTestFiles = new Set<string>();

  for (const file of specFiles) {
    const full = path.join(specsDir, file);
    const content = fs.readFileSync(full, 'utf8');
    const matches = content.match(reqRegex) ?? [];
    if (matches.length === 0) {
      fail(`La especificación ${specsRel}/${file} no declara requisitos con prefijo ${prefix}`);
    }
    matches.forEach((m) => allReqIds.add(m));

    if (!content.includes('| Requisito |')) {
      fail(`La especificación ${specsRel}/${file} no contiene tabla "| Requisito |"`);
    }

    if (hook.traceability?.validateReferencedFiles !== false) {
      let refMatch: RegExpExecArray | null;
      while ((refMatch = fileRefRegex.exec(content)) !== null) {
        const relPath = refMatch[1];
        const absPath = path.resolve(ROOT, relPath);
        if (!fs.existsSync(absPath)) {
          fail(`Archivo referenciado en ${file} no existe: ${relPath}`);
        }
        if (relPath.endsWith('.test.ts')) {
          referencedTestFiles.add(relPath);
        }
      }
    }
  }

  const diskTests = collectTestFiles(path.resolve(ROOT, 'src'));
  const unitCheckCmd = hook.checks.map((c) => c.command).join(' ');
  const coversAll = unitCheckCmd.includes('src/**/*.test.ts');
  if (diskTests.length === 0) fail('No hay archivos de prueba en src/.');
  for (const testFile of diskTests) {
    if (!coversAll && !unitCheckCmd.includes(testFile)) {
      fail(`El archivo de prueba ${testFile} no está incluido en .kiro/hooks/verify-integrity.json`);
    }
  }

  console.log(
    `[verify:kiro] Trazabilidad OK: ${allReqIds.size} requisitos (${Array.from(allReqIds).join(', ')}) across ${specFiles.length} specs; ${diskTests.length} suites de prueba verificadas.`
  );
  return Array.from(allReqIds);
}

function main() {
  if (!fs.existsSync(HOOK_PATH)) {
    fail('No se encontró .kiro/hooks/verify-integrity.json');
  }

  const hook = JSON.parse(fs.readFileSync(HOOK_PATH, 'utf8')) as VerifyIntegrityHook;
  if (!Array.isArray(hook.checks) || hook.checks.length === 0) {
    fail('verify-integrity.json no define checks.');
  }

  console.log(`[verify:kiro] Ejecutando hook "${hook.name}" v${hook.version}...`);
  validateSpecsAndTraceability(hook);

  for (const check of hook.checks) {
    console.log(`\n[verify:kiro] -> [${check.id}] ${check.command}`);
    try {
      execSync(check.command, { cwd: ROOT, stdio: 'inherit' });
    } catch (err) {
      if (check.required) {
        fail(`Check obligatorio "${check.id}" falló: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        console.warn(`[verify:kiro] Check opcional "${check.id}" falló.`);
      }
    }
  }

  console.log('\n[verify:kiro] Todas las verificaciones Kiro completadas con éxito.');
}

main();
