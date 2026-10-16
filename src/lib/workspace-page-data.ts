import type { CrossCatalogDTO, CrossCatalogResource } from "./cross-server/catalog";
import type { ReleaseServer } from "./release-server";

export type CollectionWorkspaceResource = "stories" | "live2d" | "spine" | "help";
export interface WorkspaceCollectionPayload {
  schema: "haneoka-workspace-collection-v1";
  resource: CollectionWorkspaceResource;
  server: ReleaseServer;
  catalogs: Partial<Record<CrossCatalogResource, CrossCatalogDTO>>;
}

export function adoptPrerenderedWorkspace(owner: HTMLElement): void {
  if (owner.isConnected && owner.hasAttribute("data-prerendered")) {
    owner.removeAttribute("data-prerendered");
    owner.replaceChildren();
  }
}
