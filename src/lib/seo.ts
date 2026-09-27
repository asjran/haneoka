import { localePath, localeTag, type Locale } from "../i18n/locales";
import { CATALOG_HUB, PRIMARY_DESTINATIONS, isDestinationActive } from "../config/navigation";
import { t } from "../i18n/messages";
import { serverText } from "../i18n/server";
import { parseResourceRoute, resourceKindForCollection, resourcePath } from "./resource-route";

const PRIVATE_ROUTES = new Set([
  "/account",
  "/account/reset-password",
  "/settings",
  "/community",
  "/community/mine",
  "/community/bookmarks",
  "/community/notifications",
  "/community/activity",
  "/community/posts/new",
]);

export function canonicalPath(route: string): string {
  const clean = `/${route.replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/" : `${clean}/`;
}

export function shouldNoindex(route: string): boolean {
  const path = canonicalPath(route).replace(/\/$/, "") || "/";
  return PRIVATE_ROUTES.has(path) || path === "/admin" || path.startsWith("/admin/");
}

export function pageStructuredData(
  origin: string,
  route: string,
  locale: Locale,
  name: string,
  description: string,
  localized = false,
  canonicalRoute = route,
) {
  const address = (logicalRoute: string) =>
    `${origin}${canonicalPath(localized ? localePath(logicalRoute, locale) : logicalRoute)}`;
  const home = address("/");
  const url = `${origin}${canonicalPath(canonicalRoute)}`;
  const website = {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    url: `${origin}/`,
    name: "haneoka",
    alternateName: "Haneoka",
  };
  const page = {
    "@type": "WebPage",
    "@id": `${url}#page`,
    url,
    name,
    description,
    inLanguage: localeTag(locale),
    isPartOf: { "@id": website["@id"] },
  };
  if (route === "/") return { "@context": "https://schema.org", "@graph": [website, page] };
  const parent = PRIMARY_DESTINATIONS.find((destination) => isDestinationActive(destination, route));
  const canonicalResource = parseResourceRoute(canonicalRoute);
  const collectionUrl = canonicalResource?.id
    ? `${origin}${resourcePath({ ...canonicalResource, id: undefined })}`
    : undefined;
  const collection = canonicalResource
    ? CATALOG_HUB.find((entry) => resourceKindForCollection(entry.resource || "") === canonicalResource.kind)
    : undefined;
  const trail = [
    { name: "haneoka", item: home },
    ...(collectionUrl && canonicalResource
      ? [
          { name: t(locale, "catalog", "Catalog"), item: `${address("/catalog")}?server=${canonicalResource.server}` },
          { name: t(locale, collection?.label || canonicalResource.kind, canonicalResource.kind), item: collectionUrl },
        ]
      : parent && parent.route !== "/" && canonicalPath(parent.route) !== canonicalPath(route)
        ? [{ name: t(locale, parent.label, parent.id), item: address(parent.route) }]
        : []),
    { name: name.replace(/ · haneoka$/, ""), item: url },
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      page,
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: trail.map((item, index) => ({ "@type": "ListItem", position: index + 1, ...item })),
      },
    ],
  };
}

export function pageDescription(locale: Locale, route: string, title: string): string {
  const resource = route.startsWith("/catalog/")
    ? serverText(locale, `seo.resources.${route.slice(9)}`, undefined, "")
    : "";
  if (resource) return resource;
  const key =
    route === "/"
      ? "home"
      : route === "/catalog"
        ? "catalog"
        : route.startsWith("/catalog/")
          ? "catalogItem"
          : route === "/about"
            ? "about"
            : route === "/community/tags"
              ? "communityTags"
              : route === "/community/playlists"
                ? "communityPlaylists"
                : route === "/community/songs-bestdori"
                  ? "communitySongs"
                  : route.startsWith("/community/stories-bestdori/")
                    ? "communityStories"
                    : route.startsWith("/community")
                      ? "community"
                      : route === "/terms"
                        ? "terms"
                        : route === "/privacy"
                          ? "privacy"
                          : "general";
  return serverText(locale, `seo.descriptions.${key}`, { title }, title).trim();
}
