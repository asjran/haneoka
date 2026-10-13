import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { BOX_LIMITS, BoxImportError } from "@haneoka/game-data-exporter";
import { parseBoxFiles } from "@haneoka/game-data-exporter";
import { parsePlist, plistObject, plistBytes, PlistUid } from "./plist";
import { unlockBackup, unwrap, decryptBackup } from "./backup-crypto";
import { type LocalSource, SKIPPED } from "./directory";
const DOMAINS = ["com.bilibili.sirius.official", "com.bilibili.sirius", "com.bushiroad.sirius"].map(
  (p) => `AppDomain-${p}`,
);
const fail = () => new BoxImportError("backup_invalid");
export async function readIosBackup(
  source: LocalSource,
  password: string,
  progress: (completed: number, total: number) => void,
) {
  const manifestBytes = await source.read("Manifest.plist", 16 * 1024 * 1024);
  if (!manifestBytes) throw new BoxImportError("backup_select_root");
  const manifest = plistObject(parsePlist(manifestBytes));
  manifestBytes.fill(0);
  if (manifest.IsEncrypted === true && !password) throw new BoxImportError("backup_password_required");
  const keys = manifest.IsEncrypted === true ? await unlockBackup(manifest, password) : null;
  let databaseBytes: Uint8Array | null = null;
  const unwrapClass = (cls: number, wrapped: Uint8Array) => {
    const key = keys?.get(cls);
    if (!key) throw fail();
    return unwrap(key, wrapped);
  };
  try {
    databaseBytes = await source.read("Manifest.db", 256 * 1024 * 1024);
    if (!databaseBytes) throw fail();
    if (keys) {
      const wrapped = plistBytes(manifest.ManifestKey);
      if (wrapped.length < 12) throw fail();
      const key = unwrapClass(new DataView(wrapped.buffer, wrapped.byteOffset).getUint32(0, true), wrapped.subarray(4));
      try {
        const plain = decryptBackup(key, databaseBytes);
        databaseBytes.fill(0);
        databaseBytes = plain;
      } finally {
        key.fill(0);
      }
    }
    if (new TextDecoder().decode(databaseBytes.subarray(0, 16)) !== "SQLite format 3\0") throw fail();
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const db = new SQL.Database(databaseBytes);
    const files: Blob[] = [];
    let size = 0;
    try {
      const statement = db.prepare(
        "SELECT fileID, relativePath, file FROM Files WHERE flags = 1 AND domain IN (?, ?, ?) AND relativePath LIKE 'Documents/%'",
      );
      try {
        statement.bind(DOMAINS);
        const rows: Array<{ id: string; metadata: Uint8Array | null }> = [];
        while (statement.step()) {
          const row = statement.getAsObject();
          if (
            typeof row.fileID !== "string" ||
            !/^[a-f0-9]{40}$/.test(row.fileID) ||
            typeof row.relativePath !== "string" ||
            row.relativePath.split("/").some((p) => SKIPPED.has(p))
          )
            continue;
          if (rows.length >= BOX_LIMITS.entries) throw new BoxImportError("backup_budget");
          rows.push({ id: row.fileID, metadata: row.file instanceof Uint8Array ? row.file : null });
        }
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!;
          let bytes: Uint8Array | null;
          try {
            bytes =
              (await source.read(`${row.id.slice(0, 2)}/${row.id}`, BOX_LIMITS.fileBytes + 16)) ??
              (await source.read(row.id, BOX_LIMITS.fileBytes + 16));
          } catch (error) {
            if (error instanceof BoxImportError && error.code === "backup_budget") continue;
            throw error;
          }
          if (!bytes) continue;
          try {
            if (keys) {
              if (!row.metadata) throw fail();
              const archive = plistObject(parsePlist(row.metadata));
              const objects = archive.$objects;
              const rootRef = plistObject(archive.$top).root;
              if (!Array.isArray(objects) || !(rootRef instanceof PlistUid)) throw fail();
              const root = plistObject(objects[rootRef.index]);
              const keyRef = root.EncryptionKey;
              if (
                !(keyRef instanceof PlistUid) ||
                typeof root.ProtectionClass !== "number" ||
                typeof root.Size !== "number"
              )
                throw fail();
              if (root.Size > BOX_LIMITS.fileBytes || root.Size < 0) throw new BoxImportError("backup_budget");
              const wrapped = plistBytes(plistObject(objects[keyRef.index])["NS.data"]);
              const key = unwrapClass(root.ProtectionClass, wrapped.subarray(4));
              try {
                const plain = decryptBackup(key, bytes);
                bytes.fill(0);
                bytes = plain.subarray(0, root.Size);
              } finally {
                key.fill(0);
              }
            }
            size += bytes.length;
            if (size > BOX_LIMITS.inputBytes) throw new BoxImportError("backup_budget");
            files.push(new Blob([Uint8Array.from(bytes)]));
          } finally {
            bytes.fill(0);
          }
          progress(index + 1, rows.length);
        }
      } finally {
        statement.free();
      }
    } finally {
      db.close();
    }
    if (!files.length) throw new BoxImportError("backup_no_game");
    return await parseBoxFiles(files);
  } finally {
    databaseBytes?.fill(0);
    for (const key of keys?.values() ?? []) key.fill(0);
  }
}
