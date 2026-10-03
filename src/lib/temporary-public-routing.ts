import { DEFAULT_LOCALE, isLocale } from "@haneoka/i18n";
import {
  homePath,
  isStoryMode,
  resourceKindForCollection,
  resourcePath,
  selectionParamForKind,
  storyCollectionPath,
} from "./resource-route";

/** Public website choices; archival API server keys remain registered separately. */
export const PUBLIC_RELEASE_SERVERS = ["jp", "intl"] as const;
export type PublicReleaseServer = (typeof PUBLIC_RELEASE_SERVERS)[number];
export const isPublicReleaseServer = (value: unknown): value is PublicReleaseServer =>
  value === "jp" || value === "intl";

export function formalServerForHidden(value: unknown): PublicReleaseServer | undefined {
  if (value === "jp-cbt") return "jp";
  if (value === "intl-cbt" || value === "gl-cbt") return "intl";
  return undefined;
}

export const isTemporarilyHiddenRoute = (route: string): boolean =>
  route === "/catalog/anon-tokyo" || route.startsWith("/catalog/anon-tokyo/");

/**
 * Website-only temporary redirects. A CBT native id has no verified formal
 * identity here, so entity links land on the corresponding collection.
 * Historical API/raw paths and the original route registry are untouched.
 */
export function temporaryPublicRedirectTarget(pathname: string, search = "", hash = ""): string | undefined {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\?#\u0000-\u001f]/u.test(pathname)) return undefined;
  const parts = pathname.split("/").filter(Boolean);
  if (["api", "assets", "runtime", "embed"].includes(parts[0] || "")) return undefined;
  const query = new URLSearchParams(search);
  const prefixServer = formalServerForHidden(parts[0]);
  const queryServer = formalServerForHidden(query.get("server"));
  const server = prefixServer || queryServer;
  if (!server) return undefined;
  const addressedLocale = prefixServer ? parts[1] : parts[0];
  const locale = isLocale(addressedLocale) ? addressedLocale : DEFAULT_LOCALE;
  const tail = !isLocale(addressedLocale)
    ? []
    : prefixServer
      ? parts.slice(2)
      : parts[1] === "catalog"
        ? parts.slice(2)
        : [];
  let target = homePath(server, locale);
  const section = tail[0] || "";
  const kind = resourceKindForCollection(section);
  if (section === "events" && tail[1] === "tracker") {
    target = `/${server}/${locale}/events/tracker/`;
  } else if (kind === "circle" || kind === "challenge") {
    target = `/${server}/${locale}/catalog/`;
  } else if (kind) {
    target =
      kind === "stories" && isStoryMode(tail[1])
        ? storyCollectionPath({ server, locale, mode: tail[1] })
        : resourcePath({ server, locale, kind });
    const selected = selectionParamForKind(kind);
    if (selected) query.delete(selected);
  } else if (section === "announcements") {
    target = `/${server}/${locale}/announcements/`;
    query.delete("id");
  } else if (["catalog", "anon-tokyo"].includes(section)) {
    target = `/${server}/${locale}/catalog/`;
  } else if (["calendar", "assets", "song-meta"].includes(section)) {
    target = `/${server}/${locale}/${section}/`;
  } else if (!prefixServer && parts.length > 1 && parts[1] !== "catalog") {
    // Locale-only legal/settings pages keep their own pathname.
    target = pathname.endsWith("/") ? pathname : `${pathname}/`;
  }
  query.delete("server");
  for (const key of ["release", "releaseId", "source", "sourceId"]) query.delete(key);
  const returnTo = query.get("return");
  if (returnTo) {
    if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
      query.delete("return");
    } else {
      const returned = new URL(returnTo, "https://route.invalid");
      returned.searchParams.delete("return");
      const mapped = temporaryPublicRedirectTarget(returned.pathname, returned.search, returned.hash);
      if (mapped) query.set("return", mapped);
    }
  }
  return `${target}${query.size ? `?${query}` : ""}${hash.startsWith("#") ? hash : ""}`;
}
