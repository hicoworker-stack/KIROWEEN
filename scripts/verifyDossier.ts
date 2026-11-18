import fs from 'node:fs';
import { DecisionDossier, verifyDossier } from '../src/core/dossier';

/** Uso: npm run verify:dossier -- ruta/al/dossier-OT-2026-001.json  (verificación offline, sin servidor). */
async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Uso: npm run verify:dossier -- <archivo-dossier.json>');
    process.exit(2);
  }
  let dossier: DecisionDossier;
  try {
    dossier = JSON.parse(fs.readFileSync(file, 'utf8')) as DecisionDossier;
  } catch {
    console.error('El archivo no es JSON válido.');
    process.exit(2);
  }
  if (dossier.format !== 'aqua-sentinel-dossier/1') {
    console.error('Formato de expediente no reconocido.');
    process.exit(2);
  }
  const result = await verifyDossier(dossier);
  console.log(`Expediente ${dossier.order.id} · datos ${dossier.syntheticData ? 'SINTÉTICOS (demo)' : 'de campo'}`);
  for (const c of result.checks) {
    console.log(`${c.ok ? '✔' : '✖'} ${c.label} — ${c.detail}`);
  }
  console.log(result.valid ? '\nEXPEDIENTE ÍNTEGRO' : '\nEXPEDIENTE ALTERADO O INCOMPLETO');
  process.exit(result.valid ? 0 : 1);
}

void main();
