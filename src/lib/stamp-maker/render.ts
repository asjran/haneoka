import { stampFont, loadFontStylesheet } from "./fonts";
export { STAMP_FONTS } from "./fonts";
import type { StampLayer, StampImageTransform } from "./layers";
import { stampTextLayout, type StampWritingMode } from "./text-layout";
import { STAMP_CANVAS_SIZE, type StampSize } from "./sizes";

export interface StampBackground {
  color: string;
  alpha: number;
  padding: number;
  radius: number;
}

export interface StampText {
  text: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
  font: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  writingMode: StampWritingMode;
  background?: StampBackground;
  weight?: number;
}

export function defaultStampText(): StampText {
  return {
    text: "",
    x: 50,
    y: 18,
    size: 9,
    rotation: 0,
    font: "YurukaStd",
    fill: "#333333",
    stroke: "#ffffff",
    strokeWidth: 1.2,
    writingMode: "horizontal",
    weight: 900,
    background: undefined,
  };
}

export function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
}

function fontSpec(text: StampText, width: number, fallback: string): string {
  const font = stampFont(text.font);
  const weight = font?.weightRange
    ? Math.max(
        font.weightRange[0],
        Math.min(font.weightRange[1], text.weight || font.weight),
      )
    : font?.weight || 900;
  return `${weight} ${(width * text.size) / 100}px ${font ? `"${font.family}", ` : ""}${fallback}`;
}

/** A loaded face can render most edits immediately; CSS unicode-range additions are checked without fetching. */
export function isStampFontReady(text: StampText, fallback: string): boolean {
  return document.fonts.check(fontSpec(text, 512, fallback), text.text || " ");
}

export async function loadStampFont(
  text: StampText,
  fallback: string,
): Promise<void> {
  await loadFontStylesheet(stampFont(text.font));
  const font = stampFont(text.font);
  if (
    font &&
    ![...document.fonts].some(
      (face) => face.family.replace(/^["']|["']$/gu, "") === font.family,
    )
  )
    throw new Error("Selected font is unavailable");
  if (text.text.trim() && !isStampFontReady(text, fallback)) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const faces = await Promise.race([
      document.fonts.load(fontSpec(text, 512, fallback), text.text),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Font load timed out")),
          15000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (stampFont(text.font) && !faces.length)
      throw new Error("Selected font is unavailable");
  }
}

interface TextBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function textLayout(
  context: CanvasRenderingContext2D,
  text: StampText,
  width: number,
  fallback: string,
) {
  const size = (width * text.size) / 100;
  context.font = fontSpec(text, width, fallback);
  context.textAlign = "center";
  context.textBaseline = "middle";
  return stampTextLayout(
    context,
    text.text,
    size,
    width,
    (width * text.strokeWidth) / 100,
    text.writingMode,
  );
}

function visibleBounds(
  text: StampText,
  bounds: TextBounds,
  width: number,
): TextBounds {
  const extra =
    text.background && text.background.alpha > 0
      ? (width * text.background.padding) / 100
      : 0;
  return {
    left: bounds.left - extra,
    right: bounds.right + extra,
    top: bounds.top - extra,
    bottom: bounds.bottom + extra,
  };
}
function drawTextLayer(
  context: CanvasRenderingContext2D,
  text: StampText,
  width: number,
  height: number,
  fallback: string,
  selectionColor?: string,
): void {
  if (!text.text.trim() && !(text.background && text.background.alpha > 0))
    return;
  context.save();
  context.translate((width * text.x) / 100, (height * text.y) / 100);
  context.rotate((text.rotation * Math.PI) / 180);
  const { cells, inkBounds } = textLayout(context, text, width, fallback);
  const bounds = visibleBounds(text, inkBounds, width);
  const background = text.background;
  if (background && background.alpha > 0) {
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, background.alpha / 100));
    context.fillStyle = background.color;
    const inset = (width * background.padding) / 100;
    const box = {
      left: inkBounds.left - inset,
      right: inkBounds.right + inset,
      top: inkBounds.top - inset,
      bottom: inkBounds.bottom + inset,
    };
    const radius = Math.max(
      0,
      Math.min(
        (width * background.radius) / 100,
        (box.right - box.left) / 2,
        (box.bottom - box.top) / 2,
      ),
    );
    context.beginPath();
    context.roundRect(
      box.left,
      box.top,
      box.right - box.left,
      box.bottom - box.top,
      radius,
    );
    context.fill();
    context.restore();
  }
  context.lineJoin = "round";
  context.lineWidth = ((width * text.strokeWidth) / 100) * 2;
  context.strokeStyle = text.stroke;
  context.fillStyle = text.fill;
  for (const cell of cells) {
    context.save();
    context.translate(cell.x, cell.y);
    context.rotate(cell.rotation);
    context.scale(cell.scale, cell.scale);
    if (text.strokeWidth > 0) context.strokeText(cell.text, 0, 0);
    context.fillText(cell.text, 0, 0);
    context.restore();
  }
  if (selectionColor) {
    context.strokeStyle = selectionColor;
    context.lineWidth = width / 256;
    context.setLineDash([width / 64, width / 128]);
    context.strokeRect(
      bounds.left,
      bounds.top,
      bounds.right - bounds.left,
      bounds.bottom - bounds.top,
    );
  }
  context.restore();
}
function isLayers(
  value: StampText | readonly StampLayer[],
): value is readonly StampLayer[] {
  return Array.isArray(value);
}

function imageSize(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  transform: StampImageTransform,
  effectiveSize?: StampSize,
) {
  const width = Math.min(
      image.naturalWidth,
      effectiveSize?.width || image.naturalWidth,
    ),
    height = Math.min(
      image.naturalHeight,
      effectiveSize?.height || image.naturalHeight,
    );
  const fit =
    (((Math.min(1, STAMP_CANVAS_SIZE / width, STAMP_CANVAS_SIZE / height) *
      canvas.width) /
      STAMP_CANVAS_SIZE) *
      transform.scale) /
    100;
  return { width: width * fit, height: height * fit };
}
function drawImageLayer(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  transform: StampImageTransform,
  selectionColor?: string,
  effectiveSize?: StampSize,
) {
  const size = imageSize(canvas, image, transform, effectiveSize);
  context.save();
  context.translate(
    (canvas.width * transform.x) / 100,
    (canvas.height * transform.y) / 100,
  );
  context.rotate((transform.rotation * Math.PI) / 180);
  context.drawImage(
    image,
    -size.width / 2,
    -size.height / 2,
    size.width,
    size.height,
  );
  if (selectionColor) {
    context.strokeStyle = selectionColor;
    context.lineWidth = canvas.width / 256;
    context.setLineDash([canvas.width / 64, canvas.width / 128]);
    context.strokeRect(
      -size.width / 2,
      -size.height / 2,
      size.width,
      size.height,
    );
  }
  context.restore();
}
function hitImageLayer(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  transform: StampImageTransform,
  x: number,
  y: number,
  effectiveSize?: StampSize,
) {
  const size = imageSize(canvas, image, transform, effectiveSize),
    dx = x - (canvas.width * transform.x) / 100,
    dy = y - (canvas.height * transform.y) / 100,
    angle = (-transform.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle),
    localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return (
    Math.abs(localX) <= size.width / 2 && Math.abs(localY) <= size.height / 2
  );
}

/** Compatibility with one text style; ordered layers use the same Canvas paint path. */
export function drawStamp(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  text: StampText | readonly StampLayer[],
  fallback: string,
  selectionColor?: string,
  selectedLayerId?: string,
  effectiveSize?: StampSize,
): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!isLayers(text) || !text.some((layer) => layer.image))
    drawImageLayer(
      context,
      canvas,
      image,
      { x: 50, y: 50, scale: 100, rotation: 0 },
      undefined,
      effectiveSize,
    );
  if (isLayers(text))
    for (const layer of text) {
      const selected =
        layer.id === selectedLayerId ? selectionColor : undefined;
      if (layer.image)
        drawImageLayer(
          context,
          canvas,
          image,
          layer.image,
          selected,
          effectiveSize,
        );
      else
        drawTextLayer(
          context,
          layer.settings,
          canvas.width,
          canvas.height,
          fallback,
          selected,
        );
    }
  else
    drawTextLayer(
      context,
      text,
      canvas.width,
      canvas.height,
      fallback,
      selectionColor,
    );
}
export function hitStampText(
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
  x: number,
  y: number,
): boolean {
  const context = canvas.getContext("2d");
  if (
    !context ||
    (!text.text.trim() && !(text.background && text.background.alpha > 0))
  )
    return false;
  context.save();
  const bounds = visibleBounds(
    text,
    textLayout(context, text, canvas.width, fallback).bounds,
    canvas.width,
  );
  context.restore();
  const dx = x - (canvas.width * text.x) / 100,
    dy = y - (canvas.height * text.y) / 100,
    angle = (-text.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle),
    localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return (
    localX >= bounds.left &&
    localX <= bounds.right &&
    localY >= bounds.top &&
    localY <= bounds.bottom
  );
}
/** Last drawn layer owns an overlapping pointer hit. */
export function hitStampLayer(
  canvas: HTMLCanvasElement,
  layers: readonly StampLayer[],
  fallback: string,
  x: number,
  y: number,
  image?: HTMLImageElement,
  effectiveSize?: StampSize,
): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--)
    if (
      layers[index].image
        ? image &&
          hitImageLayer(
            canvas,
            image,
            layers[index].image!,
            x,
            y,
            effectiveSize,
          )
        : hitStampText(canvas, layers[index].settings, fallback, x, y)
    )
      return layers[index].id;
  return undefined;
}
