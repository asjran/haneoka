import { loadStaticCrossServerCatalogs } from "../lib/cross-server/static";
import type { CrossCatalogResource, OfficialCatalogServer } from "../lib/cross-server/catalog";
import type { CollectionWorkspaceResource, WorkspaceCollectionPayload } from "../lib/workspace-page-data";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";

const resources: Record<CollectionWorkspaceResource, readonly CrossCatalogResource[]> = {
  stories: ["stories", "characters", "bands"],
  live2d: ["live2d", "characters", "bands"],
  spine: ["spine"],
  help: ["help", "help-tips"],
};
const pages = new Map<string, Promise<WorkspaceCollectionPayload>>();

export function workspaceCollectionData(resource: CollectionWorkspaceResource, server: ReleaseServer, locale: Locale): Promise<WorkspaceCollectionPayload> {
  const key = `${server}:${locale}:${resource}`;
  let pending = pages.get(key);
  if (!pending) {
    pending = loadData(resource, server, locale);
    pages.set(key, pending);
  }
  return pending;
}

async function loadData(resource: CollectionWorkspaceResource, server: ReleaseServer, locale: Locale): Promise<WorkspaceCollectionPayload> {
  const catalogs = await loadStaticCrossServerCatalogs(resources[resource], server as OfficialCatalogServer, locale);
  for (const name of resources[resource]) {
    if (catalogs[name]?.sourceAvailability[server as OfficialCatalogServer] !== "loaded")
      throw new Error(`Missing static catalog: ${server}/${name}`);
  }
  return { schema: "haneoka-workspace-collection-v1", resource, server, catalogs };
}
