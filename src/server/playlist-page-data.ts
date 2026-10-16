import { fetchStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import { readProviderCatalog } from "./provider-page-data";
import { providerCatalogBase } from "../lib/provider-page-data";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { playlistCatalogSourceFromRecords, type PlaylistCatalogSource } from "../lib/playlist-tracks";
import { bgmLibrarySongs, mergeSongLibrary, serializeSongLibrary, deserializeSongLibrary, officialPlaylists } from "../lib/playlists/library";
import type { PlaylistPageData } from "../lib/playlists/page-data";
import { pinCrossCatalogValue } from "../lib/cross-server/presentation";
import { serializePageData } from "../lib/page-data";
import { playlistStaticDocumentPath, playlistStaticId } from "../lib/playlists/static-routing";
import { LOCALES } from "../i18n/locales";
import { registerStaticDocumentCoverage } from "./static-documents";

type RecordValue = Record<string, unknown>;
let page: Promise<PlaylistPageData> | undefined;
const serialized = new WeakMap<PlaylistPageData, string>();
export function serializedPlaylistPage(value: PlaylistPageData): string {
  let text = serialized.get(value);
  if (!text) { text = serializePageData(value); serialized.set(value, text); }
  return text;
}
let paths: Promise<Array<{ params: { locale: string; id: string }; props: { playlist: string; server: string } }>> | undefined;
export function playlistStaticPaths() {
  return paths ||= (async () => {
    const data = await playlistPageData(), ids = new Map<string, string>();
    for (const [server, variant] of Object.entries(data.variants)) {
      for (const playlist of officialPlaylists(deserializeSongLibrary(variant), data.gamePlaylists)) {
        for (const id of [playlist.id, ...(playlist.aliases || [])]) if (!ids.has(id)) ids.set(id, server);
      }
    }
    const result = LOCALES.flatMap(locale => [...ids].map(([playlist, server]) => ({ params: { locale, id: `${playlistStaticId(playlist)}.html` }, props: { playlist, server } })));
    registerStaticDocumentCoverage("playlists", LOCALES.flatMap(locale => [...ids.keys()].map(id => playlistStaticDocumentPath(locale, id))), false);
    return result;
  })();
}
export function playlistPageData(): Promise<PlaylistPageData> {
  return page ||= loadData();
}
async function loadData(): Promise<PlaylistPageData> {
  const [native, gbp, game] = await Promise.all([
    Promise.allSettled((["intl", "jp"] as const).map(async server => {
      const identity = await staticCatalogRelease(server);
      const [songs, bands, characters] = await Promise.all(["songs", "bands", "characters"].map(resource => fetchStaticCatalog(resource, server, identity)));
      const bgms = await fetchStaticCatalog("audio/views/master-bgms", server, identity).catch(() => ({}));
      const pin = (value: unknown) => pinCrossCatalogValue(value, { ...identity, server }) as RecordValue;
      const source = playlistCatalogSourceFromRecords("our-notes", server, pin(songs), pin(bands), pin(characters), identity);
      return { source, bgm: bgmLibrarySongs(server, source.registry.bands, pin(bgms) as Record<string, RecordValue>) };
    })),
    Promise.all([
      readProviderCatalog(`${providerCatalogBase("bestdori", "ja")}/songs?lang=ja&projection=${BESTDORI_CATALOG_VERSION}`),
      readProviderCatalog(`${providerCatalogBase("bestdori", "ja")}/bands`),
      readProviderCatalog(`${providerCatalogBase("bestdori", "ja")}/characters`),
    ]).then(([songs, bands, characters]) => ({ status: "fulfilled" as const, value: playlistCatalogSourceFromRecords("bestdori", "jp", songs, bands, characters) })).catch(reason => ({ status: "rejected" as const, reason })),
    readProviderCatalog("/api/v1/garupa/playlists").then(data => ({ lists: Array.isArray(data.playlists) ? data.playlists as RecordValue[] : [], error: "" })).catch(error => ({ lists: [] as RecordValue[], error: error instanceof Error ? error.message : String(error) })),
  ]);
  const variants: PlaylistPageData["variants"] = {};
  (["intl", "jp"] as const).forEach((server, index) => {
    const result = native[index]!;
    const source: PromiseSettledResult<PlaylistCatalogSource> = result.status === "fulfilled" ? { status: "fulfilled", value: result.value.source } : result;
    variants[server] = serializeSongLibrary(mergeSongLibrary(source, gbp, result.status === "fulfilled" ? result.value.bgm : []));
  });
  return { schema: "haneoka-playlist-page-v1", variants, gamePlaylists: game.lists, gameError: game.error };
}
