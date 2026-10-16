import { renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { AnnouncementPageData } from "../lib/announcement-page-data";
import type { Locale } from "../i18n/locales";

export async function renderAnnouncements(page: AnnouncementPageData, locale: Locale, detail = false, id?: number) {
  const Constructor = detail ? (await import("../lit/announcement-detail")).AnnouncementDetail : (await import("../lit/announcement-feed")).AnnouncementFeed;
  useStaticLocale(locale, "/announcements");
  const workspace = new Constructor();
  workspace.preparePage(page, locale, id);
  return renderWorkspacePage(workspace, locale, "/announcements");
}
