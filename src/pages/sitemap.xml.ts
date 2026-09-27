import type { APIRoute } from "astro";
import { LOCALES, localePath } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { canonicalPath, shouldNoindex } from "../lib/seo";
import { searchableCatalogUrls } from "../lib/searchable-catalog";
import { searchableHelpUrls } from "../lib/searchable-help";
import { searchableModelUrls } from "../lib/searchable-models";
import { searchableStoryUrls } from "../lib/searchable-stories";
import { legacyEntityRedirectTarget } from "../lib/resource-route";

const XML_ROUTES = ROUTES.filter(({ route }) => !shouldNoindex(route));

export const GET: APIRoute = async () => {
  const [catalogUrls, storyUrls, modelUrls, helpUrls] = await Promise.all([
    searchableCatalogUrls(),
    searchableStoryUrls(),
    searchableModelUrls(),
    searchableHelpUrls(),
  ]);
  const pageUrls = XML_ROUTES.flatMap(({ route }) =>
    LOCALES.map((locale) => `https://haneoka.org${canonicalPath(localePath(route, locale))}`),
  );
  // Entity URLs are server-first. The legacy loaders retain their logical
  // collection routes for the client, so resolve those aliases once here
  // instead of publishing redirecting URLs in the sitemap.
  const entityUrls = [...catalogUrls, ...storyUrls, ...modelUrls, ...helpUrls].flatMap((route) =>
    LOCALES.flatMap((locale) => {
      const target = legacyEntityRedirectTarget(`/${locale}${route}`);
      return target ? [`https://haneoka.org${target}`] : [];
    }),
  );
  const urls = [...pageUrls, ...entityUrls];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
};
