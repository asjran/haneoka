import type { EmbedLoader } from "@haneoka/embed-core";
import type { OurNotesAssetManifest } from "@haneoka/cassiopeia-plugin-our-notes";
import type { ChartEmbedDocument } from "./types.js";
import { isHaneokaPublicResource, publicResourceType } from "./public-resources.js";

export async function resolveNativeResourceUrl(
  key: string,
  loader: EmbedLoader<ChartEmbedDocument>,
  signal: AbortSignal,
  nativeUrls: Set<string>,
): Promise<string> {
  const resolved = await loader.resourceUrl(key, { signal });
  if (!isHaneokaPublicResource(resolved)) return resolved;
  // Native loaders use this owned URL; HTTP stays on the existing resource
  // transport with the scoped public referrer policy.
  const bytes = await loader.resourceBytes(key, { signal });
  signal.throwIfAborted();
  const local = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: publicResourceType(resolved) }));
  nativeUrls.add(local);
  return local;
}

/** Resolve URL fields and sound cues, leaving names and inline atlas metadata intact. */
export async function resolveChartAssets(
  assets: OurNotesAssetManifest,
  loader: EmbedLoader<ChartEmbedDocument>,
  signal: AbortSignal,
  nativeUrls: Set<string>,
): Promise<OurNotesAssetManifest> {
  const urls = new Map<string, Promise<string>>();
  const url = (key: string) => {
    if (!key || /^(?:data|blob):/u.test(key)) return Promise.resolve(key);
    let result = urls.get(key);
    if (!result) {
      result = resolveNativeResourceUrl(key, loader, signal, nativeUrls);
      urls.set(key, result);
    }
    return result;
  };
  const visit = async (value: unknown, field = ""): Promise<unknown> => {
    if (typeof value === "string" && (field.endsWith("Url") || field === "url" || field === "sound")) return url(value);
    if (Array.isArray(value)) return Promise.all(value.map((entry) => visit(entry, field)));
    if (value && typeof value === "object") {
      if (field === "metadata" || field === "atlasMetadata") return value;
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await visit(
            entry,
            field === "url" ||
              key.endsWith("Urls") ||
              field === "judgementImages" ||
              field === "lifeIconUrls" ||
              field === "rankIconUrls"
              ? "url"
              : field === "noteSounds"
                ? "sound"
                : key,
          ),
        ]),
      );
      return Object.fromEntries(entries);
    }
    return value;
  };
  return (await visit(assets)) as OurNotesAssetManifest;
}
