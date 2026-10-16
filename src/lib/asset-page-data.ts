import type { SourceNode } from "./source-tree-search";
import type { ReleaseServer } from "./release-server";
export interface AssetPageData {
  schema: "haneoka-asset-page-v1";
  server: ReleaseServer;
  releaseId: string;
  sourceId: string;
  tree: Record<string, SourceNode>;
}
export interface AssetViewData {
  schema: "haneoka-asset-view-v1";
  server: ReleaseServer;
  releaseId: string;
  path: string[];
  files: string[];
  selected: string;
  textPreview: string;
}
export function assetOutputKind(file: string): "image" | "audio" | "video" | "model" | "text" | "binary" {
  const extension = file.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) return "image";
  if (["mp3", "wav", "ogg", "m4a"].includes(extension)) return "audio";
  if (["mp4", "webm"].includes(extension)) return "video";
  if (["glb", "gltf"].includes(extension)) return "model";
  if (["json", "txt", "xml", "csv", "md", "atlas"].includes(extension)) return "text";
  return "binary";
}
