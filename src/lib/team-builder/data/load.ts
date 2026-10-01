import { fetchStaticCatalog, fetchStaticCatalogBatch, staticCatalogRelease } from "../../static-catalog-source";
import type { ReleaseServer } from "../../release-server";
import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../data";

/** Build-time only. Browser UI receives the compact page payload rather than Master. */
export async function loadTeamBuilderData(server: ReleaseServer, signal?: AbortSignal): Promise<TeamBuilderData> {
  signal?.throwIfAborted();
  const identity = await staticCatalogRelease(server);
  const resources = [
    "cards",
    "support-cards",
    "characters",
    "bands",
    "band-items",
    "songs",
    "events",
    "progression",
    "leader-skills",
    "skills",
    "gekisou-skills",
    "support-skills",
    "gekisou-support-skills",
    "skill-reference",
    "live-tools",
    "gekisou",
  ];
  const documents: Record<string, unknown> = {};
  // Bounded request batches; every response is verified against the one pin.
  for (let start = 0; start < resources.length; start += 4) {
    signal?.throwIfAborted();
    const values = await Promise.all(
      resources
        .slice(start, start + 4)
        .map(async (resource) => [resource, await fetchStaticCatalog(resource, server, identity)] as const),
    );
    signal?.throwIfAborted();
    for (const [resource, value] of values) documents[resource] = value;
  }
  const events = { ...objectRow(documents.events) };
  const ids = Object.keys(objectRow(events.entries));
  if (ids.length) {
    const details = await fetchStaticCatalogBatch("events", ids, server, identity);
    events.entries = Object.fromEntries(
      ids.map((id) => [id, { ...objectRow(objectRow(events.entries)[id]), ...details.get(id) }]),
    );
  }
  documents.events = events;
  signal?.throwIfAborted();
  return adaptTeamBuilderData(identity, documents);
}
