import { fetchCurrentTeamBuilderIdentity } from "../team-builder/data/fetch";
import { loadCrossServerCatalog } from "./load";
import { loadCrossServerCatalogs } from "./bundle";
import type { CrossCatalogReader } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";

/** Browser adapter: current identities are refreshed per load, with no retained/build fallback. */
function reader(options: { signal?: AbortSignal; fetcher?: typeof fetch }): CrossCatalogReader {
  const fetcher = options.fetcher ?? fetch;
  return {
      async readIdentity(server) {
        const identity = await fetchCurrentTeamBuilderIdentity(server, options.signal, fetcher);
        return { ...identity, server };
      },
      async readCollection(name, identity) {
        options.signal?.throwIfAborted();
        const response = await fetcher(`/api/v1/servers/${identity.server}/${name}?release=${encodeURIComponent(identity.releaseId)}`, {
          signal: options.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(`Cross-server collection unavailable:${identity.server}/${name}/${response.status}`);
        if (response.headers.get("x-haneoka-release-id") !== identity.releaseId || response.headers.get("x-haneoka-source-id") !== identity.sourceId)
          throw new Error("Cross-server collection release mismatch");
        const value: unknown = await response.json();
        options.signal?.throwIfAborted();
        return value;
      },
      async readEntity(name, identity, id) {
        options.signal?.throwIfAborted();
        const response = await fetcher(`/api/v1/servers/${identity.server}/${name}/${encodeURIComponent(id)}?release=${encodeURIComponent(identity.releaseId)}`, {
          signal: options.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(`Cross-server entity unavailable:${identity.server}/${name}/${id}/${response.status}`);
        if (response.headers.get("x-haneoka-release-id") !== identity.releaseId || response.headers.get("x-haneoka-source-id") !== identity.sourceId)
          throw new Error("Cross-server entity release mismatch");
        const value: unknown = await response.json(); options.signal?.throwIfAborted(); return value;
      },
  };
}
export function fetchCrossServerCatalog(
  resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
) {
  return loadCrossServerCatalog(resource, { selectedServer, locale, reader: reader(options) });
}
export function fetchCrossServerCatalogs(
  resources: readonly CrossCatalogResource[], selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
) {
  return loadCrossServerCatalogs(resources, { selectedServer, locale, reader: reader(options) });
}
