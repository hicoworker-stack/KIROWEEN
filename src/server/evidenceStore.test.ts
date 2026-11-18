import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvidence, saveEvidence, sha256OfBuffer } from './evidenceStore';

test('evidence is stored content-addressed and read back with verified hash (REQ-WO-03)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ev-'));
  const bytes = Buffer.from('fake-jpeg-bytes');
  const saved = saveEvidence(bytes.toString('base64'), 'image/jpeg', dir);
  assert.equal(saved.sha256, sha256OfBuffer(bytes));
  const read = readEvidence(saved.sha256, dir);
  assert.ok(read);
  assert.equal(read.verified, true);
  assert.equal(read.mimeType, 'image/jpeg');
  assert.deepEqual(read.buffer, bytes);
});

test('tampered evidence file is reported as unverified (REQ-WO-03)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ev-'));
  const saved = saveEvidence(Buffer.from('original').toString('base64'), 'image/png', dir);
  fs.writeFileSync(saved.filePath, 'tampered');
  assert.equal(readEvidence(saved.sha256, dir)?.verified, false);
});

test('readEvidence rejects path traversal and unknown hashes (REQ-WO-03)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ev-'));
  assert.equal(readEvidence('../../etc/passwd', dir), null);
  assert.equal(readEvidence('a'.repeat(64), dir), null);
  assert.throws(() => saveEvidence('AA==', 'image/svg+xml', dir));
});

