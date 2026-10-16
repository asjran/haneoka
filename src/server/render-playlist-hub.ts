import { renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { Locale } from "../i18n/locales";
import type { PlaylistPageData } from "../lib/playlists/page-data";
export async function renderPlaylistHub(page: PlaylistPageData, locale: Locale, selected = "", server = "intl") {
  const { PlaylistHub } = await import("../lit/playlist-hub");
  useStaticLocale(locale, "/community/playlists");
  const workspace = new PlaylistHub();
  workspace.preparePage(page, locale, server, selected);
  return { ...renderWorkspacePage(workspace, locale, "/community/playlists"), selectedTitle: workspace.selectedTitle() };
}
