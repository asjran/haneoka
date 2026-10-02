import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../data";
import { hydrateRuntimeDocuments } from "./complete";

/** Public catalog projections only; every request uses the one observed release. */
export async function fetchTeamBuilderData(
  server: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TeamBuilderData> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server)) throw new TypeError("Invalid resource server");
  const prefix = `/api/v1/servers/${encodeURIComponent(server)}/`;
  signal?.throwIfAborted();
  const compact = await fetcher(`/api/v1/team-builder/${encodeURIComponent(server)}`, { cache: "no-store", signal });
  if (compact.ok) {
    const data = (await compact.json()) as TeamBuilderData;
    if (
      data.schema !== "haneoka-team-builder-data-v1" ||
      data.identity?.server !== server ||
      data.identity.releaseId !== compact.headers.get("x-haneoka-release-id") ||
      data.identity.sourceId !== compact.headers.get("x-haneoka-source-id")
    )
      throw new Error("Team data DTO identity mismatch");
    signal?.throwIfAborted();
    return data;
  }
  if (compact.status !== 404) throw new Error(`Team data DTO unavailable: ${compact.status}`);
  const pin = await fetcher(`${prefix}release?projection=identity`, { method: "HEAD", cache: "no-store", signal });
  if (!pin.ok) throw new Error(`Team data release unavailable: ${pin.status}`);
  const releaseId = pin.headers.get("x-haneoka-release-id") || "";
  const sourceId = pin.headers.get("x-haneoka-source-id") || "";
  if (!/^r-[a-f0-9]{20}$/u.test(releaseId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sourceId))
    throw new Error("Invalid team data release identity");
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
  for (let start = 0; start < resources.length; start += 4) {
    signal?.throwIfAborted();
    const values = await Promise.all(
      resources.slice(start, start + 4).map(async (resource) => {
        const response = await fetcher(`${prefix}${resource}?release=${encodeURIComponent(releaseId)}`, {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Team data collection unavailable: ${resource}/${response.status}`);
        if (
          response.headers.get("x-haneoka-release-id") !== releaseId ||
          response.headers.get("x-haneoka-source-id") !== sourceId
        )
          throw new Error("Team data release mismatch");
        const document: unknown = await response.json();
        signal?.throwIfAborted();
        return [resource, document] as const;
      }),
    );
    for (const [resource, document] of values) documents[resource] = document;
  }
  const events = { ...objectRow(documents.events) },
    ids = Object.keys(objectRow(objectRow(documents.events).entries));
  const entries = { ...objectRow(events.entries) };
  for (let start = 0; start < ids.length; start += 4) {
    const details = await Promise.all(
      ids.slice(start, start + 4).map(async (id) => {
        const response = await fetcher(
          `${prefix}events/${encodeURIComponent(id)}?release=${encodeURIComponent(releaseId)}`,
          { signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error(`Team event detail unavailable:${id}/${response.status}`);
        if (
          response.headers.get("x-haneoka-release-id") !== releaseId ||
          response.headers.get("x-haneoka-source-id") !== sourceId
        )
          throw new Error("Team event detail release mismatch");
        const detail = await response.json();
        signal?.throwIfAborted();
        return [id, { ...objectRow(entries[id]), ...objectRow(detail) }] as const;
      }),
    );
    for (const [id, detail] of details) entries[id] = detail;
  }
  documents.events = { ...events, entries };
  const complete = await hydrateRuntimeDocuments(
    documents,
    async (resource, id) => {
      const response = await fetcher(
        `${prefix}${resource}/${encodeURIComponent(id)}?release=${encodeURIComponent(releaseId)}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Runtime entity unavailable:${resource}/${id}/${response.status}`);
      if (
        response.headers.get("x-haneoka-release-id") !== releaseId ||
        response.headers.get("x-haneoka-source-id") !== sourceId
      )
        throw new Error("Runtime entity release mismatch");
      return response.json();
    },
    signal,
  );
  return adaptTeamBuilderData({ server, releaseId, sourceId }, complete);
}
