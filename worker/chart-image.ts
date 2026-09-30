import { parseScore, buildChart } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  renderStaticChartOverview,
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
const MAX_HEIGHT = 1_440;
const DEFAULT_HEIGHT = 720;
const CACHE_CONTROL = "public, max-age=300, must-revalidate";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Expose-Headers":
    "Content-Disposition, Content-Length, X-Haneoka-Chart-Renderer, X-Haneoka-Release-Id",
  "X-Content-Type-Options": "nosniff",
};

export interface ChartImageRelease {
  readonly server: string;
  readonly releaseId: string;
}

export type ChartImageSong = Record<string, unknown>;

export interface ChartImageSources {
  /** Root wires this to the existing current-release R2 helper. */
  readonly currentRelease: (server: string) => Promise<ChartImageRelease | null>;
  /** Root wires this to the existing latest-release catalog entity helper. */
  readonly readSong: (release: ChartImageRelease, songId: string) => Promise<ChartImageSong | null>;
  /** Root wires this to the existing release-index/CAS R2 byte helper. */
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
  readonly status: 400 | 404 | 406 | 413 | 501 | 502 | 503;
  readonly code: string;

  constructor(status: 400 | 404 | 406 | 413 | 501 | 502 | 503, code: string, message: string) {
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
  const accept = request.headers.get("accept-language") || "";
  if (/\bja\b/iu.test(accept)) return "ja";
  if (/\bko\b/iu.test(accept)) return "ko";
  if (/zh[-_]tw|zh[-_]hk|zh[-_]hant/iu.test(accept)) return "zh-TW";
  if (/\bzh\b/iu.test(accept)) return "zh-CN";
  return "en";
}

function integerQuery(request: Request, name: string, fallback: number): number {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null || value === "") return fallback;
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

function chartReleasePath(server: string, difficulty: Record<string, unknown>): string {
  const file = typeof difficulty.file === "string" ? difficulty.file : "";
  const match = new RegExp(`^/assets/${server}/(.+)$`, "u").exec(file);
  if (!match?.[1] || match[1].includes("..") || match[1].includes("\\")) {
    throw new ChartImageRequestError(502, "chart_path_invalid", "Latest catalog chart path is invalid");
  }
  return `assets/${match[1]}`;
}

function validAssetHref(server: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return new RegExp(`^/assets/${server}/[^\\?#]+$`, "u").test(value) ? value : undefined;
}

function parseChart(bytes: Uint8Array): ChartDocument {
  if (!bytes.length || bytes.length > MAX_RAW_CHART_BYTES) {
    throw new ChartImageRequestError(413, "chart_too_large", "Raw chart exceeds the 2 MiB render input budget");
  }
  try {
    return buildChart(parseScore(new TextDecoder().decode(bytes)));
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
  return {
    title,
    bandName: band,
    songId,
    difficultyName: String(difficulty.difficultyName || "chart"),
    displayLevel,
    ...(typeof song.attribute === "string" ? { attribute: song.attribute } : {}),
    ...(validAssetHref(server, song.jacketUrl) ? { jacketHref: song.jacketUrl as string } : {}),
    locale,
  };
}

function parseRoute(
  request: Request,
): { server: string; songId: string; difficulty: string; format: "svg" | "png" } | null {
  const pathname = new URL(request.url).pathname;
  const match = /^\/api\/v1\/servers\/([^/]+)\/songs\/([^/]+)\/charts\/([^/]+)\/image\.(svg|png)$/u.exec(pathname);
  if (!match) return null;
  const server = decodePart(match[1] || "");
  const songId = decodePart(match[2] || "");
  const difficulty = decodePart(match[3] || "");
  const format = match[4] as "svg" | "png";
  if (!server || !SERVER_PATTERN.test(server))
    throw new ChartImageRequestError(404, "server_not_found", "Server not found");
  if (!songId || !SONG_ID_PATTERN.test(songId))
    throw new ChartImageRequestError(404, "song_not_found", "Song not found");
  if (!difficulty || !DIFFICULTIES.has(difficulty))
    throw new ChartImageRequestError(404, "difficulty_not_found", "Chart difficulty not found");
  return { server, songId, difficulty, format };
}

function imageResponse(
  request: Request,
  format: "svg" | "png",
  body: Uint8Array | string,
  releaseId: string,
): Response {
  const contentType = format === "svg" ? "image/svg+xml; charset=utf-8" : "image/png";
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers = new Headers({
    ...CORS_HEADERS,
    "Cache-Control": CACHE_CONTROL,
    "Content-Type": contentType,
    "Content-Length": String(payload.byteLength),
    "Content-Disposition": `inline; filename="chart-${releaseId}.${format}"`,
    "X-Haneoka-Chart-Renderer": STATIC_CHART_OVERVIEW_RENDERER_VERSION,
    "X-Haneoka-Release-Id": releaseId,
  });
  return new Response(request.method === "HEAD" ? null : payload, { status: 200, headers });
}

/**
 * Unregistered route handler. `worker/index.ts` can wire currentRelease,
 * catalog lookup, and release-byte reads to its existing R2 helpers later.
 */
export async function handleChartImageRequest({
  request,
  sources,
}: ChartImageRequestOptions): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  try {
    const route = parseRoute(request);
    if (!route) return null;
    const url = new URL(request.url);
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > 0) {
      throw new ChartImageRequestError(400, "body_not_allowed", "Chart image requests do not accept a request body");
    }
    if (
      url.searchParams.get("locale") &&
      !(LOCALES as readonly string[]).includes(url.searchParams.get("locale") || "")
    ) {
      throw new ChartImageRequestError(400, "invalid_locale", "locale must be ja, en, zh-TW, zh-CN, or ko");
    }
    const height = integerQuery(request, "height", DEFAULT_HEIGHT);
    const release = await sources.currentRelease(route.server);
    if (!release) throw new ChartImageRequestError(503, "release_unavailable", "No latest release is published");
    const song = await sources.readSong(release, route.songId);
    if (!song) throw new ChartImageRequestError(404, "song_not_found", "Song not found");
    const difficulty = songDifficulty(song, route.difficulty);
    const chartPath = chartReleasePath(route.server, difficulty);
    const bytes = await sources.readReleaseBytes(release, chartPath, MAX_RAW_CHART_BYTES);
    if (!bytes) throw new ChartImageRequestError(404, "chart_not_found", "Chart data not found");
    const chart = parseChart(bytes);
    const meta = metaFor(song, difficulty, route.server, localeFor(request), route.songId);
    const rendered: StaticChartOverviewResult = renderStaticChartOverview(chart, meta, {
      height,
      maxPanels: 256,
      maxPixels: 12_000_000,
      maxSvgBytes: 8 * 1024 * 1024,
    });
    if (route.format === "svg") return imageResponse(request, route.format, rendered.svg, release.releaseId);
    if (!sources.rasterizeSvg) {
      throw new ChartImageRequestError(
        501,
        "png_renderer_unavailable",
        "PNG output requires a Worker-supported SVG rasterizer",
      );
    }
    const png = await sources.rasterizeSvg(rendered.svg, rendered.width, rendered.height);
    if (!png.length || png.byteLength > 8 * 1024 * 1024) {
      throw new ChartImageRequestError(502, "png_invalid", "PNG rasterizer returned an invalid image");
    }
    return imageResponse(request, route.format, png, release.releaseId);
  } catch (error) {
    if (error instanceof ChartImageRequestError) return jsonError(request, error);
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
