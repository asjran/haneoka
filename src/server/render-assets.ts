import { renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { AssetPageData, AssetViewData } from "../lib/asset-page-data";
import type { Locale } from "../i18n/locales";
export async function renderAssets(page: AssetPageData, locale: Locale, view?: AssetViewData) {
  const { AssetExplorer } = await import("../lit/asset-explorer");
  useStaticLocale(locale, "/catalog/assets");
  const workspace = new AssetExplorer();
  workspace.preparePage(page, view);
  return renderWorkspacePage(workspace, locale, "/catalog/assets");
}
