import type { EmbedLoader } from "@haneoka/embed-core";
import type { AdvStory } from "@haneoka/vega/engine";

const mediaTypes: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
};

/** Materialize playback URLs through the bounded host transport. */
export function createPlaybackUrls(loader: EmbedLoader<AdvStory>, signal: AbortSignal, timeoutMs: number) {
  const pending = new Map<string, Promise<string>>();
  const resolvedKeys = new Map<string, Promise<string>>();
  const owned = new Set<string>();
  const resolve = (key: string): Promise<string> => {
    let keyed = resolvedKeys.get(key);
    if (keyed) return keyed;
    keyed = (async () => {
      signal.throwIfAborted();
      const source = await loader.resourceUrl(key, { signal });
      if (!/^https?:\/\//iu.test(source)) return source;
      let result = pending.get(source);
      if (!result) {
        result = (async () => {
          const bytes = await loader.resourceBytes(source, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          });
          signal.throwIfAborted();
          const extension = /\.([a-z0-9]+)$/iu.exec(new URL(source).pathname)?.[1]?.toLowerCase();
          const blob = new Blob([new Uint8Array(bytes).buffer], {
            type: mediaTypes[extension ?? ""] ?? "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          owned.add(url);
          // Howler selects its decoder from the canonical playback URL suffix.
          return extension ? `${url}#audio.${extension}` : url;
        })();
        pending.set(source, result);
      }
      return result;
    })();
    resolvedKeys.set(key, keyed);
    return keyed;
  };
  return {
    resolve,
    async prepare(keys: Iterable<string>): Promise<void> {
      const queue = [...new Set(keys)];
      let cursor = 0;
      let failed = false;
      let failure: unknown;
      const worker = async (): Promise<void> => {
        try {
          while (!failed && cursor < queue.length) {
            signal.throwIfAborted();
            await resolve(queue[cursor++]!);
          }
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      };
      // Only these four workers launch IO; all finish before the clone/rewrite pass.
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      signal.throwIfAborted();
      if (failed) throw failure;
    },
    dispose(): void {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
      pending.clear();
      resolvedKeys.clear();
    },
  };
}
