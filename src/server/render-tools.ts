import { useStaticLocale, renderWorkspacePage, type StaticWorkspacePage } from "./render-workspace";
import type { SonolusHubPageData } from "./tool-page-data";
import type { RankingCardCatalog } from "../lib/game-records";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";
import type {
  TeamBuilderPageData,
  SongPuzzlePageData,
  StampMakerPageData,
  PublicSongsPageData,
} from "./tool-page-data";
export async function renderTeamBuilderPage(
  payload: TeamBuilderPageData,
  locale: Locale,
): Promise<StaticWorkspacePage> {
  const { TeamBuilder } = await import("../lit/team-builder");
  useStaticLocale(locale, "/team-builder");
  const workspace = new TeamBuilder();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/team-builder");
}
export async function renderSongPuzzlePage(payload: SongPuzzlePageData, locale: Locale): Promise<StaticWorkspacePage> {
  const { SongPuzzle } = await import("../lit/song-puzzle");
  useStaticLocale(locale, "/song-puzzle");
  const workspace = new SongPuzzle();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/song-puzzle");
}
export async function renderStampMakerPage(payload: StampMakerPageData, locale: Locale): Promise<StaticWorkspacePage> {
  const { StampMaker } = await import("../lit/stamp-maker");
  useStaticLocale(locale, "/stamp-maker");
  const workspace = new StampMaker();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/stamp-maker");
}
export async function renderSongGuessPage(payload: PublicSongsPageData, locale: Locale): Promise<StaticWorkspacePage> {
  const { SongGuess } = await import("../lit/song-guess");
  useStaticLocale(locale, "/song-guess");
  const workspace = new SongGuess();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/song-guess");
}
export async function renderSongProgressPage(
  payload: PublicSongsPageData,
  locale: Locale,
): Promise<StaticWorkspacePage> {
  const { SongProgress } = await import("../lit/song-progress");
  useStaticLocale(locale, "/song-progress");
  const workspace = new SongProgress();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/song-progress");
}
export async function renderChartCreationPage(
  payload: PublicSongsPageData,
  locale: Locale,
): Promise<StaticWorkspacePage> {
  const { ChartCreationWorkspace } = await import("../lit/chart-creation-workspace");
  useStaticLocale(locale, "/chart-editor/create");
  const workspace = new ChartCreationWorkspace();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/chart-editor/create");
}
export async function renderGlobalSearchPage(locale: Locale): Promise<StaticWorkspacePage> {
  const { GlobalSearch } = await import("../lit/global-search");
  useStaticLocale(locale, "/search");
  const workspace = new GlobalSearch();
  workspace.locale = locale;
  return renderWorkspacePage(workspace, locale, "/search");
}
export async function renderSongRankingPage(
  cards: Partial<Record<"jp" | "intl", RankingCardCatalog>>,
  locale: Locale,
  server: ReleaseServer,
  songId: string,
): Promise<StaticWorkspacePage> {
  const { SongRanking } = await import("../lit/song-ranking");
  useStaticLocale(locale, "/catalog/songs");
  const workspace = new SongRanking();
  workspace.locale = locale;
  workspace.server = server;
  workspace.songId = songId;
  workspace.preparePage(cards);
  return renderWorkspacePage(workspace, locale, "/catalog/songs");
}
export async function renderPlayerProfilePage(
  cards: Partial<Record<"jp" | "intl", RankingCardCatalog>>,
  locale: Locale,
): Promise<StaticWorkspacePage> {
  const { PlayerProfileWorkspace } = await import("../lit/player-profile-workspace");
  useStaticLocale(locale, "/player-profile");
  const workspace = new PlayerProfileWorkspace();
  workspace.locale = locale;
  workspace.preparePage(cards);
  return renderWorkspacePage(workspace, locale, "/player-profile");
}
export async function renderSonolusHubPage(payload: SonolusHubPageData, locale: Locale): Promise<StaticWorkspacePage> {
  const { SonolusHub } = await import("../lit/sonolus-hub");
  useStaticLocale(locale, "/sonolus");
  const workspace = new SonolusHub();
  workspace.locale = locale;
  workspace.preparePage(payload);
  return renderWorkspacePage(workspace, locale, "/sonolus");
}
