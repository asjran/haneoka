import type { SearchCheckpoint } from "../../lib/team-builder/contracts";

export interface SearchCheckpointBackend {
  read(key: string): Promise<unknown>;
  write(key: string, value: SearchCheckpoint): Promise<void>;
}

const DATABASE = "haneoka-team-search";
const STORE = "complete-results";
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("checkpoint-storage-unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = () => {
      failed = true;
      reject(request.error ?? new Error("checkpoint-storage-failed"));
    };
    request.onblocked = () => {
      failed = true;
      reject(new Error("checkpoint-storage-blocked"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        if (connection === opening) connection = undefined;
      };
      resolve(db);
    };
  });
  connection = opening;
  void opening.catch(() => {
    if (connection === opening) connection = undefined;
  });
  return opening;
}

async function transaction(key: string, value?: SearchCheckpoint): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, value ? "readwrite" : "readonly");
    const store = tx.objectStore(STORE);
    let result: unknown;
    const request = value ? store.put(value, key) : store.get(key);
    request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("checkpoint-storage-failed"));
  });
}

const browserBackend: SearchCheckpointBackend = {
  read: (key) => transaction(key),
  write: async (key, value) => { await transaction(key, value); },
};

/** The Worker verifies the semantic fingerprint and digest before using a cache. */
function complete(value: unknown): value is SearchCheckpoint {
  const checkpoint = value as SearchCheckpoint | null | undefined;
  return Boolean(
    checkpoint?.schema === "haneoka-search-checkpoint-v1" &&
    typeof checkpoint.engineRevision === "string" &&
    typeof checkpoint.fingerprint === "string" &&
    typeof checkpoint.resultDigest === "string" &&
    checkpoint.result?.completeness === "exhaustive" &&
    checkpoint.result.proof?.status === "proven",
  );
}

const milestone = (value: SearchCheckpoint) =>
  JSON.stringify([value.engineRevision, value.fingerprint, value.resultDigest]);

/** One committed result per account/server. Pending writes keep only the newest complete result. */
export class SearchCheckpointStore {
  lastComplete: SearchCheckpoint | null = null;
  status: "idle" | "saving" | "saved" | "error" = "idle";
  loaded = false;
  readonly ready: Promise<void>;
  private pending: SearchCheckpoint | null = null;
  private draining: Promise<void> | null = null;
  private persistedMilestone: string | null = null;
  private version = 0;
  private disposed = false;

  constructor(
    readonly key: string,
    private backend: SearchCheckpointBackend = browserBackend,
    private onChange: () => void = () => {},
  ) {
    this.ready = this.restore();
  }

  private emit() {
    if (!this.disposed) this.onChange();
  }

  private async restore() {
    const version = this.version;
    try {
      const value = await this.backend.read(this.key);
      if (!this.disposed && this.version === version && complete(value)) {
        this.lastComplete = value;
        this.persistedMilestone = milestone(value);
        this.status = "saved";
      }
    } catch {
      if (!this.disposed && this.version === version) this.status = "error";
    } finally {
      this.loaded = true;
      this.emit();
    }
  }

  save(value: SearchCheckpoint): Promise<void> {
    if (this.disposed || !complete(value)) return this.flush();
    ++this.version;
    if (this.lastComplete && milestone(this.lastComplete) === milestone(value) && this.status !== "error") {
      this.lastComplete = value;
      this.emit();
      return this.flush();
    }
    this.lastComplete = value;
    this.pending = value;
    this.status = "saving";
    this.emit();
    if (!this.draining) this.draining = Promise.resolve().then(() => this.drain());
    return this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        try {
          const id = milestone(next);
          if (id !== this.persistedMilestone) await this.backend.write(this.key, next);
          this.persistedMilestone = id;
          if (!this.pending && this.lastComplete && milestone(this.lastComplete) === milestone(next))
            this.status = "saved";
        } catch {
          if (!this.pending) this.status = "error";
        }
        this.emit();
      }
    } finally {
      this.draining = null;
    }
  }

  flush(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  dispose() {
    this.disposed = true;
    // Complete queued transactions for their original key; stop publishing into a new UI scope.
    void this.flush();
  }
}
