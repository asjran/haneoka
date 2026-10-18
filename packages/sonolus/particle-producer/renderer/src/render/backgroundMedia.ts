import { convertIndexedToRgb, decode, hasPngSignature } from "fast-png";

export type BackgroundMediaSource = "video" | "canvas" | "static" | "none";

export interface BackgroundPixelImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

export async function loadBackgroundPixels(url: string): Promise<BackgroundPixelImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Background image ${response.status}`);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (hasPngSignature(bytes)) {
    const png = decode(bytes);
    const data = png.palette ? convertIndexedToRgb(png) : png.data;
    const channels = png.palette ? png.palette[0]!.length : png.channels;
    const depth = png.palette ? 8 : png.depth;
    if (depth === 8 && channels === 4) {
      return {
        width: png.width,
        height: png.height,
        rgba: data as Uint8Array | Uint8ClampedArray,
      };
    }
    if (depth >= 8) {
      const rgba = new Uint8Array(png.width * png.height * 4);
      const gray = channels <= 2;
      const alpha = channels === 2 || channels === 4;
      const scale = depth === 16 ? 255 / 65535 : 1;
      for (let pixel = 0; pixel < png.width * png.height; pixel++) {
        const input = pixel * channels, output = pixel * 4;
        for (let channel = 0; channel < 3; channel++)
          rgba[output + channel] = Math.round(data[input + (gray ? 0 : channel)]! * scale);
        const transparent = !alpha && png.transparency?.every((value, channel) => value === data[input + channel]);
        rgba[output + 3] = alpha ? Math.round(data[input + channels - 1]! * scale) : transparent ? 0 : 255;
      }
      return { width: png.width, height: png.height, rgba };
    }
  }
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, rgba: context.getImageData(0, 0, image.width, image.height).data };
  } finally {
    image.close();
  }
}

export function backgroundPixelsCanvas(image: BackgroundPixelImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(image.width, image.height);
  pixels.data.set(image.rgba);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * Pick the single source that owns the stage background. Keeping this policy
 * independent from Vue and Three.js makes source changes deterministic while
 * video loading and canvas production happen asynchronously.
 */
export function selectBackgroundMediaSource(
  videoAvailable: boolean,
  canvasAvailable: boolean,
  staticAvailable: boolean,
): BackgroundMediaSource {
  if (videoAvailable) return "video";
  if (canvasAvailable) return "canvas";
  if (staticAvailable) return "static";
  return "none";
}

interface DynamicCanvasTexture {
  needsUpdate: boolean;
}

interface CanvasDimensions {
  readonly width: number;
  readonly height: number;
}

/** Unversioned producers preserve the legacy per-render upload behavior. */
export function dynamicCanvasFrameChanged(
  producerVersion: number | undefined,
  uploadedVersion: number | undefined,
): boolean {
  return producerVersion === undefined || producerVersion !== uploadedVersion;
}

/** Mark one produced canvas frame for upload and report a backing-size change. */
export function refreshDynamicCanvasTexture(
  texture: DynamicCanvasTexture,
  canvas: CanvasDimensions,
  previousWidth: number,
  previousHeight: number,
): boolean {
  texture.needsUpdate = true;
  return canvas.width !== previousWidth || canvas.height !== previousHeight;
}
