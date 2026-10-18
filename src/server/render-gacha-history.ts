import { renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { Locale } from "../i18n/locales";

export async function renderGachaHistory(locale: Locale) {
  const { GachaHistory } = await import("../lit/gacha-history");
  useStaticLocale(locale, "/gacha-history");
  const view = new GachaHistory();
  view.locale = locale;
  view.canImport = true;
  view.showAppLink = true;
  view.importSources = ["saved", "files"];
  return renderWorkspacePage(view, locale, "/gacha-history");
}
