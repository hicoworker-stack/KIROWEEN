#!/usr/bin/env node
/**
 * Guardas para el agente de Kiro (hooks PreToolUse en .kiro/hooks/aqua-guard-git-history.json y aqua-guard-verified-core.json). Herramienta de DESARROLLO: no forma
 * parte del producto y no se ejecuta en producción.
 *
 *   node scripts/kiro-guard.mjs git    bloquea (exit 2) comandos que reescriben el historial de Git
 *   node scripts/kiro-guard.mjs core   pide confirmación humana antes de editar el núcleo verificado
 *
 * Kiro entrega el evento del hook como JSON por STDIN. El script no depende de su forma exacta: recorre todas las cadenas
 * del evento. Cada invocación se anota en <tmp>/aqua-kiro-guard.log (fecha, modo, herramienta, decisión) para poder
 * comprobar que el hook se ejecutó de verdad.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];

/** Historial: lo que la regla del proyecto prohíbe al agente (no reescribir ni descartar commits). */
const HISTORY_REWRITE =
  /\bgit\s+(?:push\b[^\n;|&]*?(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)|reset\s+--hard\b|rebase\b|commit\b[^\n;|&]*\s--amend\b|filter-(?:branch|repo)\b|update-ref\s+-d\b)/i;

/** Núcleo de los tres diferenciales: diagnóstico hidráulico, veredicto de reparación, ledger y expediente. */
const PROTECTED_CORE = /src[\\/]+core[\\/]+(hydraulicDiagnosis|repairVerification|cryptoLedger|dossier)\.ts\b/;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

function log(entry) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'aqua-kiro-guard.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // El registro es solo diagnóstico: nunca debe impedir trabajar.
  }
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  raw = '';
}
let event = null;
try {
  event = raw ? JSON.parse(raw) : null;
} catch {
  event = null;
}
const texts = event ? strings(event) : [raw];
const tool = (event && (event.tool_name ?? event.toolName ?? event.tool?.name)) || 'unknown';

if (mode === 'git') {
  const hit = texts.find((s) => HISTORY_REWRITE.test(s));
  if (hit) {
    log({ mode, tool, decision: 'block', match: hit.match(HISTORY_REWRITE)?.[0] });
    process.stderr.write(
      `Bloqueado por .kiro/hooks/aqua-guard-git-history.json: "${hit.match(HISTORY_REWRITE)?.[0]}" reescribe o descarta historial de Git. ` +
        'La regla del proyecto es no alterar el historial. Si de verdad hace falta, hazlo tú desde tu terminal.\n'
    );
    process.exit(2);
  }
  log({ mode, tool, decision: 'allow' });
  process.exit(0);
}

/** Solo los campos que nombran el archivo editado: mencionar una ruta dentro de un texto no es editarla. */
function pathFields(value, out = []) {
  if (Array.isArray(value)) for (const v of value) pathFields(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /path|file|target|uri|destination|source/i.test(k)) out.push(v);
      else if (v && typeof v === 'object') pathFields(v, out);
    }
  return out;
}

if (mode === 'core') {
  const hit = (event ? pathFields(event) : []).map((s) => s.match(PROTECTED_CORE)?.[0]).find(Boolean);
  if (hit) {
    log({ mode, tool, decision: 'ask', file: hit });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'ask',
          permissionDecisionReason:
            `${hit} es parte del núcleo verificado (diagnóstico, veredicto de reparación, ledger o expediente). ` +
            'Confírmalo solo si el cambio es intencionado; después ejecuta npm run verify:kiro y npm run demo:loop.',
        },
      })
    );
    process.exit(0);
  }
  log({ mode, tool, decision: 'allow' });
  process.exit(0);
}

process.stderr.write('uso: node scripts/kiro-guard.mjs git|core\n');
process.exit(0);
