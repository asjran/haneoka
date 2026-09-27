import { isLocale, type Locale } from "@haneoka/i18n";

export const RELEASE_SERVERS = ["jp", "intl", "jp-cbt", "intl-cbt"] as const;
export type ReleaseServer = (typeof RELEASE_SERVERS)[number];
export const isReleaseServer = (value: unknown): value is ReleaseServer =>
  typeof value === "string" && RELEASE_SERVERS.includes(value as ReleaseServer);

export const RESOURCE_KINDS = [
  "characters",
  "songs",
  "member-cards",
  "support-cards",
  "stories",
  "comics",
  "stamps",
  "stickers",
  "backgrounds",
  "band-items",
  "items",
  "events",
  "real-lives",
  "gacha",
  "login-campaigns",
  "shop",
  "exchange",
  "circle",
  "challenge",
  "passes",
  "missions",
  "tgw-card",
  "live2d",
  "spine",
  "help",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceRoute {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id?: string;
}

export interface EntityLink {
  href: string;
  title?: string;
}

export interface EntityRouteContext {
  kind: ResourceKind;
  id: string;
  href: string;
  backHref: string;
  previous?: EntityLink;
  next?: EntityLink;
}

export interface EntitySelection {
  route: ResourceRoute & { id: string };
  source: "canonical" | "legacy";
  returnTo?: string;
}

const isResourceKind = (value: unknown): value is ResourceKind =>
  typeof value === "string" && (RESOURCE_KINDS as readonly string[]).includes(value);

const isResourceId = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value);

/** Public resource addresses contain identity; content revisions belong in data URLs. */
export function resourcePath({ server, locale, kind, id }: ResourceRoute): string {
  if (!isReleaseServer(server) || !isLocale(locale) || !isResourceKind(kind))
    throw new TypeError("Invalid resource route");
  if (id !== undefined && !isResourceId(id)) throw new TypeError("Invalid resource identity");
  return `/${server}/${locale}/${kind}/${id === undefined ? "" : `${encodeURIComponent(id)}/`}`;
}

/** Alias for callers that need to make the canonical-vs-legacy distinction explicit. */
export const formatResourceRoute = resourcePath;

export function parseResourceRoute(pathname: string): ResourceRoute | undefined {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#")) return undefined;
  const parts = pathname.slice(1).replace(/\/$/u, "").split("/");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const [server, locale, kind, encodedId] = parts;
  if (!isReleaseServer(server) || !isLocale(locale) || !isResourceKind(kind)) return undefined;
  if (encodedId === undefined) return { server, locale, kind };
  try {
    const id = decodeURIComponent(encodedId);
    return isResourceId(id) ? { server, locale, kind, id } : undefined;
  } catch {
    return undefined;
  }
}

const COLLECTION_KIND_ALIASES: Readonly<Record<string, ResourceKind>> = {
  cards: "member-cards",
  "member-cards": "member-cards",
  "support-cards": "support-cards",
  "song-meta": "songs",
};

const SELECTION_PARAMS: Readonly<Partial<Record<ResourceKind, string>>> = {
  characters: "character",
  songs: "song",
  "member-cards": "card",
  "support-cards": "snap",
  comics: "comic",
  stamps: "stamp",
  stickers: "sticker",
  backgrounds: "background",
  "band-items": "item",
  items: "item",
  events: "entry",
  "real-lives": "entry",
  gacha: "entry",
  "login-campaigns": "entry",
  shop: "entry",
  exchange: "entry",
  circle: "entry",
  challenge: "entry",
  passes: "entry",
  stories: "story",
  live2d: "model",
  spine: "model",
  help: "topic",
};

export function selectionParamForKind(kind: ResourceKind): string | undefined {
  return SELECTION_PARAMS[kind];
}

export function resourceKindForCollection(collection: string): ResourceKind | undefined {
  const value = COLLECTION_KIND_ALIASES[collection] ?? collection;
  return isResourceKind(value) ? value : undefined;
}

function queryStringWithoutSelection(search: string, kind: ResourceKind): string {
  const params = new URLSearchParams(search);
  const selection = selectionParamForKind(kind);
  if (selection) params.delete(selection);
  const value = params.toString();
  return value ? `?${value}` : "";
}

/**
 * Resolve a previously published locale-first detail address to the one
 * server-first identity. Old public SSR was generated from Intl, so aliases
 * intentionally always target `intl`, regardless of localStorage.
 */
export function legacyEntityRoute(
  pathname: string,
  search = "",
  server: ReleaseServer = "intl",
): (ResourceRoute & { id: string }) | undefined {
  if (!pathname.startsWith("/") || pathname.includes("#")) return undefined;
  const parts = pathname.replace(/^\/+|\/+$/gu, "").split("/");
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "catalog") return undefined;

  let kind: ResourceKind | undefined;
  let id: string | undefined;
  if (parts[2] === "stories" && parts.length >= 3 && parts.length <= 5) {
    kind = "stories";
    id = parts.length === 5 ? parts[4] : undefined;
  } else if (parts.length === 3 || parts.length === 4) {
    kind = resourceKindForCollection(parts[2] || "");
    id = parts[3];
  }
  if (!kind) return undefined;
  if (id) {
    try {
      id = decodeURIComponent(id);
    } catch {
      return undefined;
    }
  }

  const selection = selectionParamForKind(kind);
  const query = new URLSearchParams(search);
  if (!id && selection) id = query.get(selection) || undefined;
  if (!id || !isResourceId(id)) return undefined;
  const explicitServer = query.get("server");
  return { server: isReleaseServer(explicitServer) ? explicitServer : server, locale, kind, id };
}

export function legacyEntityRedirectTarget(pathname: string, search = ""): string | undefined {
  const collection = parseResourceRoute(pathname);
  const param = collection ? selectionParamForKind(collection.kind) : undefined;
  const selected = param ? new URLSearchParams(search).get(param) : undefined;
  const route =
    collection && !collection.id && selected && isResourceId(selected)
      ? { ...collection, id: selected }
      : legacyEntityRoute(pathname, search);
  if (!route) return undefined;
  const query = new URLSearchParams(queryStringWithoutSelection(search, route.kind));
  query.delete("server");
  return `${resourcePath(route)}${query.size ? `?${query}` : ""}`;
}

/** Map logical catalogue destinations to the selected server's collections. */
export function resourceCollectionHref(route: string, server: ReleaseServer, locale: Locale): string | undefined {
  const source = new URL(route, "https://route.invalid");
  const parts = source.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts[0] !== "catalog" || !parts[1] || parts[1] === "song-meta") return undefined;
  const kind = resourceKindForCollection(parts[1]);
  if (!kind || (parts.length > 2 && kind !== "stories")) return undefined;
  const target = new URL(resourcePath({ server, locale, kind }), source);
  target.search = source.search;
  if (kind === "stories" && parts[2]) target.searchParams.set("mode", parts[2]);
  return `${target.pathname}${target.search}`;
}

export function entityHref(options: {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id: string;
  returnTo?: string;
  query?: string | URLSearchParams | Readonly<Record<string, string>>;
}): string {
  const target = new URL(resourcePath(options), "https://route.invalid");
  if (options.returnTo) target.searchParams.set("return", options.returnTo);
  if (options.query) {
    const query =
      typeof options.query === "string"
        ? new URLSearchParams(options.query)
        : options.query instanceof URLSearchParams
          ? options.query
          : new URLSearchParams(Object.entries(options.query));
    for (const [key, value] of query) target.searchParams.append(key, value);
  }
  return `${target.pathname}${target.search}`;
}

export function parseEntitySelection(pathname: string, search = ""): EntitySelection | undefined {
  const canonical = parseResourceRoute(pathname);
  if (canonical?.kind === "stories" && ["band", "link", "home", "afterlive", "tutorial"].includes(canonical.id || ""))
    return undefined;
  if (canonical?.id) return { route: canonical as ResourceRoute & { id: string }, source: "canonical" };
  const legacy = legacyEntityRoute(pathname, search);
  if (!legacy) return undefined;
  const returnTo = `${pathname}${queryStringWithoutSelection(search, legacy.kind)}`;
  return returnTo === pathname ? { route: legacy, source: "legacy" } : { route: legacy, source: "legacy", returnTo };
}

export function returnStateFromLocation(pathname: string, search: string, kind: ResourceKind): string {
  return `${pathname}${queryStringWithoutSelection(search, kind)}`;
}
