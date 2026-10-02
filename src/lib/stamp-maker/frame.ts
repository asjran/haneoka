import type { StampTextLayout } from "./text-layout";

export interface StampTextFrame {
  width: number;
  height: number;
}
export interface FrameBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export type StampResizeHandle =
  "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const STAMP_FRAME_MIN = 4;
export const STAMP_FRAME_MAX = 100;
export const STAMP_FRAME_HANDLES: readonly [
  StampResizeHandle,
  number,
  number,
][] = [
  ["nw", -1, -1],
  ["n", 0, -1],
  ["ne", 1, -1],
  ["e", 1, 0],
  ["se", 1, 1],
  ["s", 0, 1],
  ["sw", -1, 1],
  ["w", -1, 0],
];
export function clampFramePercent(value: number): number {
  return Math.max(
    STAMP_FRAME_MIN,
    Math.min(STAMP_FRAME_MAX, Number.isFinite(value) ? value : 50),
  );
}
/** Legacy captions keep their layout; their inferred frame becomes explicit only when resized. */
export function stampFrameBounds(
  layout: StampTextLayout,
  width: number,
  height: number,
): FrameBounds {
  if (layout.frameBounds) return layout.frameBounds;
  const empty = !layout.cells.some((cell) => cell.text.trim());
  const w = Math.max(
    empty ? width * 0.4 : 0,
    2 * Math.max(Math.abs(layout.bounds.left), Math.abs(layout.bounds.right)),
  );
  const h = Math.max(
    empty ? height * 0.18 : 0,
    2 * Math.max(Math.abs(layout.bounds.top), Math.abs(layout.bounds.bottom)),
  );
  const halfW = (width * clampFramePercent((w * 100) / width)) / 200;
  const halfH = (height * clampFramePercent((h * 100) / height)) / 200;
  return { left: -halfW, right: halfW, top: -halfH, bottom: halfH };
}
export function stampLocalPoint(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  rotation: number,
) {
  const angle = (-rotation * Math.PI) / 180,
    dx = x - centerX,
    dy = y - centerY;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}
/** Touch targets extend outward; the interior stays available for moving the layer. */
export function hitStampFrameHandle(
  bounds: FrameBounds,
  x: number,
  y: number,
  targetRadius: number,
  edgeTolerance: number,
): StampResizeHandle | undefined {
  const inside =
    x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom;
  const inset = Math.min(
    edgeTolerance,
    (bounds.right - bounds.left) / 4,
    (bounds.bottom - bounds.top) / 4,
  );
  if (
    inside &&
    Math.min(
      x - bounds.left,
      bounds.right - x,
      y - bounds.top,
      bounds.bottom - y,
    ) > inset
  )
    return;
  const cx = (bounds.left + bounds.right) / 2,
    cy = (bounds.top + bounds.bottom) / 2;
  let nearest: StampResizeHandle | undefined,
    distance = targetRadius;
  for (const [handle, sx, sy] of STAMP_FRAME_HANDLES) {
    const px = sx ? (sx < 0 ? bounds.left : bounds.right) : cx;
    const py = sy ? (sy < 0 ? bounds.top : bounds.bottom) : cy;
    const d = Math.hypot(x - px, y - py);
    if (d < distance) {
      distance = d;
      nearest = handle;
    }
  }
  if (nearest) return nearest;
  if (y >= bounds.top - edgeTolerance && y <= bounds.bottom + edgeTolerance) {
    if (Math.abs(x - bounds.left) <= edgeTolerance) return "w";
    if (Math.abs(x - bounds.right) <= edgeTolerance) return "e";
  }
  if (x >= bounds.left - edgeTolerance && x <= bounds.right + edgeTolerance) {
    if (Math.abs(y - bounds.top) <= edgeTolerance) return "n";
    if (Math.abs(y - bounds.bottom) <= edgeTolerance) return "s";
  }
}
export interface StampResizeStart {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
  pointerX: number;
  pointerY: number;
  handle: StampResizeHandle;
}
/** The opposite edge stays fixed in rotated local coordinates; font size is independent. */
export function resizeStampFrame(
  start: StampResizeStart,
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const delta = stampLocalPoint(
    x,
    y,
    start.pointerX,
    start.pointerY,
    start.rotation,
  );
  const [, sx, sy] = STAMP_FRAME_HANDLES.find(
    (item) => item[0] === start.handle,
  )!;
  const width = sx
    ? (canvasWidth *
        clampFramePercent(((start.width + delta.x * sx) * 100) / canvasWidth)) /
      100
    : start.width;
  const height = sy
    ? (canvasHeight *
        clampFramePercent(
          ((start.height + delta.y * sy) * 100) / canvasHeight,
        )) /
      100
    : start.height;
  const shiftX = (sx * (width - start.width)) / 2,
    shiftY = (sy * (height - start.height)) / 2;
  const angle = (start.rotation * Math.PI) / 180;
  return {
    x: Math.max(
      0,
      Math.min(
        100,
        ((start.centerX + shiftX * Math.cos(angle) - shiftY * Math.sin(angle)) *
          100) /
          canvasWidth,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        100,
        ((start.centerY + shiftX * Math.sin(angle) + shiftY * Math.cos(angle)) *
          100) /
          canvasHeight,
      ),
    ),
    frame: {
      width: (width * 100) / canvasWidth,
      height: (height * 100) / canvasHeight,
    },
  };
}
export function stampResizeCursor(
  handle: StampResizeHandle,
  rotation: number,
): string {
  const [, x, y] = STAMP_FRAME_HANDLES.find((item) => item[0] === handle)!;
  const direction =
    ((Math.round(((Math.atan2(y, x) * 180) / Math.PI + rotation) / 45) % 4) +
      4) %
    4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][direction];
}

export interface StampRotationStart {
  centerX: number;
  centerY: number;
  pointerX: number;
  pointerY: number;
  rotation: number;
}
export function rotateStampLayer(
  start: StampRotationStart,
  x: number,
  y: number,
): number {
  const initial = Math.atan2(
    start.pointerY - start.centerY,
    start.pointerX - start.centerX,
  );
  const current = Math.atan2(y - start.centerY, x - start.centerX);
  const delta =
    (Math.atan2(Math.sin(current - initial), Math.cos(current - initial)) *
      180) /
    Math.PI;
  const degrees = start.rotation + delta;
  return Math.round(((((degrees + 180) % 360) + 360) % 360) - 180);
}
/** Prefer an outside knob; full-canvas or off-center layers keep an accessible knob inside the viewport. */
export function stampRotationKnob(
  bounds: FrameBounds,
  centerX: number,
  centerY: number,
  rotation: number,
  width: number,
  height: number,
  unit: number,
) {
  const cos = Math.cos((rotation * Math.PI) / 180),
    sin = Math.sin((rotation * Math.PI) / 180),
    gap = 24 * unit,
    margin = 9 * unit;
  const anchors = [
    { x: 0, y: bounds.top, dx: 0, dy: -1 },
    { x: 0, y: bounds.bottom, dx: 0, dy: 1 },
    { x: bounds.right, y: 0, dx: 1, dy: 0 },
    { x: bounds.left, y: 0, dx: -1, dy: 0 },
  ];
  const world = (x: number, y: number) => ({
    x: centerX + x * cos - y * sin,
    y: centerY + x * sin + y * cos,
  });
  for (const direction of [1, -1])
    for (const anchor of anchors) {
      const x = anchor.x + anchor.dx * gap * direction,
        y = anchor.y + anchor.dy * gap * direction,
        p = world(x, y);
      if (
        p.x >= margin &&
        p.x <= width - margin &&
        p.y >= margin &&
        p.y <= height - margin
      )
        return { x, y, anchorX: anchor.x, anchorY: anchor.y };
    }
  const preferred = anchors[0],
    p = world(preferred.x, preferred.y - gap);
  let px = Math.max(margin, Math.min(width - margin, p.x)),
    py = Math.max(margin, Math.min(height - margin, p.y));
  if (Math.hypot(px - centerX, py - centerY) < gap / 2) {
    const alternatives = [
      { x: centerX + gap, y: centerY },
      { x: centerX - gap, y: centerY },
      { x: centerX, y: centerY + gap },
      { x: centerX, y: centerY - gap },
    ];
    const point = alternatives.find(
      (point) =>
        point.x >= margin &&
        point.x <= width - margin &&
        point.y >= margin &&
        point.y <= height - margin,
    );
    if (point) {
      px = point.x;
      py = point.y;
    }
  }
  const local = stampLocalPoint(px, py, centerX, centerY, rotation);
  return { ...local, anchorX: local.x, anchorY: local.y };
}
