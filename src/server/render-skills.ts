import { renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import type { Locale } from "../i18n/locales";
import type { SkillCatalogPayload } from "./skill-catalog";

export async function renderSkillsWorkspace(payload: SkillCatalogPayload, locale: Locale, entityId = ""): Promise<StaticWorkspacePage> {
  const { SkillsWorkspace } = await import("../lit/skills-workspace");
  const route = "/catalog/skills";
  useStaticLocale(locale, route);
  const workspace = new SkillsWorkspace();
  workspace.preparePage(payload, locale, entityId);
  return renderWorkspacePage(workspace, locale, route);
}
