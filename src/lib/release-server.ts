import { isReleaseServer, type ReleaseServer } from "./resource-route";
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
  const routeServer = typeof location === "undefined" ? undefined : releaseServerFromPath(location.pathname);
  if (routeServer) return routeServer;
  try {
    const queryServer = typeof location === "undefined" ? undefined : new URL(location.href).searchParams.get("server");
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
