import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STATE_PATH } from './persistence';

/** REQ-WO-03: almacén local de evidencias direccionado por contenido (SHA-256). No es S3. */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const SHA_RE = /^[a-f0-9]{64}$/;

export function defaultEvidenceDir(statePath: string = DEFAULT_STATE_PATH): string {
  return path.join(path.dirname(statePath), 'evidence');
}

export function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function saveEvidence(
  base64: string,
  mimeType: string,
  dir: string = defaultEvidenceDir()
): { sha256: string; sizeBytes: number; filePath: string } {
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) throw new Error(`MIME no soportado: ${mimeType}`);
  const buf = Buffer.from(base64, 'base64');
  const sha256 = sha256OfBuffer(buf);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sha256}.${ext}`);
  if (!fs.existsSync(filePath)) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
  }
  return { sha256, sizeBytes: buf.length, filePath };
}

export function readEvidence(
  sha256: string,
  dir: string = defaultEvidenceDir()
): { buffer: Buffer; mimeType: string; verified: boolean } | null {
  if (!SHA_RE.test(sha256)) return null;
  for (const [mimeType, ext] of Object.entries(EXT_BY_MIME)) {
    const filePath = path.join(dir, `${sha256}.${ext}`);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      return { buffer, mimeType, verified: sha256OfBuffer(buffer) === sha256 };
    }
  }
  return null;
}

