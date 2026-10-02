import type { AdvStory } from "@haneoka/vega/engine";
import type { EmbedLoader } from "@haneoka/embed-core";

// Document resource fields, including the standard character provider tuple.
// Text, opcode parameters, IDs and source provenance remain authored values.
const urls = new Set([
  "url",
  "src",
  "playableUrl",
  "imageUrl",
  "model",
  "modelUrl",
  "model3Json",
  "moc",
  "moc3",
  "physics",
  "pose",
  "userData",
  "atlas",
  "skel",
  "skeleton",
  "textureUrl",
  "texture",
  "maskTexture",
  "defaultDataRoot",
  "modelSource",
  "manifestSource",
  "mocSource",
  "physicsSource",
  "poseSource",
  "userDataSource",
]);
const maps = new Set([
  "compressedTextureVariants",
  "iconImagesByAsset",
  "sprites",
  "uiSprites",
  "dataRootsByWindowAsset",
]);

/** Clone resource fields and preserve shared model identity across commands. */
export async function resolveStoryUrls(
  story: AdvStory,
  loader: EmbedLoader<AdvStory>,
  signal: AbortSignal,
  playbackUrl?: (key: string) => Promise<string>,
): Promise<AdvStory> {
  const seen = new WeakMap<object, unknown>();
  const resolve = (value: string) => (value ? loader.resourceUrl(value, { signal }) : Promise.resolve(value));
  const visit = async (value: unknown, field = "", parent = ""): Promise<unknown> => {
    signal.throwIfAborted();
    if (typeof value === "string") {
      if (
        urls.has(field) ||
        (field === "source" && ["fonts", "motions", "expressions", "textureVariants"].includes(parent)) ||
        (field === "runtime" && ["motions", "expressions"].includes(parent)) ||
        maps.has(parent) ||
        parent === "textures"
      )
        return field === "playableUrl" && playbackUrl ? playbackUrl(value) : resolve(value);
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value) output.push(await visit(item, "", field));
      return output;
    }
    if (field === "windowRectsByDataRoot") {
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      for (const [key, entry] of Object.entries(value)) output[await resolve(key)] = entry;
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const [key, entry] of Object.entries(value)) {
      // Array elements carry their declaration kind into the resource record.
      output[key] = await visit(entry, key, field || parent);
    }
    return output;
  };
  return (await visit(story)) as AdvStory;
}
