import { negotiateRequestLocale } from "../src/i18n/negotiation.ts";
import { parseScore, buildChart } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  renderStaticChartOverview,
  StaticChartOverviewError,
  STATIC_CHART_OVERVIEW_FONT_STACK,
  STATIC_CHART_OVERVIEW_RENDERER_VERSION,
  type ChartDocument,
  type StaticChartOverviewMeta,
  type StaticChartOverviewResult,
} from "@haneoka/cassiopeia";

export const CHART_IMAGE_ROUTE = "/api/v1/servers/{server}/songs/{songId}/charts/{difficulty}/image.{format}";
const SERVER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
const DIFFICULTIES = new Set(["easy", "normal", "hard", "expert", "special", "master"]);
const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
const MAX_RAW_CHART_BYTES = 2 * 1024 * 1024;
const MAX_JACKET_BYTES = 1024 * 1024;
const MAX_HEIGHT = 1_440;
const DEFAULT_HEIGHT = 720;
const CACHE_CONTROL = "public, max-age=300, must-revalidate";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Language, If-None-Match",
  "Access-Control-Expose-Headers":
    "Content-Disposition, Content-Length, X-Haneoka-Chart-Renderer, X-Haneoka-Release-Id, X-Haneoka-Server, X-Haneoka-Image-Width, X-Haneoka-Image-Height, ETag",
  "X-Content-Type-Options": "nosniff",
};

export interface ChartImageRelease {
  readonly server: string;
  readonly releaseId: string;
}

export type ChartImageSong = Record<string, unknown>;

export interface ChartImageSources {
  /** The API entrypoint wires this to the existing current-release R2 helper. */
  /** Return false for an unregistered resource server; aliases resolve at the entrypoint. */
  readonly hasServer: (server: string) => Promise<boolean>;
  readonly currentRelease: (server: string) => Promise<ChartImageRelease | null>;
  /** The API entrypoint wires this to the existing latest-release catalog entity helper. */
  readonly readSong: (release: ChartImageRelease, songId: string) => Promise<ChartImageSong | null>;
  /** The API entrypoint wires this to the existing release-index/CAS R2 byte helper. */
  readonly readReleaseBytes: (
    release: ChartImageRelease,
    releasePath: string,
    maxBytes: number,
  ) => Promise<Uint8Array | null>;
  /** Optional officially-supported SVG-to-PNG capability, injected at root. */
  readonly rasterizeSvg?: (svg: string, width: number, height: number) => Promise<Uint8Array>;
}

export interface ChartImageRequestOptions {
  readonly sources: ChartImageSources;
  readonly request: Request;
}

class ChartImageRequestError extends Error {
  readonly status: 400 | 404 | 405 | 406 | 413 | 501 | 502 | 503;
  readonly code: string;

  constructor(status: 400 | 404 | 405 | 406 | 413 | 501 | 502 | 503, code: string, message: string) {
    super(message);
    this.name = "ChartImageRequestError";
    this.status = status;
    this.code = code;
  }
}

function jsonError(request: Request, error: ChartImageRequestError): Response {
  return new Response(
    request.method === "HEAD" ? null : JSON.stringify({ error: { code: error.code, message: error.message } }),
    {
      status: error.status,
      headers: {
        ...CORS_HEADERS,
        ...(error.status === 405 ? { Allow: "GET, HEAD, OPTIONS" } : {}),
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

function decodePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") && !decoded.includes("\0") ? decoded : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function localized(value: unknown, locale: (typeof LOCALES)[number], fallback = ""): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (!Array.isArray(value)) return fallback;
  const index = LOCALES.indexOf(locale);
  const selected = typeof value[index] === "string" ? value[index].trim() : "";
  if (selected) return selected;
  return (
    value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)?.trim() || fallback
  );
}

function localeFor(request: Request): (typeof LOCALES)[number] {
  const requested = new URL(request.url).searchParams.get("locale");
  if (requested && (LOCALES as readonly string[]).includes(requested)) return requested as (typeof LOCALES)[number];
  return negotiateRequestLocale("", request.headers.get("accept-language") || "");
}

function integerQuery(request: Request, name: string, fallback: number): number {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d{1,4}$/u.test(value)) throw new ChartImageRequestError(400, "invalid_height", "height must be an integer");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 360 || result > MAX_HEIGHT) {
    throw new ChartImageRequestError(400, "invalid_height", "height must be between 360 and 1440 pixels");
  }
  return result;
}

function songDifficulty(song: ChartImageSong, difficulty: string): Record<string, unknown> {
  const values = Array.isArray(song.difficulty) ? song.difficulty : [];
  const result = values.map(record).find((value) => value?.difficultyName === difficulty);
  if (!result) throw new ChartImageRequestError(404, "difficulty_not_found", "Chart difficulty not found");
  return result;
}

function assetReleasePath(server: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(`/assets/${server}/`)) return null;
  let path: string;
  try {
    path = decodeURIComponent(value.slice(`/assets/${server}/`.length));
  } catch {
    return null;
  }
  if (!path || /[\\\x00-\x1f?#]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    return null;
  return `assets/${path}`;
}

function chartReleasePath(server: string, difficulty: Record<string, unknown>): string {
  const path = assetReleasePath(server, difficulty.file);
  if (!path) throw new ChartImageRequestError(502, "chart_path_invalid", "Latest catalog chart path is invalid");
  return path;
}

async function jacketDataHref(
  sources: ChartImageSources,
  release: ChartImageRelease,
  value: unknown,
): Promise<string | undefined> {
  const path = assetReleasePath(release.server, value);
  if (!path) return undefined;
  const bytes = await sources.readReleaseBytes(release, path, MAX_JACKET_BYTES);
  if (!bytes?.length || bytes.length > MAX_JACKET_BYTES) return undefined;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) return undefined;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:image/${png ? "png" : "jpeg"};base64,${btoa(binary)}`;
}

function parseChart(bytes: Uint8Array): ChartDocument {
  if (!bytes.length) throw new ChartImageRequestError(502, "chart_invalid", "Latest release chart is empty");
  if (bytes.length > MAX_RAW_CHART_BYTES) {
    throw new ChartImageRequestError(413, "chart_too_large", "Raw chart exceeds the 2 MiB render input budget");
  }
  try {
    const chart = buildChart(parseScore(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
    if (!chart.notes.length || !chart.bpmChanges.length) throw new TypeError("Empty chart");
    return chart;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ChartImageRequestError(413, "chart_render_budget", error.message);
    }
    throw new ChartImageRequestError(502, "chart_invalid", "Latest release chart could not be parsed");
  }
}

function metaFor(
  song: ChartImageSong,
  difficulty: Record<string, unknown>,
  server: string,
  locale: (typeof LOCALES)[number],
  songId: string,
): StaticChartOverviewMeta {
  const title = localized(song.musicTitle, locale, songId);
  const band = localized(song.bandName, locale, typeof song.bandId === "number" ? `Band ${song.bandId}` : "Band");
  const displayLevel =
    typeof difficulty.displayLevel === "number" || typeof difficulty.displayLevel === "string"
      ? difficulty.displayLevel
      : typeof difficulty.playLevel === "number"
        ? difficulty.playLevel
        : "—";
  const meta = {
    title,
    bandName: band,
    songId,
    difficultyName: String(difficulty.difficultyName || "chart"),
    displayLevel,
    ...(typeof song.attribute === "string" ? { attribute: song.attribute } : {}),
    server,
    locale,
  };
  return meta;
}

function parseRoute(
  request: Request,
): { server: string; songId: string; difficulty: string; format: "svg" | "png" } | null {
  const pathname = new URL(request.url).pathname;
  const match = /^\/api\/v1\/servers\/([^/]+)\/songs\/([^/]+)\/charts\/([^/]+)\/image\.([a-z0-9]+)$/u.exec(pathname);
  if (!match) return null;
  const server = decodePart(match[1] || "");
  const songId = decodePart(match[2] || "");
  const difficulty = decodePart(match[3] || "");
  const format = match[4];
  if (format !== "svg" && format !== "png")
    throw new ChartImageRequestError(406, "format_not_supported", "Chart image format must be svg or png");
  if (!server || !SERVER_PATTERN.test(server))
    throw new ChartImageRequestError(404, "server_not_found", "Server not found");
  if (!songId || !SONG_ID_PATTERN.test(songId))
    throw new ChartImageRequestError(404, "song_not_found", "Song not found");
  if (!difficulty || !DIFFICULTIES.has(difficulty))
    throw new ChartImageRequestError(404, "difficulty_not_found", "Chart difficulty not found");
  return { server, songId, difficulty, format };
}

async function imageResponse(
  request: Request,
  format: "svg" | "png",
  body: Uint8Array | string,
  release: ChartImageRelease,
  songId: string,
  difficulty: string,
  locale: string,
  width: number,
  height: number,
): Promise<Response> {
  const contentType = format === "svg" ? "image/svg+xml; charset=utf-8" : "image/png";
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  // Hash both representation bytes and identity: equal content in two regions
  // still belongs to distinct current releases.
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  const etag = `"${release.server}:${release.releaseId}:${songId}:${locale}:${difficulty}:${STATIC_CHART_OVERVIEW_RENDERER_VERSION}:${hash}"`;
  const download = new URL(request.url).searchParams.get("download") !== "0";
  const filename = `Haneoka-${release.server}-${songId}-${difficulty}-${locale}.${format}`;
  const headers = new Headers({
    ...CORS_HEADERS,
    "Cache-Control": CACHE_CONTROL,
    Vary: "Accept-Language",
    "Content-Type": contentType,
    "Content-Language": locale,
    "Content-Length": String(payload.byteLength),
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
    ETag: etag,
    "X-Haneoka-Chart-Renderer": STATIC_CHART_OVERVIEW_RENDERER_VERSION,
    "X-Haneoka-Release-Id": release.releaseId,
    "X-Haneoka-Server": release.server,
    "X-Haneoka-Image-Width": String(width),
    "X-Haneoka-Image-Height": String(height),
  });
  const condition = request.headers.get("if-none-match");
  if (condition?.split(",").some((value) => value.trim() === "*" || value.trim().replace(/^W\//u, "") === etag)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : payload, { status: 200, headers });
}

function validatePng(bytes: Uint8Array, width: number, height: number): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || bytes.length > 8 * 1024 * 1024 || signature.some((value, index) => bytes[index] !== value)) {
    throw new ChartImageRequestError(502, "png_invalid", "PNG rasterizer returned an invalid image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  ) {
    throw new ChartImageRequestError(502, "png_invalid", "PNG rasterizer returned incorrect dimensions");
  }
}

/** The API entrypoint provides current-release catalog/CAS readers and a PNG rasterizer. */
export async function handleChartImageRequest({
  request,
  sources,
}: ChartImageRequestOptions): Promise<Response | null> {
  try {
    const route = parseRoute(request);
    if (!route) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new ChartImageRequestError(405, "method_not_allowed", "Chart images support GET, HEAD, and OPTIONS");
    const url = new URL(request.url);
    for (const name of ["locale", "height", "download", "server"]) {
      if (url.searchParams.getAll(name).length > 1)
        throw new ChartImageRequestError(400, `invalid_${name}`, `${name} must occur once`);
    }
    if (url.searchParams.has("server") && url.searchParams.get("server") !== route.server)
      throw new ChartImageRequestError(400, "invalid_server", "server must match the scoped route");
    if (url.searchParams.has("release"))
      throw new ChartImageRequestError(400, "release_not_supported", "Chart images use the current release");
    if (url.searchParams.has("download") && !["0", "1"].includes(url.searchParams.get("download") || ""))
      throw new ChartImageRequestError(400, "invalid_download", "download must be 0 or 1");
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > 0) {
      throw new ChartImageRequestError(400, "body_not_allowed", "Chart image requests do not accept a request body");
    }
    if (
      url.searchParams.has("locale") &&
      !(LOCALES as readonly string[]).includes(url.searchParams.get("locale") || "")
    ) {
      throw new ChartImageRequestError(400, "invalid_locale", "locale must be ja, en, zh-TW, zh-CN, or ko");
    }
    const height = integerQuery(request, "height", DEFAULT_HEIGHT);
    if (!(await sources.hasServer(route.server)))
      throw new ChartImageRequestError(404, "server_not_found", "Server not found");
    const release = await sources.currentRelease(route.server);
    if (!release) throw new ChartImageRequestError(503, "release_unavailable", "No latest release is published");
    if (
      release.server !== route.server ||
      !SERVER_PATTERN.test(release.server) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(release.releaseId)
    )
      throw new ChartImageRequestError(502, "release_invalid", "Latest release identity is invalid");
    const song = await sources.readSong(release, route.songId);
    if (!song) throw new ChartImageRequestError(404, "song_not_found", "Song not found");
    const difficulty = songDifficulty(song, route.difficulty);
    const chartPath = chartReleasePath(release.server, difficulty);
    const bytes = await sources.readReleaseBytes(release, chartPath, MAX_RAW_CHART_BYTES);
    if (!bytes) throw new ChartImageRequestError(404, "chart_not_found", "Chart data not found");
    const chart = parseChart(bytes);
    const locale = localeFor(request);
    const baseMeta = metaFor(song, difficulty, release.server, locale, route.songId);
    const jacketHref = await jacketDataHref(sources, release, song.jacketUrl);
    const meta = { ...baseMeta, ...(jacketHref ? { jacketHref } : {}) };
    const rendered: StaticChartOverviewResult = renderStaticChartOverview(chart, meta, {
      height,
      maxPanels: 256,
      maxPixels: 12_000_000,
      maxSvgBytes: 8 * 1024 * 1024,
    });
    if (route.format === "svg")
      return imageResponse(
        request,
        route.format,
        rendered.svg,
        release,
        route.songId,
        route.difficulty,
        locale,
        rendered.width,
        rendered.height,
      );
    if (!sources.rasterizeSvg) {
      throw new ChartImageRequestError(
        501,
        "png_renderer_unavailable",
        "PNG output requires a Worker-supported SVG rasterizer",
      );
    }
    const png = await sources.rasterizeSvg(rendered.svg, rendered.width, rendered.height);
    validatePng(png, rendered.width, rendered.height);
    return imageResponse(
      request,
      route.format,
      png,
      release,
      route.songId,
      route.difficulty,
      locale,
      rendered.width,
      rendered.height,
    );
  } catch (error) {
    if (error instanceof ChartImageRequestError) return jsonError(request, error);
    if (error instanceof RangeError)
      return jsonError(
        request,
        new ChartImageRequestError(413, "chart_render_budget", "Chart image exceeds the render input budget"),
      );
    if (error instanceof StaticChartOverviewError)
      return jsonError(
        request,
        new ChartImageRequestError(error.code === "invalid_height" ? 400 : 413, error.code, error.message),
      );
    console.error(
      JSON.stringify({
        event: "chart_image_render_failed",
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonError(request, new ChartImageRequestError(502, "chart_image_failed", "Chart image rendering failed"));
  }
}

export { STATIC_CHART_OVERVIEW_FONT_STACK };
