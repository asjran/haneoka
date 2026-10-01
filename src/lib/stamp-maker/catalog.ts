import { localizedText, type JsonRecord } from "../../lit/shared/catalog";

/** Approved T37 publication snapshot; callers may override via textless-src. */
export function textlessManifestUrl(server: string): string | undefined {
  return server === "intl" ? "/tools/stamp-maker/assets/intl/ts-c7409ce1fc695c94/manifest.json" : undefined;
}

export interface StampChoice {
  id: string;
  resourceName: string;
  label: string;
  sources: string[];
  variants: { language: string; url: string }[];
  characterIds: string[];
  effectiveSize?: { width: number; height: number };
}

/** Only quality-reviewed derivatives enter the textless chooser. */
export interface TextlessStampManifest {
  schema: "haneoka-textless-stamps-v1";
  server: string;
  records: {
    id: string;
    publishable: boolean;
    quality: string;
    nativeSize?: [number, number];
    effectiveOriginalWidthHeight?: [number, number];
    originalSourceSize?: [number, number];
    artifacts: {
      nativeOriginal?: { path: string; sha256?: string };
      exportCandidate?: { path: string; sha256?: string };
    };
  }[];
}

export function stampAssetUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !(value.startsWith("/assets/") || value.startsWith("/tools/stamp-maker/assets/")) ||
    value.includes("\\")
  )
    return;
  return value;
}

export function stampChoices(catalog: JsonRecord, locale: string, imageLanguage = ""): StampChoice[] {
  const language = imageLanguage || (locale === "zh-CN" ? "zh-Hans" : locale === "zh-TW" ? "zh-Hant" : locale);
  return Object.entries(catalog)
    .flatMap(([id, value]) => {
      if (!value || typeof value !== "object") return [];
      const stamp = value as JsonRecord;
      const image = String(stamp.image || "");
      const variants = (stamp.imageVariants as Record<string, Record<string, string>> | undefined)?.[image] || {};
      const versions = Object.entries(variants).flatMap(([language, value]) => {
        const url = stampAssetUrl(value);
        return url ? [{ language, url }] : [];
      });
      const original = stampAssetUrl(image);
      if (original && !versions.some((version) => version.url === original))
        versions.push({ language: "original", url: original });
      const sources = [...new Set([variants[language], variants.ja, image, ...Object.values(variants)])]
        .map(stampAssetUrl)
        .filter((source): source is string => !!source);
      if (!sources.length) return [];
      const resourceName =
        image
          .split("/")
          .pop()
          ?.replace(/\.png$/u, "") || "";
      return [
        {
          id,
          resourceName,
          label: localizedText(stamp.name, locale) || resourceName,
          sources,
          variants: versions,
          characterIds: Array.isArray(stamp.characterIds) ? stamp.characterIds.map(String) : [],
        },
      ];
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export function textlessChoices(originals: StampChoice[], value: unknown, server: string): StampChoice[] {
  if (!value || typeof value !== "object") return [];
  const manifest = value as Partial<TextlessStampManifest>;
  if (
    manifest.schema !== "haneoka-textless-stamps-v1" ||
    manifest.server !== server ||
    !Array.isArray(manifest.records)
  )
    return [];
  const entries = new Map<string, { source: string; effectiveSize?: { width: number; height: number } }>();
  for (const record of manifest.records) {
    if (!record || record.publishable !== true || typeof record.id !== "string") continue;
    const source = stampAssetUrl(record.artifacts?.nativeOriginal?.path || record.artifacts?.exportCandidate?.path);
    const size = record.effectiveOriginalWidthHeight || record.nativeSize || record.originalSourceSize;
    const effectiveSize =
      Array.isArray(size) && size.length === 2 && size.every((value) => Number.isSafeInteger(value) && value > 0)
        ? { width: size[0], height: size[1] }
        : undefined;
    if (source) entries.set(record.id, { source, effectiveSize });
  }
  return originals.flatMap((stamp) => {
    const entry = entries.get(stamp.resourceName);
    return entry ? [{ ...stamp, sources: [entry.source], effectiveSize: entry.effectiveSize }] : [];
  });
}

/** Blob loading keeps cancellation and the canvas origin under our control. */
export async function loadStampImage(sources: readonly string[], signal: AbortSignal): Promise<HTMLImageElement> {
  for (const source of sources) {
    signal.throwIfAborted();
    try {
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(`Stamp image ${response.status}`);
      const blob = await response.blob();
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        signal.throwIfAborted();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("Empty stamp image");
        return image;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  throw new Error("Stamp images are unavailable");
}

/** Local files use the same decoded pixels for preview and transparent PNG export. */
export async function loadStampFile(file: File, signal: AbortSignal): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 24_000_000 ||
      image.naturalWidth > 8192 ||
      image.naturalHeight > 8192
    )
      throw new Error("Image dimensions exceed the editor limit");
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
