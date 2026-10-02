import { fetchCurrentTeamBuilderIdentity } from "../team-builder/data/fetch";
import { loadCrossServerCatalog } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";

/** Browser adapter: current identities are refreshed per load, with no retained/build fallback. */
export function fetchCrossServerCatalog(
  resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  return loadCrossServerCatalog(resource, {
    selectedServer, locale,
    reader: {
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
    },
  });
}
