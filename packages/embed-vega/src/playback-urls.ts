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
  const owned = new Set<string>();
  return {
    async resolve(key: string): Promise<string> {
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
    },
    dispose(): void {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
      pending.clear();
    },
  };
}
