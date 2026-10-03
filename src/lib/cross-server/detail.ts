import { crossServerPublicCache } from "./cache";
import {
  crossServerDetail, type CrossCatalogEntry, type CrossCatalogIdentity, type CrossCatalogResource,
  type CrossCatalogRow, type OfficialCatalogServer,
} from "./catalog";

export interface CrossDetailReader {
  readEntity(resource: CrossCatalogResource, identity: CrossCatalogIdentity, id: string): Promise<unknown>;
}
const object = (value: unknown): value is CrossCatalogRow => !!value && typeof value === "object" && !Array.isArray(value);
/** Collection summaries are projections of the same immutable entity, not a different edition. */
function projectionMatches(summary: unknown, full: unknown): boolean {
  if (summary === full) return true;
  if (Array.isArray(summary))
    return Array.isArray(full) && summary.length === full.length && summary.every((value, i) => projectionMatches(value, full[i]));
  if (!object(summary) || !object(full)) return false;
  return Object.entries(summary).every(([key, value]) => Object.hasOwn(full, key) && projectionMatches(value, full[key]));
}

/** Enrich a previously associated entry from each recorded source once.
 * Neither a removed release nor a foreign response may fall back to current.
 */
export async function loadCrossServerDetail(
  original: CrossCatalogEntry, activeServer: OfficialCatalogServer,
  reader: CrossDetailReader,
) {
  if (!original.perServer[activeServer]) throw new Error("Requested detail variant is unavailable");
  const entry = structuredClone(original);
  const failures: { server: OfficialCatalogServer; message: string }[] = [];
  const fullSources: OfficialCatalogServer[] = [];
  await Promise.all(Object.entries(entry.perServer).map(async ([key, variant]) => {
    const server = key as OfficialCatalogServer;
    if (!variant) return;
    try {
      const value = await reader.readEntity(entry.resource, { ...variant.identity }, variant.id);
      if (!object(value)) throw new Error("Cross-server entity must be an object");
      if (!projectionMatches(variant.row, value)) throw new Error("Cross-server entity disagrees with its pinned collection projection");
      variant.row = structuredClone(value);
      const images = value.images;
      if (images !== undefined) variant.assets.images = structuredClone(images);
      fullSources.push(server);
    } catch (error) {
      failures.push({ server, message: error instanceof Error ? error.message : String(error) });
    }
  }));
  return { ...crossServerDetail(entry, activeServer), fullSources, failures };
}

/** Browser detail adapter; the collection entry supplies exact per-server release identities. */
export function fetchCrossServerDetail(
  entry: CrossCatalogEntry, activeServer = entry.displayServer,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
) {
  const cache = crossServerPublicCache(options.fetcher);
  return loadCrossServerDetail(entry, activeServer, {
    readEntity: (resource, identity, id) => cache.readEntity(resource, identity, id, options.signal),
  }).then((detail) => { options.signal?.throwIfAborted(); return detail; });
}
