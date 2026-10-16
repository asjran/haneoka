import { renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import type { CatalogSystemPayload } from "../lib/catalog-system-data";
import type { Locale } from "../i18n/locales";

export async function renderCatalogSystem(payload: CatalogSystemPayload, locale: Locale): Promise<StaticWorkspacePage> {
  const constructors = {
    missions: () => import("../lit/mission-workspace").then(module => module.MissionWorkspace),
    studio: () => import("../lit/studio-workspace").then(module => module.StudioWorkspace),
    "tgw-card": () => import("../lit/tgw-card-workspace").then(module => module.TgwCardWorkspace),
    "anon-tokyo": () => import("../lit/anon-tokyo-workspace").then(module => module.AnonTokyoWorkspace),
  };
  const Constructor = await constructors[payload.kind]();
  const route = `/catalog/${payload.kind}${payload.kind === "anon-tokyo" ? `/${payload.mode}` : ""}`;
  useStaticLocale(locale, route);
  const workspace = new Constructor();
  workspace.preparePage(payload, locale);
  return renderWorkspacePage(workspace, locale, route);
}
