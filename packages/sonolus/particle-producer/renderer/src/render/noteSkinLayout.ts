import type { SpriteRegion } from "../assets/SpriteAtlas";
import { OUR_NOTES_BUNDLED_NOTE_ATLASES, sampleNoteSkinCurve } from "@haneoka/cassiopeia-plugin-our-notes";
import type { OurNotesNoteSkin, RenderDirection, RenderNoteKind } from "@haneoka/cassiopeia-plugin-our-notes";

export interface NoteSkinEndpoint {
  spriteName: string;
  overhang: number;
  flipX: boolean;
}

export interface NoteSkinParts {
  mainSpriteName: string;
  left: NoteSkinEndpoint;
  right: NoteSkinEndpoint;
}

export interface NoteSkinSpriteBounds {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  /** Full Sprite width before atlas trimming, in world units. */
  sourceWidth?: number;
}

export interface NoteSkinQuad {
  centerX: number;
  centerY: number;
  /** A negative width mirrors the source around the quad centre. */
  width: number;
  height: number;
}

export interface NoteSkinBodyLayout {
  left: NoteSkinQuad;
  mainLeft: NoteSkinQuad;
  mainMiddle: NoteSkinQuad;
  mainRight: NoteSkinQuad;
  right: NoteSkinQuad;
}

export interface NoteSkinOverlayLayout {
  alpha: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
}

export interface NoteSkinSlice {
  x: number;
  y: number;
  width: number;
  height: number;
}

type NoteSkinSelectionInput = {
  kind: RenderNoteKind;
  lane: number;
  width: number;
};

type NoteSkinArrowInput = {
  kind: RenderNoteKind;
  direction?: RenderDirection;
  width: number;
};

const CENTER_LANE = 11.5;
const CENTER_BOUNDARY = 12;
const definition = (kind: RenderNoteKind, skin: OurNotesNoteSkin) =>
  OUR_NOTES_BUNDLED_NOTE_ATLASES[skin].notes[kind === "guide" ? "trace" : kind];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function noteSkinPrefix(kind: RenderNoteKind): string {
  switch (kind) {
    case "tap":
      return "notes_tap_side";
    case "flick":
      return "notes_flick_side";
    case "flick-left":
      return "notes_flick_left_side";
    case "flick-right":
      return "notes_flick_right_side";
    case "slide-start":
      return "notes_slide_side";
    case "slide-node":
      return "notes_slide_connection_side";
    case "slide-end":
      return "notes_slide_end_side";
    case "trace":
    case "guide":
      return "notes_trace_side";
  }
}

export function noteSkinDecorationName(kind: RenderNoteKind, skin: OurNotesNoteSkin = "skin001"): string | undefined {
  // The slide-end prefab has no mark renderer despite sharing the asset-unit schema.
  if (kind === "slide-end") return undefined;
  return definition(kind, skin).centerMarkSprite ?? undefined;
}

export function noteSkinEffectiveDirection(note: Pick<NoteSkinArrowInput, "kind" | "direction">): RenderDirection {
  if (note.direction && note.direction !== "none") return note.direction;
  if (note.kind === "flick-left") return "left";
  if (note.kind === "flick-right") return "right";
  return note.kind === "flick" ? "up" : "none";
}

export function noteSkinArrowName(note: NoteSkinArrowInput, skin: OurNotesNoteSkin = "skin001"): string | undefined {
  if (!note.kind.startsWith("flick")) return undefined;
  const direction = noteSkinEffectiveDirection(note);
  const kind = direction === "left" ? "flick-left" : direction === "right" ? "flick-right" : "flick";
  const entries = definition(kind, skin).arrows;
  const entry = entries.find((entry) => note.width < entry.maxWidth) ?? entries.at(-1);
  return entry?.sprite ?? undefined;
}

function tiltValue(distance: number, thresholds: ReadonlyArray<{ distance: number; value: number }>): number {
  let value = 0;
  for (const threshold of thresholds) {
    value = threshold.value;
    // Native entries are inclusive upper bounds (ceil buckets).
    if (threshold.distance >= distance) break;
  }
  return clamp(value, 0, 6);
}

/** Exact branch structure of LiveSpritePartsNoteViewBase.OnSetViewWidth. */
export function selectNoteSkinParts(
  note: NoteSkinSelectionInput,
  thresholds: ReadonlyArray<{ distance: number; value: number }>,
  skin: OurNotesNoteSkin = "skin001",
): NoteSkinParts {
  const unit = definition(note.kind, skin);
  const leftBoundary = note.lane;
  const rightBoundary = note.lane + note.width;
  const laneCenter = note.lane + (note.width - 1) / 2;
  const leftTilt = tiltValue(Math.abs(leftBoundary - CENTER_BOUNDARY), thresholds);
  const rightTilt = tiltValue(Math.abs(rightBoundary - CENTER_BOUNDARY), thresholds);

  const fromRight = (tilt: number, flipX: boolean): NoteSkinEndpoint => ({
    spriteName: unit.parts.find((part) => part.tilt === tilt)?.rightSprite ?? "",
    overhang: unit.parts.find((part) => part.tilt === tilt)?.rightOverhang ?? 0,
    flipX,
  });
  const fromLeft = (tilt: number, flipX: boolean): NoteSkinEndpoint => ({
    spriteName: unit.parts.find((part) => part.tilt === tilt)?.leftSprite ?? "",
    overhang: unit.parts.find((part) => part.tilt === tilt)?.leftOverhang ?? 0,
    flipX,
  });

  if (leftBoundary < CENTER_BOUNDARY && rightBoundary > CENTER_BOUNDARY) {
    return {
      mainSpriteName: unit.mainSprite,
      left: fromRight(leftTilt, true),
      right: fromRight(rightTilt, false),
    };
  }
  if (laneCenter < CENTER_LANE) {
    return {
      mainSpriteName: unit.mainSprite,
      left: fromRight(leftTilt, true),
      right: fromLeft(rightTilt, true),
    };
  }
  return {
    mainSpriteName: unit.mainSprite,
    left: fromLeft(leftTilt, false),
    right: fromRight(rightTilt, false),
  };
}

/**
 * Selects the decoded, non-tilted L / 0 / R sprite triplet for a flat canvas.
 *
 * The live renderer deliberately changes endpoint sprites with screen
 * position to match its perspective camera. A vertical authoring timeline
 * has no such camera, so carrying that branch across makes the same note bend
 * as it moves between lanes. These are the selected skin's neutral parts;
 * no geometric substitute is introduced.
 */
export function selectFlatNoteSkinParts(kind: RenderNoteKind, skin: OurNotesNoteSkin = "skin001"): NoteSkinParts {
  const unit = definition(kind, skin);
  const part = unit.parts.find((entry) => entry.tilt === 0);
  return {
    mainSpriteName: unit.mainSprite,
    left: { spriteName: part?.leftSprite ?? "", overhang: part?.leftOverhang ?? 0, flipX: false },
    right: { spriteName: part?.rightSprite ?? "", overhang: part?.rightOverhang ?? 0, flipX: false },
  };
}

/** Tight render bounds and the full width used to place native note caps. */
export function noteSkinSpriteBounds(region: SpriteRegion): NoteSkinSpriteBounds {
  const rotated = region.packingRotation === 4;
  const pixelWidth = rotated ? region.rect.height : region.rect.width;
  const pixelHeight = rotated ? region.rect.width : region.rect.height;
  const ppu = region.pixelsToUnits;
  return {
    width: pixelWidth / ppu,
    height: pixelHeight / ppu,
    centerX: (region.offset.x + pixelWidth / 2 - region.pivot.x * region.sourceSize.width) / ppu,
    centerY: (region.offset.y + pixelHeight / 2 - region.pivot.y * region.sourceSize.height) / ppu,
    sourceWidth: region.sourceSize.width / ppu,
  };
}

/** Height of the complete note body before decorations and flick arrows. */
export function noteSkinBodyHeight(
  bounds: {
    leftBounds: NoteSkinSpriteBounds;
    mainBounds: NoteSkinSpriteBounds;
    rightBounds: NoteSkinSpriteBounds;
  },
  scale = 1,
): number {
  const sprites = [bounds.leftBounds, bounds.mainBounds, bounds.rightBounds];
  const top = Math.max(...sprites.map((sprite) => sprite.centerY + sprite.height / 2));
  const bottom = Math.min(...sprites.map((sprite) => sprite.centerY - sprite.height / 2));
  return Math.max(0, top - bottom) * Math.max(0, scale);
}

/**
 * Horizontal slices expressed in tight source textureRect coordinates.
 * Unity's border is authored against m_Rect, so textureRectOffset must be
 * removed before the atlas crop can be sliced.
 */
export function noteSkinTightHorizontalSlices(
  region: SpriteRegion,
): readonly [NoteSkinSlice, NoteSkinSlice, NoteSkinSlice] {
  const tightWidth = region.packingRotation === 4 ? region.rect.height : region.rect.width;
  if (tightWidth <= 0) {
    const empty = { x: 0, y: 0, width: 0, height: 1 } as const;
    return [empty, empty, empty];
  }
  const leftEnd = clamp(region.border.left - region.offset.x, 0, tightWidth);
  const rightStart = clamp(region.sourceSize.width - region.border.right - region.offset.x, leftEnd, tightWidth);
  return [
    { x: 0, y: 0, width: leftEnd / tightWidth, height: 1 },
    { x: leftEnd / tightWidth, y: 0, width: (rightStart - leftEnd) / tightWidth, height: 1 },
    { x: rightStart / tightWidth, y: 0, width: (tightWidth - rightStart) / tightWidth, height: 1 },
  ];
}

/** Shared native five-quad body layout for WebGL and 2D canvas. */
export function layoutNoteSkinBody(options: {
  parts: NoteSkinParts;
  leftBounds: NoteSkinSpriteBounds;
  rightBounds: NoteSkinSpriteBounds;
  mainBounds: NoteSkinSpriteBounds;
  mainRegion: SpriteRegion;
  /** Final body width in native world units (already includes note scale). */
  viewWidth: number;
  /** Native Transform scale applied to all non-stretched sprite dimensions. */
  scale: number;
}): NoteSkinBodyLayout {
  const scale = Math.max(0, options.scale);
  const leftWidth = (options.leftBounds.sourceWidth ?? options.leftBounds.width) * scale;
  const rightWidth = (options.rightBounds.sourceWidth ?? options.rightBounds.width) * scale;
  const leftHeight = options.leftBounds.height * scale;
  const rightHeight = options.rightBounds.height * scale;
  const mainHeight = options.mainBounds.height * scale;
  const leftOverhang = options.parts.left.overhang * scale;
  const rightOverhang = options.parts.right.overhang * scale;
  const leftCenterX = options.leftBounds.centerX * scale;
  const leftCenterY = options.leftBounds.centerY * scale;
  const rightCenterX = options.rightBounds.centerX * scale;
  const rightCenterY = options.rightBounds.centerY * scale;

  const mainWidth = Math.max(0.001, options.viewWidth - leftWidth - rightWidth + leftOverhang + rightOverhang);
  const mainX = (leftWidth - rightWidth + rightOverhang - leftOverhang) / 2;

  // SpriteRenderer drawMode=Sliced preserves the serialized m_Border values.
  // If the requested width is narrower than both caps, Unity scales them down
  // together rather than inventing a fixed 4px cap.
  const rawLeftBorder = (Math.max(0, options.mainRegion.border.left) / options.mainRegion.pixelsToUnits) * scale;
  const rawRightBorder = (Math.max(0, options.mainRegion.border.right) / options.mainRegion.pixelsToUnits) * scale;
  const borderTotal = rawLeftBorder + rawRightBorder;
  const borderScale = borderTotal > mainWidth && borderTotal > 0 ? mainWidth / borderTotal : 1;
  const leftBorder = rawLeftBorder * borderScale;
  const rightBorder = rawRightBorder * borderScale;
  const middleWidth = Math.max(0, mainWidth - leftBorder - rightBorder);

  return {
    left: {
      centerX:
        -options.viewWidth / 2 + leftWidth / 2 - leftOverhang + (options.parts.left.flipX ? -leftCenterX : leftCenterX),
      centerY: leftCenterY,
      width: options.parts.left.flipX ? -leftWidth : leftWidth,
      height: leftHeight,
    },
    mainLeft: {
      centerX: mainX - mainWidth / 2 + leftBorder / 2,
      centerY: 0,
      width: leftBorder,
      height: mainHeight,
    },
    mainMiddle: {
      centerX: mainX + (leftBorder - rightBorder) / 2,
      centerY: 0,
      width: middleWidth,
      height: mainHeight,
    },
    mainRight: {
      centerX: mainX + mainWidth / 2 - rightBorder / 2,
      centerY: 0,
      width: rightBorder,
      height: mainHeight,
    },
    right: {
      centerX:
        options.viewWidth / 2 -
        rightWidth / 2 +
        rightOverhang +
        (options.parts.right.flipX ? -rightCenterX : rightCenterX),
      centerY: rightCenterY,
      width: options.parts.right.flipX ? -rightWidth : rightWidth,
      height: rightHeight,
    },
  };
}

export function layoutNoteSkinDecoration(bounds: NoteSkinSpriteBounds, scale: number): NoteSkinOverlayLayout {
  return {
    alpha: 1,
    centerX: bounds.centerX * scale,
    centerY: bounds.centerY * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
    rotation: 0,
  };
}

export function layoutNoteSkinArrow(
  spriteName: string,
  direction: RenderDirection,
  bounds: NoteSkinSpriteBounds,
  scale: number,
  skin: OurNotesNoteSkin = "skin001",
  timeSeconds = 0,
  target?: NoteSkinOverlayLayout,
): NoteSkinOverlayLayout {
  const isUpper = spriteName.startsWith("notes_flick_arrow_upper_");
  const kind = direction === "left" ? "flick-left" : direction === "right" ? "flick-right" : "flick";
  const animation = definition(kind, skin).arrowAnimation;
  const time =
    animation && animation.duration > 0
      ? ((timeSeconds % animation.duration) + animation.duration) % animation.duration
      : 0;
  const parentScale = isUpper ? 0.800000011920929 : 1;
  const scaleX = scale * parentScale * (animation ? sampleNoteSkinCurve(animation.scaleX, time) : 1);
  const scaleY = scale * parentScale * (animation ? sampleNoteSkinCurve(animation.scaleY, time) : 1);
  const rotation = !isUpper && direction === "left" ? Math.PI : 0;
  const rotationCos = Math.cos(rotation);
  const rotationSin = Math.sin(rotation);
  const centerX = bounds.centerX * scaleX;
  const centerY = bounds.centerY * scaleY;
  const positionX = animation ? sampleNoteSkinCurve(animation.x, time) : 0;
  const positionY = animation ? sampleNoteSkinCurve(animation.y, time) : 1;
  const layout = target ?? { centerX: 0, centerY: 0, width: 0, height: 0, rotation: 0, alpha: 1 };
  layout.centerX = positionX * parentScale * scale + centerX * rotationCos - centerY * rotationSin;
  layout.centerY =
    ((isUpper ? 0.3499999940395355 : 0) + positionY * parentScale) * scale +
    centerX * rotationSin +
    centerY * rotationCos;
  layout.width = bounds.width * scaleX;
  layout.height = bounds.height * scaleY;
  layout.rotation = rotation;
  layout.alpha = animation ? clamp(sampleNoteSkinCurve(animation.alpha, time), 0, 1) : 1;
  return layout;
}
