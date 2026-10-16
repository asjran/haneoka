import { staticCatalogRelease, fetchStaticCatalog, fetchStaticCatalogBatch, type StaticCatalogRelease } from "../static-catalog-source";
import { loadCrossServerCatalog } from "./load";
import { loadCrossServerCatalogs } from "./bundle";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";
import { crossCatalogApi, crossCatalogDefinition, crossCatalogRows } from "./definitions";

const songCollections = new Map<string, Promise<unknown>>();
function collectionWithMissionFields(resource: CrossCatalogResource, identity: StaticCatalogRelease): Promise<unknown> {
  if (resource !== "songs") return fetchStaticCatalog(crossCatalogApi(resource), identity.server, identity);
  const key = JSON.stringify(identity);
  let pending = songCollections.get(key);
  if (!pending) {
    pending = (async () => {
      const document = await fetchStaticCatalog("songs", identity.server, identity);
      const rows = crossCatalogRows("songs", document);
      const details = await fetchStaticCatalogBatch("songs", Object.keys(rows), identity.server, identity);
      return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, {
        ...row, gekisou: details.get(id)!.gekisou,
      }]));
    })();
    songCollections.set(key, pending);
  }
  return pending;
}

export function loadStaticCrossServerCatalogs(resources: readonly CrossCatalogResource[], selectedServer: OfficialCatalogServer, locale: string) {
  return loadCrossServerCatalogs(resources, {
    selectedServer, locale, servers: selectedServer === "intl-test" ? ["jp", "intl", "intl-test"] : ["jp", "intl"],
    reader: {
      async readIdentity(server) { return { ...await staticCatalogRelease(server), server }; },
      readCollection: (name, identity) => collectionWithMissionFields(name, identity),
      readEntity: (name, identity, id) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(id)}`, identity.server, identity),
    },
  });
}

/** Build adapter reuses the configured current-release pin and existing collection cache. */
export function loadStaticCrossServerCatalog(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string) {
  return loadCrossServerCatalog(resource, {
    selectedServer, locale,
    servers: selectedServer === "intl-test" ? ["jp", "intl", "intl-test"] : ["jp", "intl"],
    reader: {
      async readIdentity(server) {
        const identity = await staticCatalogRelease(server);
        return { ...identity, server };
      },
      readCollection: (name, identity) => fetchStaticCatalog(crossCatalogApi(name), identity.server, identity),
      readEntity: (name, identity, id) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(id)}`, identity.server, identity),
    },
  });
}

/** Entity pages inspect one original ID, rather than rebuilding the entire union per page. */
export function loadStaticCrossServerEntry(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string, id: string) {
  return loadCrossServerCatalog(resource, {
    selectedServer, locale, withDependencies: false, servers: selectedServer === "intl-test" ? ["jp", "intl", "intl-test"] : ["jp", "intl"],
    reader: {
      async readIdentity(server) { return { ...await staticCatalogRelease(server), server }; },
      async readCollection(name, identity) {
        const document = await fetchStaticCatalog(crossCatalogApi(name), identity.server, identity);
        const rows = crossCatalogRows(name, document, id), key = crossCatalogDefinition(name).rows;
        return key ? { [key]: rows } : rows;
      },
      readEntity: (name, identity, key) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(key)}`, identity.server, identity),
    },
  });
}
