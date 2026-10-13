import { BoxImportError, type BoxParseResult } from "@haneoka/game-data-exporter";
import type { FolderSource } from "./directory";
export function readLocalSource(
  source: FolderSource & { archive?: Blob },
  kind: "folder" | "backup" | "archive",
  password: string,
  options: { signal: AbortSignal; progress: (completed: number, total: number) => void },
): Promise<BoxParseResult> {
  options.signal.throwIfAborted();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: BoxParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new BoxImportError("backup_timeout")), 180000);
    options.signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      if (event.data.progress) options.progress(event.data.progress.completed, event.data.progress.total);
      else if (event.data.error) finish(new BoxImportError(event.data.error));
      else finish(undefined, event.data.result);
    };
    worker.onerror = () => finish(new BoxImportError("backup_invalid"));
    try {
      worker.postMessage({ source, kind, password, archive: source.archive });
    } catch (error) {
      finish(error);
    }
  });
}
