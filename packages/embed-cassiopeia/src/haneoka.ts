import { createEmbedLoader } from "@haneoka/embed-core";
import { haneokaDataSource } from "@haneoka/embed-core/haneoka";
import type { DataSource } from "@haneoka/embed-core";
import type { ChartEmbedDocument, ChartTheme } from "./types.js";
import { createNativeTheme } from "./native-theme.js";

export interface HaneokaChartSourceOptions {
  readonly songId: string;
  readonly difficulty: "easy" | "normal" | "hard" | "expert" | "special" | "master";
  readonly apiBase?: string;
}
interface Song {
  musicUrl: string;
  difficulty: Array<{ difficultyName: string; file: string }>;
}

export function haneokaChartSource(options: HaneokaChartSourceOptions): DataSource<ChartEmbedDocument> {
  const source = haneokaDataSource<Song>({
    resource: "songs",
    id: options.songId,
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  return {
    ...(source.assetsBase ? { assetsBase: source.assetsBase } : {}),
    async load(context) {
      const song = await source.load(context);
      if (!Array.isArray(song.difficulty) || typeof song.musicUrl !== "string")
        throw new TypeError("Invalid song response");
      const selected = song.difficulty.find((entry) => entry.difficultyName === options.difficulty);
      if (!selected?.file) throw new Error(`Song ${options.songId} has no ${options.difficulty} chart`);
      const chartLoader = createEmbedLoader({
        source: { assetsBase: source.assetsBase!, load: () => null },
        fetcher: context.fetcher,
        maxBytes: context.maxBytes,
      });
      const unsubscribe = chartLoader.subscribe((event) => {
        if (event.type === "progress") context.progress(event);
      });
      try {
        const bytes = await chartLoader.resourceBytes(selected.file, { signal: context.signal });
        const { parseScore, buildChart } = await import("@haneoka/cassiopeia-plugin-our-notes");
        context.signal.throwIfAborted();
        return {
          chart: buildChart(parseScore(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
          audio: song.musicUrl,
        };
      } finally {
        unsubscribe();
        await chartLoader.dispose();
      }
    },
  };
}

/** Optional original visual/audio theme; independent from the document's origin. */
export function haneokaChartTheme(
  options: { readonly apiBase?: string; readonly publicBase?: string; readonly server?: string } = {},
): ChartTheme {
  const apiBase = new URL(options.apiBase ?? "https://haneoka.org/api/v1/");
  if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";
  const publicBase = new URL(options.publicBase ?? "/", apiBase);
  return (context) =>
    createNativeTheme({ ...context, apiBase, publicBase, server: options.server ?? context.loader.server ?? "intl" });
}
