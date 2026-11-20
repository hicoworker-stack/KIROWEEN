import { PersistedServerState, trySavePersistedState } from './persistence';

/**
 * REQ-RES-04: exclusión mutua FIFO. Cada operación que lee-modifica-escribe el estado se ejecuta completa
 * antes de que empiece la siguiente. Sin esto, dos peticiones concurrentes leían el mismo snapshot de una orden y
 * la segunda sobrescribía el cambio de la primera (el ledger registraba 4 casillas y la orden mostraba 2).
 *
 * No es reentrante: no se debe llamar a runExclusive desde dentro de otra sección exclusiva.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get queued(): number {
    return this.pending;
  }

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const run = this.tail.then(
      () => fn(),
      () => fn()
    );
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run.finally(() => {
      this.pending--;
    });
  }
}

export interface PersistenceStatus {
  /** 'disk': el último guardado tuvo éxito. 'memory-only': el estado solo existe en memoria. */
  mode: 'disk' | 'memory-only';
  lastWriteAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

/**
 * REQ-RES-05: un fallo al escribir el estado no debe tumbar el servidor. Se degrada a 'memory-only', se informa
 * y se reintenta en la siguiente escritura (se recupera sola si el disco vuelve).
 */
export class PersistenceTracker {
  private status: PersistenceStatus = {
    mode: 'disk',
    lastWriteAt: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly filePath: string,
    private readonly save: typeof trySavePersistedState = trySavePersistedState
  ) {}

  get path(): string {
    return this.filePath;
  }

  snapshot(): PersistenceStatus {
    return { ...this.status };
  }

  write(state: Parameters<typeof trySavePersistedState>[0]): PersistenceStatus {
    const result = this.save(state, this.filePath);
    const now = new Date().toISOString();
    if (result.ok) {
      this.status = { mode: 'disk', lastWriteAt: now, lastError: null, lastErrorAt: this.status.lastErrorAt, consecutiveFailures: 0 };
    } else {
      if (this.status.consecutiveFailures === 0) {
        console.error(`[persistencia] No se pudo guardar el estado; se continúa solo en memoria: ${result.error}`);
      }
      this.status = {
        mode: 'memory-only',
        lastWriteAt: this.status.lastWriteAt,
        lastError: result.error,
        lastErrorAt: now,
        consecutiveFailures: this.status.consecutiveFailures + 1,
      };
    }
    return this.snapshot();
  }
}

export type { PersistedServerState };
