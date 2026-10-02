import { staticCatalogRelease, fetchStaticCatalog } from "../static-catalog-source";
import { loadCrossServerCatalog } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";

/** Build adapter reuses the configured current-release pin and existing collection cache. */
export function loadStaticCrossServerCatalog(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string) {
  return loadCrossServerCatalog(resource, {
    selectedServer, locale,
    reader: {
      async readIdentity(server) {
        const identity = await staticCatalogRelease(server);
        return { ...identity, server };
      },
      readCollection: (name, identity) => fetchStaticCatalog(name, identity.server, identity),
    },
  });
}
