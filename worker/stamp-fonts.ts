/** Fixed public font sources; no caller-selected upstream URL or credentials. */
const ROOT = "/stamp-maker-fonts/";
const SEKAI_COMMIT = "0dd52ee69f8838dd173ee252810325debe96731a";
const PRETENDARD_COMMIT = "5c41199ea0024a9e0b2cb31735265056e5472d76";
const VERSION = "5.3.0";
const CACHE_CONTROL = "public, max-age=86400, must-revalidate";
const MAX_FONT_BYTES = 12 * 1024 * 1024;
const MAX_CSS_BYTES = 512 * 1024;
const CUSTOM: Readonly<Record<string, string>> = {
  "c89bc43027dc7cde5726e96223376f8eec09302b2fc1f8147fd5b57cfc376118.otf": `https://raw.githubusercontent.com/orioncactus/pretendard/${PRETENDARD_COMMIT}/packages/pretendard/dist/public/static/Pretendard-SemiBold.otf`,
  "604b78800e5bac3ef9dbb0fdb87bef7ecaafcd553330fda5c3d725e32569f4de.woff2": `https://raw.githubusercontent.com/BedrockDigger/sekai-stickers/${SEKAI_COMMIT}/src/fonts/YurukaStd.woff2`,
  "077c89525d0a48b5775f8fadbf09a40344ff4845779202f1f9c39b7857ad4e2e.woff2": `https://raw.githubusercontent.com/BedrockDigger/sekai-stickers/${SEKAI_COMMIT}/src/fonts/ShangShouFangTangTi.woff2`,
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match",
  "Access-Control-Expose-Headers": "Content-Length, ETag, X-Haneoka-Font-Source",
  "X-Content-Type-Options": "nosniff",
};

interface FontRoute {
  source: string;
  relative: string;
  region?: string;
  css: boolean;
  expectedHash?: string;
}

function basename(value: string, region: string): boolean {
  return (
    value.length <= 160 &&
    new RegExp(`^noto-serif-${region}-[a-z0-9-]+-wght-(?:normal|italic)\\.woff2?$`, "u").test(value)
  );
}

function route(pathname: string): FontRoute | null {
  const relative = pathname.slice(ROOT.length);
  const custom = Object.prototype.hasOwnProperty.call(CUSTOM, relative) ? CUSTOM[relative] : undefined;
  if (custom) return { source: custom, relative, css: false, expectedHash: relative.split(".")[0]! };
  const match = /^noto-serif-(sc|tc|jp|kr)-v5\.3\.0\/(wght\.css|files\/([^/]+))$/u.exec(relative);
  const region = match?.[1];
  const file = match?.[2];
  if (!region || !file || (match[3] !== undefined && !basename(match[3], region))) return null;
  return {
    source: `https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-serif-${region}@${VERSION}/${file}`,
    relative,
    region,
    css: file === "wght.css",
  };
}

async function bytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(response.headers.get("content-length"));
  if (!response.body || length > limit) {
    await response.body?.cancel();
    throw new Error("Font response exceeds budget or has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error("Font response exceeds budget");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function fontType(data: Uint8Array): string {
  if (data.length < 12) throw new Error("Invalid font body");
  const magic = String.fromCharCode(...data.subarray(0, 4));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (magic === "wOF2" || magic === "wOFF") {
    if (data.length < (magic === "wOF2" ? 48 : 44) || view.getUint32(8) !== data.length || view.getUint16(12) === 0)
      throw new Error("Invalid WOFF font length or table directory");
    return magic === "wOF2" ? "font/woff2" : "font/woff";
  }
  if (magic === "OTTO" || view.getUint32(0) === 0x00010000) {
    const tables = view.getUint16(4);
    if (!tables || 12 + tables * 16 > data.length) throw new Error("Invalid SFNT table directory");
    return magic === "OTTO" ? "font/otf" : "font/ttf";
  }
  throw new Error("Upstream body is not a supported font");
}

function stylesheet(data: Uint8Array, selected: FontRoute): Uint8Array<ArrayBuffer> {
  if (!selected.region) throw new Error("Missing font stylesheet region");
  const css = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  if (!css.includes("@font-face") || /@import\b/iu.test(css)) throw new Error("Invalid font stylesheet");
  let count = 0;
  const rewritten = css.replace(
    /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/giu,
    (_entry, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const url = double ?? single ?? bare ?? "";
      const prefix = `${ROOT}noto-serif-${selected.region}-v${VERSION}/files/`;
      const match =
        /^\.\/files\/([^/]+)$/u.exec(url) ?? (url.startsWith(prefix) ? [url, url.slice(prefix.length)] : null);
      if (!match?.[1] || !basename(match[1], selected.region!))
        throw new Error("Font stylesheet has an unapproved URL");
      count += 1;
      return `url("${ROOT}noto-serif-${selected.region}-v${VERSION}/files/${match[1]}")`;
    },
  );
  if (!count || /url\([^)]*(?:https?:|\/\/)/iu.test(rewritten))
    throw new Error("Font stylesheet has no local font files");
  return new Uint8Array(new TextEncoder().encode(rewritten));
}

function failure(request: Request, status: number, code: string): Response {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify({ error: { code, message: "Font resource unavailable" } }),
    {
      status,
      headers: {
        ...CORS,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...(status === 405 ? { Allow: "GET, HEAD, OPTIONS" } : {}),
      },
    },
  );
}

function outgoing(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const etag = headers.get("etag");
  const condition = request.headers.get("if-none-match");
  if (
    etag &&
    condition?.split(",").some((value) => value.trim() === "*" || value.trim().replace(/^W\//u, "") === etag)
  ) {
    headers.delete("Content-Length");
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status, headers });
  }
  return response;
}

export async function handleStampFontsRequest(
  request: Request,
  env: { readonly ASSETS?: Fetcher },
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ROOT.slice(0, -1) && !url.pathname.startsWith(ROOT)) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return failure(request, 405, "method_not_allowed");
  if (url.search) return failure(request, 400, "font_query_not_supported");
  const selected = route(url.pathname);
  if (!selected) return failure(request, 404, "font_not_found");
  const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });
  const hit = await caches.default.match(cacheKey);
  if (hit) return outgoing(request, hit);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    // The fixed versioned path is also the future static mirror's exact path.
    let response = env.ASSETS
      ? await env.ASSETS.fetch(new Request(url.origin + ROOT + selected.relative, { signal: controller.signal }))
      : undefined;
    if (!response || response.status === 404) {
      await response?.body?.cancel();
      response = await fetch(selected.source, {
        method: "GET",
        headers: { Accept: selected.css ? "text/css" : "font/*, application/octet-stream" },
        redirect: "manual",
        signal: controller.signal,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return failure(request, 502, "font_upstream_unavailable");
    }
    const raw = await bytes(response, selected.css ? MAX_CSS_BYTES : MAX_FONT_BYTES);
    const body = selected.css ? stylesheet(raw, selected) : raw;
    if (selected.css && body.length > MAX_CSS_BYTES) throw new Error("Rewritten font CSS exceeds budget");
    const type = selected.css ? "text/css; charset=utf-8" : fontType(body);
    const digest = await crypto.subtle.digest("SHA-256", body);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (selected.expectedHash && hash !== selected.expectedHash) throw new Error("Font body differs from pinned hash");
    const etag = `"${hash}"`;
    const result = new Response(body, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": type,
        "Content-Length": String(body.length),
        "Cache-Control": CACHE_CONTROL,
        ETag: etag,
        "X-Haneoka-Font-Source": selected.source,
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, result.clone()).catch(() => {}));
    return outgoing(request, result);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "stamp.font.error",
        source: selected.source,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return failure(request, 502, "font_response_invalid");
  } finally {
    clearTimeout(timer);
  }
}
