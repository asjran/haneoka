import { localSource, readSaveFolder, type FolderSource } from "./directory";
import { readSaveArchive } from "./archive";
import { parseBoxFiles } from "@haneoka/game-data-exporter";
import { BoxImportError } from "@haneoka/game-data-exporter";
self.onmessage = async (
  event: MessageEvent<{
    source: FolderSource;
    archive?: Blob;
    kind: "folder" | "backup" | "archive";
    password?: string;
  }>,
) => {
  try {
    const { source, kind, password, archive } = event.data;
    const progress = (completed: number, total: number) => self.postMessage({ progress: { completed, total } });
    const local = localSource(source);
    const result =
      kind === "archive" && archive
        ? await readSaveArchive(archive, progress)
        : kind === "backup"
          ? await (await import("./ios-backup")).readIosBackup(local, password ?? "", progress)
          : await parseBoxFiles(await readSaveFolder(local), { progress });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof BoxImportError ? error.code : "backup_invalid" });
  } finally {
    self.close();
  }
};
