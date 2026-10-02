export interface StampSize {
  width: number;
  height: number;
}
export const STAMP_CANVAS_SIZE = 512;
export const STAMP_SIZE_WIDTHS = [128, 256, 384, STAMP_CANVAS_SIZE] as const;
/** Composition exports are square; encoding cannot exceed the 512px canvas. */
export function stampOutputSize(
  source: StampSize,
  requested: string,
): StampSize {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1
  )
    throw new Error("Image dimensions unavailable");
  const width = requested === "native" ? STAMP_CANVAS_SIZE : Number(requested);
  if (!Number.isSafeInteger(width) || width < 1 || width > STAMP_CANVAS_SIZE)
    throw new Error("Output exceeds the 512px canvas");
  return { width, height: width };
}
export function stampSizeOptions(): {
  value: string;
  width: number;
  height: number;
}[] {
  return STAMP_SIZE_WIDTHS.map((width) => ({
    value: String(width),
    width,
    height: width,
  }));
}
