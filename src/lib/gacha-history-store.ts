// L3 — GEB
// Input: 规范化本地抽卡快照与当前 Haneoka owner。
// Output: 本地记录及按 owner 隔离的云缓存、同步许可。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 读写 IndexedDB；云下载保持独立，上传许可按 grant 条件写入。
import { mergeHistoryCollection, parseHistory, type HistorySnapshot } from "./gacha-history-data";
import { HISTORY_CLOUD_SCHEMA, parseStoredCloudHistory, type HistoryCloudDocument } from "./gacha-history-cloud-data";

export interface HistoryCloudLink {
  ownerId: string;
  accountKey: string;
  grantId: string;
  uploaded: Record<string, string>;
}

export interface StoredHistory {
  key: string;
  snapshot: HistorySnapshot;
  histories?: HistorySnapshot[];
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
      const pending = indexedDB.open("haneoka-gacha-history", 2);
      pending.onupgradeneeded = () => {
        if (!pending.result.objectStoreNames.contains("histories"))
          pending.result.createObjectStore("histories", { keyPath: "key" });
        for (const name of ["cloudAccounts", "cloudLinks"])
          if (!pending.result.objectStoreNames.contains(name))
            pending.result.createObjectStore(name, { keyPath: ["ownerId", "accountKey"] });
      };
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
          let histories = [parseHistory(record.snapshot)];
          for (const history of record.histories ?? [])
            histories = mergeHistoryCollection(histories, parseHistory(history));
          return [{ key: record.key, snapshot: histories[0], histories }];
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
    const key =
      snapshot.source.accountKey ??
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    const record: StoredHistory = { key, snapshot, histories: [snapshot] },
      db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("histories", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      const store = tx.objectStore("histories"),
        previous = store.get(key);
      previous.onsuccess = () => {
        try {
          if ((companionKey || snapshot.source.accountKey) && previous.result) {
            const previousRecord = previous.result as StoredHistory;
            let histories = [parseHistory(previousRecord.snapshot)];
            for (const history of previousRecord.histories ?? [])
              histories = mergeHistoryCollection(histories, parseHistory(history));
            record.histories = mergeHistoryCollection(histories, snapshot);
            record.snapshot = record.histories[0];
          }
          store.put(record);
        } catch {
          tx.abort();
        }
      };
    });
    this.dispatchEvent(new Event("change"));
    return record;
  }

  async cloudState(ownerId: string): Promise<{ documents: HistoryCloudDocument[]; links: HistoryCloudLink[] }> {
    const db = await this.db(),
      tx = db.transaction(["cloudAccounts", "cloudLinks"]);
    const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
    const [cached, linked] = await Promise.all([
      request<HistoryCloudDocument[]>(tx.objectStore("cloudAccounts").getAll(range)),
      request<HistoryCloudLink[]>(tx.objectStore("cloudLinks").getAll(range)),
    ]);
    const documents = cached.flatMap((value) => {
      if (value.ownerId !== ownerId) return [];
      try {
        const parsed = parseStoredCloudHistory(
          { schema: HISTORY_CLOUD_SCHEMA, histories: value.histories },
          value.accountKey,
          value.server,
        );
        return [{ ...value, histories: parsed.histories }];
      } catch {
        return [];
      }
    });
    const links = linked.filter(
      (value) =>
        value.ownerId === ownerId && /^[a-f0-9]{64}$/u.test(value.accountKey) && typeof value.grantId === "string",
    );
    return { documents, links };
  }

  private async cloudWrite(storeName: "cloudAccounts" | "cloudLinks", value: HistoryCloudDocument | HistoryCloudLink) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      tx.objectStore(storeName).put(value);
    });
  }
  saveCloud(document: HistoryCloudDocument): Promise<void> {
    return this.cloudWrite("cloudAccounts", document);
  }
  async saveCloudLink(link: HistoryCloudLink, valid: () => boolean, updateOnly = false): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cloudLinks", "readwrite"),
        store = tx.objectStore("cloudLinks");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      if (updateOnly) {
        const previous = store.get([link.ownerId, link.accountKey]);
        previous.onsuccess = () => {
          if (valid() && previous.result?.grantId === link.grantId) store.put(link);
        };
      } else if (valid()) store.put(link);
    });
  }
  async unlinkCloud(ownerId: string, accountKey: string, grantId: string): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cloudLinks", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      const store = tx.objectStore("cloudLinks"),
        previous = store.get([ownerId, accountKey]);
      previous.onsuccess = () => {
        if (previous.result?.grantId === grantId) store.delete([ownerId, accountKey]);
      };
    });
  }
}
export const historyStore = new HistoryStore();
