import { exportCubismModel, type ExportCubismModelOptions } from "@haneoka/vega-plugin-cubism/export";

export class Live2DExportError extends Error {
  readonly messageKey: "invalidModelPackage" | "emptyModelResource";
  readonly resource: string;
  constructor(messageKey: "invalidModelPackage" | "emptyModelResource", resource: string) {
    super(`${messageKey}: ${resource}`);
    this.messageKey = messageKey;
    this.resource = resource;
  }
}

/** Validate the source family before packaging; the exporter preserves its version and binary bytes. */
export async function exportLive2DModel(options: ExportCubismModelOptions) {
  const modelUrl = new URL(options.modelUrl).href;
  let mocUrl = "";
  let modern = false;
  const pngUrls = new Set<string>();
  const load = async (url: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const controller = new AbortController();
    let abortReason: unknown;
    const abort = (reason: unknown) => {
      if (controller.signal.aborted) return;
      abortReason = reason ?? new DOMException("The operation was aborted.", "AbortError");
      controller.abort(abortReason);
    };
    const abortSource = () => abort(signal?.reason);
    if (signal?.aborted) abortSource();
    else signal?.addEventListener("abort", abortSource, { once: true });
    // One absolute deadline covers both response headers and the response body.
    const timer = setTimeout(() => abort(new DOMException("The operation timed out.", "TimeoutError")), 30_000);
    let bytes: Uint8Array;
    try {
      if (controller.signal.aborted) throw abortReason;
      if (options.load) bytes = await options.load(url, controller.signal);
      else {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (controller.signal.aborted) throw abortReason;
    } catch (error) {
      // Older WebKit can replace the supplied abort reason with a generic fetch error.
      if (controller.signal.aborted) throw abortReason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortSource);
    }
    if (!bytes.byteLength) throw new Live2DExportError("emptyModelResource", url);
    if (url === modelUrl) {
      let descriptor: Record<string, unknown>;
      try {
        descriptor = JSON.parse(new TextDecoder().decode(bytes));
        if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error();
      } catch {
        throw new Live2DExportError("invalidModelPackage", url);
      }
      modern = Object.hasOwn(descriptor, "FileReferences");
      const references = modern ? descriptor.FileReferences : descriptor;
      if (!references || typeof references !== "object" || Array.isArray(references)) {
        throw new Live2DExportError("invalidModelPackage", url);
      }
      const files = references as Record<string, unknown>;
      const moc = modern ? files.Moc : files.model;
      const textures = modern ? files.Textures : files.textures;
      // Version is the model3 descriptor format, independent of the MOC3's Core generation.
      if (
        (modern && descriptor.Version !== 3) ||
        typeof moc !== "string" ||
        !moc ||
        !Array.isArray(textures) ||
        !textures.length ||
        textures.some((texture) => typeof texture !== "string" || !texture)
      )
        throw new Live2DExportError("invalidModelPackage", url);
      mocUrl = new URL(moc, modelUrl).href;
      for (const texture of textures as string[]) {
        const textureUrl = new URL(texture, modelUrl);
        if (/\.png$/i.test(textureUrl.pathname)) pngUrls.add(textureUrl.href);
      }
    } else if (
      modern &&
      url === mocUrl &&
      (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "MOC3")
    ) {
      throw new Live2DExportError("invalidModelPackage", url);
    }
    if (pngUrls.has(url) && ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
      throw new Live2DExportError("invalidModelPackage", url);
    }
    return bytes;
  };
  return exportCubismModel({ ...options, modelUrl, load });
}
