/**
 * Japan-egress relay for the game's version discovery endpoints.
 *
 * The JP service refuses some datacenter IP ranges (observed: GitHub-hosted
 * runner egress) while accepting Cloudflare's Smart Placement colo near the
 * origin. This worker relays exactly two POST paths and returns the upstream
 * response unchanged; grpc-status arrives as an HTTP/2 trailer that Workers
 * fetch cannot observe, so a successful gRPC response gets the header
 * synthesized — the clients only read headers and body.
 */

const UPSTREAM_ORIGIN = "https://api.bang-dream-on.jp";

const ALLOWED_PATHS = new Set([
  "/app.announcement.AnnouncementService/GetList",
  "/app.masterdata.MasterdataService/Version",
]);

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "te",
  "x-platform",
  "user-agent",
  "grpc-accept-encoding",
  "grpc-timeout",
] as const;

const HOP_BY_HOP = /^(content-length|transfer-encoding|connection|keep-alive|host|cf-connecting-ip|x-forwarded.*)$/i;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !ALLOWED_PATHS.has(url.pathname)) {
      return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(UPSTREAM_ORIGIN + url.pathname, {
      method: "POST",
      headers,
      body: request.body,
      // @ts-expect-error -- Node/Wrangler types require duplex for streaming bodies.
      duplex: "half",
      redirect: "manual",
    });
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.test(name)) responseHeaders.set(name, value);
    });
    if (
      !responseHeaders.has("grpc-status") &&
      upstream.status === 200 &&
      (upstream.headers.get("content-type") || "").startsWith("application/grpc")
    ) {
      responseHeaders.set("grpc-status", "0");
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
