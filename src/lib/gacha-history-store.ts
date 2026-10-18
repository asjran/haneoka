import { mergeHistory, parseHistory, type HistorySnapshot } from "./gacha-history-data";

export interface StoredHistory {
  key: string;
  snapshot: HistorySnapshot;
}
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });

/** A browser-local history library shared by import and analysis entry points. */
class HistoryStore extends EventTarget {
  private database?: Promise<IDBDatabase>;
  private db(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const pending = indexedDB.open("haneoka-gacha-history", 1);
      pending.onupgradeneeded = () => pending.result.createObjectStore("histories", { keyPath: "key" });
      pending.onerror = () => {
        this.database = undefined;
        reject(pending.error);
      };
      pending.onblocked = () => {
        this.database = undefined;
        reject(new Error("history_storage_busy"));
      };
      pending.onsuccess = () => {
        const database = pending.result;
        database.onversionchange = () => {
          database.close();
          this.database = undefined;
        };
        resolve(database);
      };
    }));
  }
  async list(): Promise<StoredHistory[]> {
    const db = await this.db(),
      tx = db.transaction("histories");
    const values: unknown[] = await request(tx.objectStore("histories").getAll());
    return values
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const record = value as StoredHistory;
        if (typeof record.key !== "string" || !/^[a-f0-9]{64}$/u.test(record.key)) return [];
        try {
          return [{ key: record.key, snapshot: parseHistory(record.snapshot) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Date.parse(b.snapshot.queriedAt) - Date.parse(a.snapshot.queriedAt));
  }
  async import(value: unknown, companionKey?: string): Promise<StoredHistory> {
    const snapshot = parseHistory(value),
      bytes = new TextEncoder().encode(
        companionKey && /^[a-f0-9]{64}-(?:jp|global-hmt|global-en|global-kr)$/u.test(companionKey)
          ? `${snapshot.source.server}:${companionKey}`
          : JSON.stringify(snapshot),
      );
    const key = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const record = { key, snapshot },
      db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("histories", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      const store = tx.objectStore("histories"),
        previous = store.get(key);
      previous.onsuccess = () => {
        try {
          if (companionKey && previous.result)
            record.snapshot = mergeHistory(snapshot, parseHistory(previous.result.snapshot));
          store.put(record);
        } catch {
          tx.abort();
        }
      };
    });
    this.dispatchEvent(new Event("change"));
    return record;
  }
}
export const historyStore = new HistoryStore();
