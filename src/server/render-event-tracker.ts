import { renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { TrackerPageData } from "../lib/event-tracker-page-data";
import type { Locale } from "../i18n/locales";
import type { ReleaseServer } from "../lib/release-server";
export async function renderEventTracker(page: TrackerPageData, locale: Locale, server: ReleaseServer) {
  const { EventTracker } = await import("../lit/event-tracker");
  useStaticLocale(locale, "/catalog/events/tracker");
  const workspace = new EventTracker();
  workspace.preparePage(page, locale, server);
  return renderWorkspacePage(workspace, locale, "/catalog/events/tracker");
}
