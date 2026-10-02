import { stampFont, loadFontStylesheet } from "./fonts";
export { STAMP_FONTS } from "./fonts";
import type { StampLayer, StampImageTransform } from "./layers";
import {
  stampTextLayout,
  type StampWritingMode,
  type StampTextLayout,
} from "./text-layout";
import {
  stampFrameBounds,
  stampRotationKnob,
  stampLocalPoint,
  hitStampFrameHandle,
  STAMP_FRAME_HANDLES,
  type StampTextFrame,
  type StampResizeHandle,
} from "./frame";
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
  frame?: StampTextFrame;
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
    frame: undefined,
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
    text.frame,
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
  needLayout = false,
): StampTextLayout | undefined {
  if (
    !text.text.trim() &&
    !(text.background && text.background.alpha > 0) &&
    !needLayout
  )
    return;
  context.save();
  context.translate((width * text.x) / 100, (height * text.y) / 100);
  context.rotate((text.rotation * Math.PI) / 180);
  const layout = textLayout(context, text, width, fallback),
    { cells, inkBounds } = layout;
  const background = text.background;
  if (background && background.alpha > 0) {
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, background.alpha / 100));
    context.fillStyle = background.color;
    const box = visibleBounds(text, inkBounds, width),
      radius = Math.max(
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
  context.save();
  if (layout.frameBounds) {
    const box = layout.frameBounds;
    context.beginPath();
    context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    context.clip();
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
  context.restore();
  context.restore();
  return layout;
}
function canvasCssUnit(canvas: HTMLCanvasElement): number {
  const displayed =
    typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect().width
      : 0;
  return canvas.width / (displayed || canvas.width);
}
function drawRotationGuide(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  bounds: ReturnType<typeof stampFrameBounds>,
  centerX: number,
  centerY: number,
  rotation: number,
  color: string,
) {
  const unit = canvasCssUnit(canvas),
    knob = stampRotationKnob(
      bounds,
      centerX,
      centerY,
      rotation,
      canvas.width,
      canvas.height,
      unit,
    );
  context.strokeStyle = color;
  context.lineWidth = 1.5 * unit;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(knob.anchorX, knob.anchorY);
  context.lineTo(knob.x, knob.y);
  context.stroke();
  context.beginPath();
  context.arc(knob.x, knob.y, 7 * unit, 0, 2 * Math.PI);
  context.stroke();
  context.beginPath();
  context.arc(knob.x, knob.y, 3.5 * unit, -Math.PI / 2, Math.PI);
  context.stroke();
  context.beginPath();
  context.moveTo(knob.x - 3.5 * unit, knob.y);
  context.lineTo(knob.x - 5.5 * unit, knob.y - 2 * unit);
  context.lineTo(knob.x - 1.5 * unit, knob.y - 2 * unit);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}
function drawTextGuide(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
  color: string,
  layout?: StampTextLayout,
) {
  context.save();
  context.translate(
    (canvas.width * text.x) / 100,
    (canvas.height * text.y) / 100,
  );
  context.rotate((text.rotation * Math.PI) / 180);
  const bounds = stampFrameBounds(
      layout || textLayout(context, text, canvas.width, fallback),
      canvas.width,
      canvas.height,
    ),
    unit = canvasCssUnit(canvas);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.5 * unit;
  context.setLineDash([6 * unit, 4 * unit]);
  context.strokeRect(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
  );
  context.setLineDash([]);
  for (const [, x, y] of STAMP_FRAME_HANDLES) {
    const px = x ? (x < 0 ? bounds.left : bounds.right) : 0,
      py = y ? (y < 0 ? bounds.top : bounds.bottom) : 0;
    context.beginPath();
    context.arc(px, py, 4 * unit, 0, 2 * Math.PI);
    context.fill();
  }
  drawRotationGuide(
    context,
    canvas,
    bounds,
    (canvas.width * text.x) / 100,
    (canvas.height * text.y) / 100,
    text.rotation,
    color,
  );
  context.restore();
}
export function stampTextFrameGeometry(
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  context.save();
  const bounds = stampFrameBounds(
    textLayout(context, text, canvas.width, fallback),
    canvas.width,
    canvas.height,
  );
  context.restore();
  return {
    bounds,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
    centerX: (canvas.width * text.x) / 100,
    centerY: (canvas.height * text.y) / 100,
    rotation: text.rotation,
  };
}
export function hitStampTextHandle(
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
  x: number,
  y: number,
): StampResizeHandle | undefined {
  const geometry = stampTextFrameGeometry(canvas, text, fallback),
    local = stampLocalPoint(
      x,
      y,
      geometry.centerX,
      geometry.centerY,
      text.rotation,
    ),
    unit = canvasCssUnit(canvas);
  return hitStampFrameHandle(
    geometry.bounds,
    local.x,
    local.y,
    22 * unit,
    8 * unit,
  );
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

export function stampLayerRotationGeometry(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  text: StampText,
  transform?: StampImageTransform,
  effectiveSize?: StampSize,
) {
  if (!transform) return stampTextFrameGeometry(canvas, text, "sans-serif");
  const size = imageSize(canvas, image, transform, effectiveSize);
  return {
    bounds: {
      left: -size.width / 2,
      right: size.width / 2,
      top: -size.height / 2,
      bottom: size.height / 2,
    },
    centerX: (canvas.width * transform.x) / 100,
    centerY: (canvas.height * transform.y) / 100,
    rotation: transform.rotation,
    width: size.width,
    height: size.height,
  };
}
export function hitStampRotationHandle(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  text: StampText,
  fallback: string,
  x: number,
  y: number,
  transform?: StampImageTransform,
  effectiveSize?: StampSize,
) {
  const geometry = transform
    ? stampLayerRotationGeometry(canvas, image, text, transform, effectiveSize)
    : stampTextFrameGeometry(canvas, text, fallback);
  const unit = canvasCssUnit(canvas),
    knob = stampRotationKnob(
      geometry.bounds,
      geometry.centerX,
      geometry.centerY,
      geometry.rotation,
      canvas.width,
      canvas.height,
      unit,
    ),
    local = stampLocalPoint(
      x,
      y,
      geometry.centerX,
      geometry.centerY,
      geometry.rotation,
    );
  if (Math.hypot(local.x - knob.x, local.y - knob.y) <= 22 * unit)
    return geometry;
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
): boolean {
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
  if (isLayers(text)) {
    let selectedLayout: StampTextLayout | undefined;
    for (const layer of text) {
      if (layer.image)
        drawImageLayer(
          context,
          canvas,
          image,
          layer.image,
          undefined,
          effectiveSize,
        );
      else {
        const layout = drawTextLayer(
          context,
          layer.settings,
          canvas.width,
          canvas.height,
          fallback,
          !!selectionColor && layer.id === selectedLayerId,
        );
        if (layer.id === selectedLayerId) selectedLayout = layout;
      }
    }
    const selected = text.find((layer) => layer.id === selectedLayerId);
    if (selectionColor && selected) {
      if (selected.image) {
        const size = imageSize(canvas, image, selected.image, effectiveSize);
        context.save();
        context.translate(
          (canvas.width * selected.image.x) / 100,
          (canvas.height * selected.image.y) / 100,
        );
        context.rotate((selected.image.rotation * Math.PI) / 180);
        context.strokeStyle = selectionColor;
        context.lineWidth = canvas.width / 256;
        context.setLineDash([canvas.width / 64, canvas.width / 128]);
        context.strokeRect(
          -size.width / 2,
          -size.height / 2,
          size.width,
          size.height,
        );
        drawRotationGuide(
          context,
          canvas,
          {
            left: -size.width / 2,
            right: size.width / 2,
            top: -size.height / 2,
            bottom: size.height / 2,
          },
          (canvas.width * selected.image.x) / 100,
          (canvas.height * selected.image.y) / 100,
          selected.image.rotation,
          selectionColor,
        );
        context.restore();
      } else
        drawTextGuide(
          context,
          canvas,
          selected.settings,
          fallback,
          selectionColor,
          selectedLayout,
        );
    }
    return !!selectedLayout?.overflow;
  }
  const layout = drawTextLayer(
    context,
    text,
    canvas.width,
    canvas.height,
    fallback,
    !!selectionColor,
  );
  if (selectionColor)
    drawTextGuide(context, canvas, text, fallback, selectionColor, layout);
  return !!layout?.overflow;
}
export function hitStampText(
  canvas: HTMLCanvasElement,
  text: StampText,
  fallback: string,
  x: number,
  y: number,
): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.save();
  const layout = textLayout(context, text, canvas.width, fallback);
  const bounds = stampFrameBounds(layout, canvas.width, canvas.height);
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
