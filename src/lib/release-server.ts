import { DEFAULT_LOCALE, isLocale } from "@haneoka/i18n";
import { navigationDocumentUrl } from "./document-url";
import { homePath, isReleaseServer, type ReleaseServer } from "./resource-route";
export { RELEASE_SERVERS, isReleaseServer, type ReleaseServer } from "./resource-route";
const KEY = "haneoka.release-server";

export function releaseServerFromPath(pathname: string): ReleaseServer | undefined {
  const prefix = pathname.split("/")[1];
  return isReleaseServer(prefix) ? prefix : undefined;
}

export function normalizeReleaseServer(value: unknown): ReleaseServer {
  const current = value === "gl-cbt" ? "intl-cbt" : value;
  return isReleaseServer(current) ? current : "intl";
}

export function readReleaseServer(): ReleaseServer {
  const routeServer =
    typeof location === "undefined" ? undefined : releaseServerFromPath(navigationDocumentUrl().pathname);
  if (routeServer) return routeServer;
  try {
    const queryServer =
      typeof location === "undefined" ? undefined : navigationDocumentUrl().searchParams.get("server");
    if (isReleaseServer(queryServer)) return queryServer;
  } catch {}
  try {
    const stored = localStorage.getItem(KEY);
    const current = normalizeReleaseServer(stored);
    if (stored === "gl-cbt") localStorage.setItem(KEY, current);
    return current;
  } catch {
    return "intl";
  }
}

export function writeReleaseServer(value: unknown): ReleaseServer {
  const server = normalizeReleaseServer(value);
  try {
    localStorage.setItem(KEY, server);
  } catch {}
  return server;
}

/**
 * The URL prefix is the release server's address, so a change of server is a
 * change of page: rewrite the addressed server while retaining the rest of the
 * address. Pages without a server prefix (settings, legal, …) have no
 * per-server copy; their switch lands on the new server's home.
 */
export function releaseServerPath(route: string, server: ReleaseServer): string {
  if (!isReleaseServer(server)) throw new TypeError("Invalid release server");
  const path = route.split(/[?#]/u, 1)[0] || "/";
  const suffix = route.slice(path.length);
  const hash = suffix.includes("#") ? suffix.slice(suffix.indexOf("#")) : "";
  const query = new URLSearchParams(suffix.slice(0, suffix.length - hash.length).replace(/^\?/u, ""));
  query.delete("server");
  const search = query.size ? `?${query}` : "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 0 && isReleaseServer(parts[0])) {
    return `/${[server, ...parts.slice(1)].join("/")}/${search}${hash}`;
  }
  const locale = parts.length > 0 && isLocale(parts[0]) ? parts[0] : DEFAULT_LOCALE;
  return `${homePath(server, locale)}${search}${hash}`;
}
