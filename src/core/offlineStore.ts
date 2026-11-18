import { OfflineReportRecord } from './types';

const DB_NAME = 'aqua-sentinel-db';
const DB_VERSION = 1;
const STORE_NAME = 'offline_reports';

const memoryFallback = new Map<string, OfflineReportRecord>();

function hasIndexedDB(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function buildOfflineIdempotencyKey(
  nodeId: string,
  category: string,
  description: string,
  isoTimestamp: string
): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, ' ');
  const minuteBucket = isoTimestamp.slice(0, 16);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `${nodeId}::${category}::${minuteBucket}::${hash.toString(16)}`;
}

export async function saveOfflineReport(record: OfflineReportRecord): Promise<void> {
  if (!hasIndexedDB()) {
    memoryFallback.set(record.id, record);
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listOfflineReports(): Promise<OfflineReportRecord[]> {
  if (!hasIndexedDB()) {
    return Array.from(memoryFallback.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const list = (req.result as OfflineReportRecord[]) ?? [];
      resolve(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateOfflineReport(record: OfflineReportRecord): Promise<void> {
  return saveOfflineReport(record);
}

