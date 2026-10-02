import {
  mergeCrossServerCatalog, OFFICIAL_CATALOG_SERVERS,
  type CrossCatalogResource, type CrossCatalogIdentity, type CrossCatalogRow, type CrossCatalogSnapshot, type OfficialCatalogServer,
} from "./catalog";

export interface CrossCatalogReader {
  readIdentity(server: OfficialCatalogServer): Promise<CrossCatalogIdentity>;
  readCollection(resource: CrossCatalogResource, identity: CrossCatalogIdentity): Promise<unknown>;
}
const object = (value: unknown): value is CrossCatalogRow => !!value && typeof value === "object" && !Array.isArray(value);
function collection(resource: CrossCatalogResource, value: unknown): Record<string, CrossCatalogRow> {
  if (!object(value)) throw new Error("Cross-server collection must be an object");
  const rows = resource === "events" ? value.entries : value;
  if (!object(rows) || Object.values(rows).some((row) => !object(row))) throw new Error("Cross-server collection rows malformed");
  return rows as Record<string, CrossCatalogRow>;
}

/** Each server is observed once, then all required collections use that immutable pin. */
export async function loadCrossServerCatalog(
  resource: CrossCatalogResource,
  options: { selectedServer: OfficialCatalogServer; locale: string; reader: CrossCatalogReader },
) {
  const dependencies: CrossCatalogResource[] = resource === "cards" || resource === "support-cards" || resource === "characters"
    ? ["bands", "characters", resource]
    : resource === "songs" ? ["bands", "characters", "songs"] : [resource];
  const resources = [...new Set(dependencies)];
  const failures: { server: OfficialCatalogServer; resource: CrossCatalogResource | "identity"; message: string }[] = [];
  const sources: CrossCatalogSnapshot[] = [];
  await Promise.all(OFFICIAL_CATALOG_SERVERS.map(async (server) => {
    let identity: CrossCatalogIdentity;
    try {
      identity = await options.reader.readIdentity(server);
      if (identity.server !== server) throw new Error("Cross-server identity mismatch");
    } catch (error) {
      failures.push({ server, resource: "identity", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const snapshot: CrossCatalogSnapshot = { identity, collections: {} };
    for (const name of resources) {
      try { snapshot.collections[name] = collection(name, await options.reader.readCollection(name, identity)); }
      catch (error) { failures.push({ server, resource: name, message: error instanceof Error ? error.message : String(error) }); }
    }
    sources.push(snapshot);
  }));
  return { ...mergeCrossServerCatalog(sources, resource, options), failures };
}
