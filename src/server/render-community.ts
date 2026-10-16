import type { Locale } from "../i18n/locales";
import { publicForumDirectory } from "./public-forum-navigation";
import { renderWorkspacePage, useStaticLocale } from "./render-workspace";

export async function renderPublicForumDirectory(locale: Locale) {
  const [directory, { CommunityWorkspace }] = await Promise.all([publicForumDirectory(), import("../lit/community-workspace")]);
  const route = `/${locale}/community/forums/`;
  useStaticLocale(locale, route);
  const workspace = new CommunityWorkspace();
  workspace.preparePublicForums(directory, locale);
  return { directory, page: renderWorkspacePage(workspace, locale, route) };
}
