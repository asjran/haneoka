import { stampFont, loadFontStylesheet } from "./fonts";
export { STAMP_FONTS } from "./fonts";
import { stampTextLayout, type StampWritingMode } from "./text-layout";

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
  };
}

export function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
}

function fontSpec(text: StampText, width: number, fallback: string): string {
  const font = stampFont(text.font);
  return `${font?.weight || 900} ${(width * text.size) / 100}px ${font ? `"${font.family}", ` : ""}${fallback}`;
}

export async function loadStampFont(text: StampText, fallback: string): Promise<void> {
  await loadFontStylesheet(stampFont(text.font));
  if (text.text.trim()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const faces = await Promise.race([
      document.fonts.load(fontSpec(text, 512, fallback), text.text),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Font load timed out")), 15000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (stampFont(text.font) && !faces.length) throw new Error("Selected font is unavailable");
  }
}

interface TextBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function textLayout(context: CanvasRenderingContext2D, text: StampText, width: number, fallback: string) {
  const size = (width * text.size) / 100;
  context.font = fontSpec(text, width, fallback);
  context.textAlign = "center";
  context.textBaseline = "middle";
  return stampTextLayout(context, text.text, size, width, (width * text.strokeWidth) / 100, text.writingMode);
}

/** Selection is a preview overlay; exports call this without its color. */
export function drawStamp(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  text: StampText,
  fallback: string,
  selectionColor?: string,
): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const imageWidth = image.naturalWidth * scale;
  const imageHeight = image.naturalHeight * scale;
  context.drawImage(image, (canvas.width - imageWidth) / 2, (canvas.height - imageHeight) / 2, imageWidth, imageHeight);
  if (!text.text.trim()) return;
  context.save();
  context.translate((canvas.width * text.x) / 100, (canvas.height * text.y) / 100);
  context.rotate((text.rotation * Math.PI) / 180);
  const { cells, bounds } = textLayout(context, text, canvas.width, fallback);
  context.lineJoin = "round";
  context.lineWidth = ((canvas.width * text.strokeWidth) / 100) * 2;
  context.strokeStyle = text.stroke;
  context.fillStyle = text.fill;
  cells.forEach((cell) => {
    context.save();
    context.translate(cell.x, cell.y);
    context.rotate(cell.rotation);
    context.scale(cell.scale, cell.scale);
    if (text.strokeWidth > 0) context.strokeText(cell.text, 0, 0);
    context.fillText(cell.text, 0, 0);
    context.restore();
  });
  if (selectionColor) {
    context.strokeStyle = selectionColor;
    context.lineWidth = canvas.width / 256;
    context.setLineDash([canvas.width / 64, canvas.width / 128]);
    context.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  }
  context.restore();
}

/** Pointer hit-testing uses the same font metrics and rotation as drawing. */
export function hitStampText(
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
  x: number,
  y: number,
): boolean {
  const context = canvas.getContext("2d");
  if (!context || !text.text.trim()) return false;
  context.save();
  const bounds: TextBounds = textLayout(context, text, canvas.width, fallback).bounds;
  context.restore();
  const dx = x - (canvas.width * text.x) / 100;
  const dy = y - (canvas.height * text.y) / 100;
  const angle = (-text.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return localX >= bounds.left && localX <= bounds.right && localY >= bounds.top && localY <= bounds.bottom;
}
