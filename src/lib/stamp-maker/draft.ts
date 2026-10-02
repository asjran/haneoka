import {
  createStampImageLayer,
  type StampLayer,
  type StampImageTransform,
} from "./layers";
import type { StampText } from "./render";
import { STAMP_FONTS, stampFont } from "./fonts";

export const STAMP_DRAFT_KEY = "haneoka.stamp-maker.draft.v2";
const LEGACY_DRAFT_KEY = "haneoka.stamp-maker.draft.v1";
const MAX_DRAFT_LENGTH = 65_536;
const LANGUAGES = new Set([
  "",
  "original",
  "ja",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "textless",
]);
const FONTS = new Set(["auto", ...STAMP_FONTS.map((font) => font.family)]);
const MODES = new Set(["horizontal", "vertical-rl", "vertical-lr"]);
export interface StampDraft {
  schema: "haneoka-stamp-maker-draft";
  version: 2;
  savedAt: string;
  server: string;
  selected: string;
  resourceName: string;
  imageLanguage: string;
  activeLayerId: string;
  layers: StampLayer[];
}
export type DraftRead =
  | { status: "empty" | "invalid" | "unavailable"; draft?: undefined }
  | { status: "ready"; draft: StampDraft };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const color = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);

/** Strict projection drops extra properties; saved data never carries URLs, images or font binaries. */
export function parseStampDraft(value: unknown): StampDraft | undefined {
  const input = object(value);
  if (
    !input ||
    input.schema !== "haneoka-stamp-maker-draft" ||
    (input.version !== 1 && input.version !== 2) ||
    !string(input.server, 32) ||
    !/^[a-z][a-z0-9-]*$/u.test(input.server) ||
    !string(input.selected, 24) ||
    !/^\d+$/u.test(input.selected) ||
    !string(input.resourceName, 160) ||
    !/^[a-zA-Z0-9_.()-]+$/u.test(input.resourceName) ||
    !string(input.imageLanguage, 16) ||
    !LANGUAGES.has(input.imageLanguage) ||
    !string(input.savedAt, 40) ||
    !Number.isFinite(Date.parse(input.savedAt)) ||
    !string(input.activeLayerId, 96) ||
    !Array.isArray(input.layers) ||
    input.layers.length < 1 ||
    input.layers.length > (input.version === 1 ? 12 : 13)
  )
    return;
  const layers: StampLayer[] = [],
    ids = new Set<string>();
  let imageCount = 0,
    textCount = 0;
  for (const entry of input.layers) {
    const layer = object(entry),
      style = object(layer?.settings);
    if (
      !layer ||
      !style ||
      !string(layer.id, 96) ||
      !/^[a-zA-Z0-9_-]+$/u.test(layer.id) ||
      ids.has(layer.id) ||
      !string(style.text, 500) ||
      !number(style.x, 0, 100) ||
      !number(style.y, 0, 100) ||
      !number(style.size, 0.1, 100) ||
      !number(style.rotation, -180, 180) ||
      !number(style.strokeWidth, 0, 10) ||
      !color(style.fill) ||
      !color(style.stroke) ||
      !string(style.font, 180) ||
      !string(style.writingMode, 16) ||
      !MODES.has(style.writingMode) ||
      (style.weight !== undefined && !number(style.weight, 100, 900)) ||
      !string(layer.colorCharacter, 24) ||
      !/^(?:custom|\d+)$/u.test(layer.colorCharacter) ||
      !string(layer.backgroundCharacter, 24) ||
      !/^(?:custom|\d+)$/u.test(layer.backgroundCharacter) ||
      typeof layer.colorWasChosen !== "boolean" ||
      (layer.localFontLabel !== undefined && !string(layer.localFontLabel, 180))
    )
      return;
    let image: StampImageTransform | undefined;
    if (layer.image !== undefined) {
      const transform = object(layer.image);
      if (
        input.version === 1 ||
        !transform ||
        !number(transform.x, 0, 100) ||
        !number(transform.y, 0, 100) ||
        !number(transform.scale, 10, 300) ||
        !number(transform.rotation, -180, 180)
      )
        return;
      image = {
        x: transform.x,
        y: transform.y,
        scale: transform.scale,
        rotation: transform.rotation,
      };
      imageCount++;
    } else textCount++;
    let frame: StampText["frame"];
    if (style.frame !== undefined) {
      const box = object(style.frame);
      if (!box || !number(box.width, 4, 100) || !number(box.height, 4, 100))
        return;
      frame = { width: box.width, height: box.height };
    }
    let background: StampText["background"];
    if (style.background !== undefined) {
      const bg = object(style.background);
      if (
        !bg ||
        !color(bg.color) ||
        !number(bg.alpha, 0, 100) ||
        !number(bg.padding, 0, 50) ||
        !number(bg.radius, 0, 50)
      )
        return;
      background = {
        color: bg.color,
        alpha: bg.alpha,
        padding: bg.padding,
        radius: bg.radius,
      };
    }
    const missing = !FONTS.has(style.font);
    if (missing && !/^StampMakerLocal[0-9a-f-]{36}$/iu.test(style.font)) return;
    const localFontLabel =
      string(layer.localFontLabel, 180) && layer.localFontLabel
        ? layer.localFontLabel
        : undefined;
    if (missing && !localFontLabel) return;
    ids.add(layer.id);
    layers.push({
      id: layer.id,
      image,
      colorCharacter: layer.colorCharacter,
      backgroundCharacter: layer.backgroundCharacter,
      colorWasChosen: layer.colorWasChosen,
      localFontLabel,
      settings: {
        text: style.text,
        x: style.x,
        y: style.y,
        size: style.size,
        rotation: style.rotation,
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        font: missing ? "auto" : style.font,
        weight: missing ? 900 : style.weight,
        writingMode: style.writingMode as StampText["writingMode"],
        background,
        frame,
      },
    });
  }
  if (
    !ids.has(input.activeLayerId) ||
    textCount < 1 ||
    textCount > 12 ||
    imageCount > 1
  )
    return;
  if (input.version === 1) {
    const image = createStampImageLayer();
    let index = 0;
    image.id = "stamp-image";
    while (ids.has(image.id)) image.id = `stamp-image-${++index}`;
    layers.unshift(image);
  } else if (imageCount !== 1) return;
  return {
    schema: "haneoka-stamp-maker-draft",
    version: 2,
    savedAt: input.savedAt,
    server: input.server,
    selected: input.selected,
    resourceName: input.resourceName,
    imageLanguage: input.imageLanguage,
    activeLayerId: input.activeLayerId,
    layers,
  };
}

export function encodeStampDraft(
  input: Omit<StampDraft, "schema" | "version" | "savedAt">,
): string {
  const layers = input.layers.map((layer) => ({
    ...layer,
    localFontLabel: layer.settings.font.startsWith("StampMakerLocal")
      ? stampFont(layer.settings.font)?.label || layer.localFontLabel
      : layer.localFontLabel,
    settings: {
      ...layer.settings,
      background: layer.settings.background
        ? { ...layer.settings.background }
        : undefined,
    },
  }));
  const draft = {
    ...input,
    layers,
    schema: "haneoka-stamp-maker-draft",
    version: 2,
    savedAt: new Date().toISOString(),
  };
  const parsed = parseStampDraft(draft);
  if (!parsed) throw new Error("Invalid stamp draft");
  const encoded = JSON.stringify(parsed);
  if (encoded.length > MAX_DRAFT_LENGTH)
    throw new Error("Stamp draft too large");
  return encoded;
}
export function readStampDraft(): DraftRead {
  try {
    const raw =
      localStorage.getItem(STAMP_DRAFT_KEY) ??
      localStorage.getItem(LEGACY_DRAFT_KEY);
    if (raw === null) return { status: "empty" };
    if (raw.length > MAX_DRAFT_LENGTH) return { status: "invalid" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "invalid" };
    }
    const draft = parseStampDraft(parsed);
    return draft ? { status: "ready", draft } : { status: "invalid" };
  } catch {
    return { status: "unavailable" };
  }
}
export function writeStampDraft(
  input: Omit<StampDraft, "schema" | "version" | "savedAt">,
): void {
  localStorage.setItem(STAMP_DRAFT_KEY, encodeStampDraft(input));
  localStorage.removeItem(LEGACY_DRAFT_KEY);
}
export function clearStampDraft(): void {
  localStorage.removeItem(STAMP_DRAFT_KEY);
  localStorage.removeItem(LEGACY_DRAFT_KEY);
}
