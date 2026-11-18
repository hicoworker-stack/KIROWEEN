import { ChainVerificationResult, TrustLedgerEntry } from './types';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalLedgerPayload(
  entry: Omit<TrustLedgerEntry, 'hash'>
): string {
  return JSON.stringify({
    id: entry.id,
    index: entry.index,
    timestamp: entry.timestamp,
    action: entry.action,
    actor: entry.actor,
    assetId: entry.assetId,
    evidenceSummary: entry.evidenceSummary,
    previousState: entry.previousState,
    newState: entry.newState,
    evidenceHash: entry.evidenceHash,
    previousHash: entry.previousHash,
  });
}

export async function appendLedgerEntry(
  chain: TrustLedgerEntry[],
  payload: {
    action: string;
    actor: string;
    assetId: string;
    evidenceSummary: string;
    previousState: string;
    newState: string;
    evidenceData?: unknown;
    timestamp?: string;
  }
): Promise<TrustLedgerEntry[]> {
  const index = chain.length;
  const previousHash = index === 0 ? GENESIS_HASH : chain[index - 1].hash;
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const evidenceHash = await sha256Hex(
    JSON.stringify(payload.evidenceData ?? payload.evidenceSummary)
  );

  const unsignedEntry: Omit<TrustLedgerEntry, 'hash'> = {
    id: `LED-${String(index + 1).padStart(4, '0')}`,
    index,
    timestamp,
    action: payload.action,
    actor: payload.actor,
    assetId: payload.assetId,
    evidenceSummary: payload.evidenceSummary,
    previousState: payload.previousState,
    newState: payload.newState,
    evidenceHash,
    previousHash,
  };

  const hash = await sha256Hex(canonicalLedgerPayload(unsignedEntry));
  const fullEntry: TrustLedgerEntry = {
    ...unsignedEntry,
    hash,
    ...(payload.evidenceData !== undefined ? { evidenceData: payload.evidenceData } : {}),
  };

  return [...chain, fullEntry];
}

export async function verifyLedgerChain(
  chain: TrustLedgerEntry[]
): Promise<ChainVerificationResult> {
  const verifiedAt = new Date().toISOString();

  if (chain.length === 0) {
    return {
      valid: true,
      checkedCount: 0,
      brokenIndex: null,
      verifiedAt,
    };
  }

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const expectedPreviousHash = i === 0 ? GENESIS_HASH : chain[i - 1].hash;

    if (entry.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        checkedCount: i + 1,
        brokenIndex: i,
        reason: `Ruptura de enlace en bloque #${i}: previousHash no coincide con el hash del bloque anterior.`,
        verifiedAt,
      };
    }

    const { hash, evidenceData, ...unsigned } = entry;
    const recomputed = await sha256Hex(canonicalLedgerPayload(unsigned));
    if (evidenceData !== undefined) {
      const dataHash = await sha256Hex(JSON.stringify(evidenceData));
      if (dataHash !== entry.evidenceHash) {
        return {
          valid: false,
          checkedCount: i + 1,
          brokenIndex: i,
          reason: `Evidencia adjunta alterada en bloque #${i} (${entry.id}): su SHA-256 no coincide con evidenceHash.`,
          verifiedAt,
        };
      }
    }
    if (recomputed !== hash) {
      return {
        valid: false,
        checkedCount: i + 1,
        brokenIndex: i,
        reason: `Integridad comprometida en bloque #${i} (${entry.id}): el hash SHA-256 almacenado no coincide con el contenido del registro.`,
        verifiedAt,
      };
    }
  }

  return {
    valid: true,
    checkedCount: chain.length,
    brokenIndex: null,
    verifiedAt,
  };
}


