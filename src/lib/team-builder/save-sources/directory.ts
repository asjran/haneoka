import { BOX_LIMITS, BoxImportError } from "@haneoka/game-data-exporter";
export interface FolderSource {
  directory?: FileSystemDirectoryHandle;
  files?: readonly File[];
}
export interface LocalSource {
  read(path: string, limit: number): Promise<Uint8Array | null>;
  readPrefix(path: string): Promise<Uint8Array | null>;
  paths(): AsyncGenerator<string>;
}
export const SKIPPED = new Set([
  "Library",
  "tmp",
  "EncryptedBundles",
  "Addressables",
  "UnityCache",
  "il2cpp",
  "cache",
  "Cache",
]);
export function localSource(source: FolderSource): LocalSource {
  const files = new Map<string, File>();
  if (source.files) {
    if (source.files.length > 250000) throw new BoxImportError("backup_budget");
    for (const file of source.files) {
      const path = file.webkitRelativePath || file.name;
      files.set(path.slice(path.indexOf("/") + 1), file);
    }
  }
  const get = async (path: string): Promise<File | null> => {
    if (!source.directory) return files.get(path) ?? null;
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) throw new BoxImportError("backup_invalid");
    try {
      let directory = source.directory;
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
      return await (await directory.getFileHandle(parts.at(-1)!)).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  };
  async function* walk(directory: FileSystemDirectoryHandle, prefix = "", depth = 0): AsyncGenerator<string> {
    if (depth > 8) return;
    const iterable = directory as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
    for await (const entry of iterable.values()) {
      if (entry.kind === "directory" && !SKIPPED.has(entry.name))
        yield* walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, depth + 1);
      else if (entry.kind === "file") yield `${prefix}${entry.name}`;
    }
  }
  return {
    async readPrefix(path) {
      const file = await get(path);
      return file ? new Uint8Array(await file.slice(0, 64).arrayBuffer()) : null;
    },
    async read(path, limit) {
      const file = await get(path);
      if (!file) return null;
      if (file.size > limit) throw new BoxImportError("backup_budget");
      return new Uint8Array(await file.arrayBuffer());
    },
    async *paths() {
      if (source.directory) yield* walk(source.directory);
      else yield* files.keys();
    },
  };
}
export async function readSaveFolder(source: LocalSource): Promise<Blob[]> {
  const files: Blob[] = [];
  let scanned = 0,
    size = 0;
  for await (const path of source.paths()) {
    if (++scanned > 10000) throw new BoxImportError("backup_budget");
    if (
      path.split("/").some((p) => SKIPPED.has(p)) ||
      /\.(png|jpg|jpeg|webp|mp4|mp3|ogg|bundle|dll|so|plist|db)$/i.test(path)
    )
      continue;
    const header = await source.readPrefix(path);
    if (!header) continue;
    const prefix = new TextDecoder().decode(header).trimStart();
    const supported =
      header[0] === 0xb5 || header[0] === 0x1f || prefix.startsWith("{") || prefix.startsWith("ONPKG1:");
    header.fill(0);
    if (!supported) continue;
    let bytes: Uint8Array | null;
    try {
      bytes = await source.read(path, BOX_LIMITS.fileBytes);
    } catch (error) {
      if (error instanceof BoxImportError && error.code === "backup_budget") continue;
      throw error;
    }
    if (!bytes) continue;
    size += bytes.length;
    if (size > BOX_LIMITS.inputBytes || files.length >= BOX_LIMITS.entries) throw new BoxImportError("backup_budget");
    files.push(new Blob([Uint8Array.from(bytes)]));
    bytes.fill(0);
  }
  if (!files.length) throw new BoxImportError("box_no_player");
  return files;
}
