export interface StampSize {
  width: number;
  height: number;
}
export const STAMP_SIZE_WIDTHS = [128, 192, 256, 320, 384, 512, 768, 1024, 1536, 2048] as const;
/** Width choices preserve the source ratio, and never exceed either effective native dimension. */
export function stampOutputSize(source: StampSize, requested: string): StampSize {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1
  )
    throw new Error("Image dimensions unavailable");
  if (requested === "native") return { ...source };
  const width = Number(requested);
  const height = Math.max(1, Math.round((source.height * width) / source.width));
  if (!Number.isSafeInteger(width) || width < 1 || width > source.width || height > source.height)
    throw new Error("Output exceeds the native image dimensions");
  return { width, height };
}
export function stampSizeOptions(source: StampSize): { value: string; width: number; height: number }[] {
  return STAMP_SIZE_WIDTHS.filter((width) => width < source.width).map((width) => ({
    value: String(width),
    ...stampOutputSize(source, String(width)),
  }));
}
