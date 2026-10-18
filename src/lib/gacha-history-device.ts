import type { DeviceReader } from "@haneoka/game-data-exporter";
import { HISTORY_BYTES } from "./gacha-history-data";

/** Reads only the app's explicit credential-free export folder. */
export async function readCompanionHistory(port: DeviceReader, signal: AbortSignal): Promise<File[] | null> {
  const timeout = AbortSignal.timeout(60000),
    run = AbortSignal.any([signal, timeout]);
  const stop = () => {
    void port.close().catch(() => {});
  };
  run.addEventListener("abort", stop, { once: true });
  let total = 0;
  const files: File[] = [];
  try {
    // open invokes the USB chooser before its first await.
    if (!(await port.open(run))) return null;
    const root = "/sdcard/Android/data/org.haneoka.haneoka/files/HaneokaGachaHistory";
    if ((await port.type(root)) !== "directory") throw new Error("history_device_empty");
    const entries = [];
    for await (const entry of port.list(root)) {
      run.throwIfAborted();
      if (entries.length >= 128) throw new Error("history_device_budget");
      if (entry.type === "file" && /^[a-f0-9]{64}(?:-(?:jp|global-hmt|global-en|global-kr))?\.json$/u.test(entry.name))
        entries.push(entry);
    }
    for (const entry of entries) {
      run.throwIfAborted();
      const reader = port.read(`${root}/${entry.name}`),
        chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      run.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          run.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          total += chunk.value.byteLength;
          if (size > HISTORY_BYTES * 2 || total > HISTORY_BYTES * 4) throw new Error("history_device_budget");
          chunks.push(new Uint8Array(chunk.value));
        }
        files.push(new File(chunks, entry.name, { type: "application/json" }));
      } finally {
        run.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (!files.length) throw new Error("history_device_empty");
    return files;
  } finally {
    run.removeEventListener("abort", stop);
    await port.close();
  }
}
