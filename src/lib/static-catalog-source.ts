/**
 * Build-time access to the release catalog API.
 *
 * A build first pins one immutable release per server through the release
 * endpoint. Every later request carries that release id, including batches,
 * so a current-pointer flip cannot mix documents from two releases.
 *
 * STATIC_CATALOG_ORIGIN points the fetches at another host (a workers.dev
 * mirror or an origin hostname outside edge mitigation); STATIC_CATALOG_TOKEN
 * is sent as `x-haneoka-build-token` for an edge rule that lets builds pass.
 */
const ORIGIN = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/, "");
const TOKEN = process.env.STATIC_CATALOG_TOKEN || "";
const BUST = `static-catalog-${Date.now()}`;
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);
const RELEASE_ID_PATTERN = /^r-[a-f0-9]{20}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_TIMEOUT_MS = 30_000;

const headers = (): HeadersInit => ({
  accept: "application/json",
  ...(TOKEN ? { "x-haneoka-build-token": TOKEN } : {}),
});

export type RecordValue = Record<string, unknown>;

export interface StaticCatalogRelease {
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
}

export interface OptionalStaticCatalogResult {
  readonly value: unknown | null;
  readonly reason?: string;
}

class StaticCatalogConsistencyError extends Error {}
class StaticCatalogHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    server: string,
  ) {
    super(`Static catalog request failed for ${server}/${path.split("?")[0]} (${status})`);
  }
}

const releasePromises = new Map<string, Promise<StaticCatalogRelease>>();
const requestPromises = new Map<string, Promise<unknown>>();

export function staticCatalogUrl(path: string, server = "intl", releaseId?: string): string {
  const url = new URL(`/api/v1/servers/${encodeURIComponent(server)}/${path.replace(/^\/+/, "")}`, ORIGIN);
  if (releaseId) url.searchParams.set("release", releaseId);
  else url.searchParams.set("__static_catalog_build", BUST);
  return url.toString();
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchResponse(path: string, server: string, releaseId?: string, method = "GET"): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(staticCatalogUrl(path, server, releaseId), {
        headers: headers(),
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt > 0) {
        throw new Error(`Static catalog request failed for ${server}/${path.split("?")[0]}`, { cause: error });
      }
      await wait(1500);
      continue;
    }
    if (response.ok) return response;
    if (response.status === 404 && response.headers.get("content-type")?.includes("application/json")) {
      const body = asRecord(await response.json());
      const error = asRecord(body?.error);
      if (typeof error?.code === "string" && error.code.startsWith("release_identity_")) {
        throw new StaticCatalogConsistencyError(
          `Static catalog release identity failed for ${server}/${path.split("?")[0]}: ${error.code}`,
        );
      }
    }
    if (!response.bodyUsed) await response.body?.cancel();
    if (attempt === 0 && RETRYABLE.has(response.status)) {
      await wait(1500);
      continue;
    }
    throw new StaticCatalogHttpError(response.status, path, server);
  }
  throw new Error(`Static catalog request exhausted retries for ${server}/${path.split("?")[0]}`);
}

function observedRelease(response: Response, expected?: StaticCatalogRelease): void {
  if (!expected) return;
  const releaseId = response.headers.get("x-haneoka-release-id");
  const sourceId = response.headers.get("x-haneoka-source-id");
  if (releaseId !== expected.releaseId) {
    throw new StaticCatalogConsistencyError(
      `Static catalog release mismatch: expected ${expected.releaseId}, received ${releaseId}`,
    );
  }
  if (sourceId !== expected.sourceId) {
    throw new StaticCatalogConsistencyError(
      `Static catalog source mismatch: expected ${expected.sourceId}, received ${sourceId}`,
    );
  }
}

async function fetchJson(path: string, server: string, release?: StaticCatalogRelease): Promise<unknown> {
  const key = `${server}\u0000${release?.releaseId || "current"}\u0000${path}`;
  let pending = requestPromises.get(key);
  if (!pending) {
    pending = fetchResponse(path, server, release?.releaseId).then(async (response) => {
      try {
        observedRelease(response, release);
        return await response.json();
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    });
    requestPromises.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    requestPromises.delete(key);
    throw error;
  }
}

/** Pins the current release once. All static loaders share this promise. */
export async function staticCatalogRelease(server = "intl"): Promise<StaticCatalogRelease> {
  const existing = releasePromises.get(server);
  if (existing) return existing;
  const promise = (async () => {
    const response = await fetchResponse("release?projection=identity", server, undefined, "HEAD");
    const releaseId = response.headers.get("x-haneoka-release-id") || "";
    const sourceId = response.headers.get("x-haneoka-source-id") || "";
    if (!RELEASE_ID_PATTERN.test(releaseId) || !SOURCE_ID_PATTERN.test(sourceId)) {
      throw new Error(`Static catalog returned an invalid release identity for ${server}`);
    }
    return Object.freeze({ server, releaseId, sourceId });
  })();
  releasePromises.set(server, promise);
  try {
    return await promise;
  } catch (error) {
    releasePromises.delete(server);
    throw error;
  }
}

/** Fetches a required API path from the pinned release. Failures abort the build. */
export async function fetchStaticCatalog(
  path: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<unknown> {
  const pinned = release || (await staticCatalogRelease(server));
  return fetchJson(path, server, pinned);
}

/** Fetches an explicitly optional collection and records why it was absent. */
export async function fetchOptionalStaticCatalog(
  path: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<OptionalStaticCatalogResult> {
  try {
    return { value: await fetchStaticCatalog(path, server, release) };
  } catch (error) {
    if (!(error instanceof StaticCatalogHttpError) || error.status !== 404) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Static catalog: optional ${server}/${path.split("?")[0]} absent (${reason})`);
    return { value: null, reason };
  }
}

/**
 * Fetches entities by id through the release-pinned batch endpoint. A failed
 * chunk is a required build failure; it cannot silently remove SEO pages.
 */
export async function fetchStaticCatalogBatch(
  resource: string,
  ids: readonly string[],
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<Map<string, Record<string, unknown>>> {
  const items = new Map<string, Record<string, unknown>>();
  if (!ids.length) return items;
  const size = 80;
  for (let start = 0; start < ids.length; start += size) {
    const query = ids
      .slice(start, start + size)
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join("&");
    const document = asRecord(await fetchStaticCatalog(`${resource}?${query}`, server, release));
    if (!document || !asRecord(document.items)) {
      throw new Error(`Static catalog returned an invalid ${resource} batch response`);
    }
    for (const [id, value] of Object.entries(asRecord(document.items) || {})) {
      const record = asRecord(value);
      if (record) items.set(id, record);
    }
    const missing = ids.slice(start, start + size).filter((id) => !items.has(id));
    if (missing.length)
      throw new StaticCatalogConsistencyError(`Static catalog ${resource} batch omitted: ${missing.join(", ")}`);
  }
  return items;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
