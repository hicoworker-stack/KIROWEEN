import fs from 'node:fs';
import { DecisionDossier } from '../src/core/dossier';
import { verifyDossierFull } from '../src/server/dossierVerify';

/**
 * Verificación OFFLINE de un expediente de decisión, sin servidor.
 *
 *   npm run verify:dossier -- <expediente.json> [--pubkey <clave-publica.pem>] [--keyid <huella-sha256>]
 *
 * Qué prueba y qué no:
 *  - INTEGRIDAD: el contenido no cambió desde el sellado (digests + cadena SHA-256 + foto).
 *  - AUTENTICIDAD DEL EMISOR: solo si fijas la clave pública (--pubkey o --keyid) obtenida por un canal INDEPENDIENTE
 *    del expediente (p. ej. la huella anotada durante la demo, o GET /api/seal/public-key). Sin clave fijada, una firma válida
 *    solo demuestra que alguien con SU propia clave firmó, lo que cualquiera puede hacer.
 *  - INMUTABILIDAD: no se garantiza.
 *
 * Códigos de salida: 0 verified · 3 solo integridad (sin autenticidad) · 1 alterado o inválido · 2 uso incorrecto.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--') || !fs.existsSync(file)) {
    console.error('Uso: npm run verify:dossier -- <expediente.json> [--pubkey clave.pem] [--keyid huella]');
    process.exit(2);
  }
  let dossier: DecisionDossier;
  try {
    dossier = JSON.parse(fs.readFileSync(file, 'utf8')) as DecisionDossier;
  } catch {
    console.error('El archivo no es JSON válido.');
    process.exit(2);
  }
  const pubkeyPath = arg('--pubkey');
  if (pubkeyPath && !fs.existsSync(pubkeyPath)) {
    console.error(`No existe el archivo de clave pública: ${pubkeyPath}`);
    process.exit(2);
  }
  const result = await verifyDossierFull(dossier, {
    trustedPublicKeyPem: pubkeyPath ? fs.readFileSync(pubkeyPath, 'utf8') : undefined,
    trustedKeyId: arg('--keyid'),
  });

  const id = dossier.sealed?.order?.id ?? '(desconocida)';
  console.log(`Expediente ${id} · datos ${dossier.syntheticData ? 'SINTÉTICOS (demostración)' : 'declarados como no sintéticos (sin verificar)'}`);
  console.log('\nINTEGRIDAD');
  for (const c of result.integrity.checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.label} — ${c.detail}`);
  console.log(`\nAUTENTICIDAD DEL EMISOR: ${result.authenticity.status.toUpperCase()}`);
  console.log(`  ${result.authenticity.detail}`);
  for (const c of result.authenticity.checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.label} — ${c.detail}`);
  console.log(`\nINMUTABILIDAD: no garantizada. ${result.immutability.note}`);

  if (result.overall === 'verified') {
    console.log('\nRESULTADO: VERIFICADO (íntegro y emitido por la clave fijada).');
    process.exit(0);
  }
  if (result.overall === 'integrity-only') {
    console.log('\nRESULTADO: SOLO INTEGRIDAD. El contenido es coherente, pero NO se puede afirmar quién lo emitió ni descartar un truncamiento.');
    process.exit(3);
  }
  console.log('\nRESULTADO: INVÁLIDO. Se detectó una alteración o una firma/vínculo incorrecto.');
  process.exit(1);
}

void main();
