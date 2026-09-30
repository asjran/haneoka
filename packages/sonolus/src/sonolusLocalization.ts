import { TextFunction } from "@sonolus/core";

export type SonolusLocalization = string;

export type SonolusLocalizedLabels = Readonly<Record<string, string>>;

type SonolusStringLabelMap = Readonly<Record<string, SonolusLocalizedLabels>>;
type SonolusNumericLabelMap = Readonly<Record<number, SonolusLocalizedLabels>>;

export type SonolusJsonPrimitive = boolean | null | number | string;
export type SonolusJsonValue = SonolusJsonPrimitive | readonly SonolusJsonValue[] | SonolusJsonObject;
export type SonolusJsonObject = { [key: string]: SonolusJsonValue };

const OUR_NOTES_EFFECT_ITEM_NAMES = Object.freeze({
  1: "ourNotesEffect",
  2: "ourNotesEffectSolid",
  3: "ourNotesEffectWood",
  4: "ourNotesEffectTyping",
} as const);

export interface OurNotesSonolusNativeLabels {
  readonly noteSkins: SonolusStringLabelMap;
  readonly laneSkins: SonolusStringLabelMap;
  readonly noteEffectSkins: SonolusStringLabelMap;
  readonly stages: SonolusNumericLabelMap;
  readonly noteSeGroups: SonolusNumericLabelMap;
}

export const OUR_NOTES_SONOLUS_ITEM_NAMES = Object.freeze({
  effect: OUR_NOTES_EFFECT_ITEM_NAMES[1],
  effects: OUR_NOTES_EFFECT_ITEM_NAMES,
  particle: "ourNotesParticle",
  skins: Object.freeze({
    skin001: "ourNotesSkin",
    skin002: "ourNotesSkin002",
    skin003: "ourNotesSkin003",
  }),
  stages: Object.freeze({
    0: "ourNotesBgStage",
    1: "ourNotesBgMyGO",
    2: "ourNotesBgAveMujica",
    3: "ourNotesBgMugendaiMewType",
    4: "ourNotesBgMillsage",
    5: "ourNotesBgIkkaDumbRock",
  }),
} as const);

function requiredLabel(
  labels: SonolusStringLabelMap | SonolusNumericLabelMap,
  key: string | number,
  source: string,
): SonolusLocalizedLabels {
  const label = Object.entries(labels).find(([entryKey]) => entryKey === String(key))?.[1];
  if (label === undefined || Object.values(label).some((value) => typeof value !== "string")) {
    throw new Error(`Missing ${source} label: ${key}`);
  }
  return label;
}

/**
 * Maps the native manifest's labels onto the stable Sonolus item IDs. The
 * label values stay in the central native package; this function only defines
 * the protocol-facing item-name projection once for builders and handlers.
 */
export function createOurNotesSonolusItemLabels(
  source: OurNotesSonolusNativeLabels,
): Readonly<Record<string, SonolusLocalizedLabels>> {
  const itemLabels: Record<string, SonolusLocalizedLabels> = {
    [OUR_NOTES_SONOLUS_ITEM_NAMES.particle]: requiredLabel(source.noteEffectSkins, "effect001", "note effect skin"),
    [OUR_NOTES_SONOLUS_ITEM_NAMES.skins.skin001]: requiredLabel(source.noteSkins, "skin001", "note skin"),
    [OUR_NOTES_SONOLUS_ITEM_NAMES.skins.skin002]: requiredLabel(source.noteSkins, "skin002", "note skin"),
    [OUR_NOTES_SONOLUS_ITEM_NAMES.skins.skin003]: requiredLabel(source.noteSkins, "skin003", "note skin"),
  };

  for (const group of [1, 2, 3, 4] as const) {
    const itemName = OUR_NOTES_SONOLUS_ITEM_NAMES.effects[group];
    itemLabels[itemName] = requiredLabel(source.noteSeGroups, group, "note SE group");
  }

  requiredLabel(source.laneSkins, "skin001", "lane skin");
  for (const stageId of [0, 1, 2, 3, 4, 5]) {
    itemLabels[OUR_NOTES_SONOLUS_ITEM_NAMES.stages[stageId as keyof typeof OUR_NOTES_SONOLUS_ITEM_NAMES.stages]] =
      requiredLabel(source.stages, String(stageId), "stage");
  }
  return Object.freeze(itemLabels);
}

function sonolusLocaleFor(value: string): SonolusLocalization | undefined {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "en":
    case "ja":
    case "ko":
    case "zhs":
    case "zht":
      return normalized;
  }

  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(value);
  } catch {
    return undefined;
  }

  switch (locale.language) {
    case "zh": {
      const script = locale.script?.toLowerCase();
      const region = locale.region?.toUpperCase();
      if (script === "hans") return "zhs";
      if (script === "hant") return "zht";
      if (script === "hans" || region === "CN" || region === "SG" || region === "MY") return "zhs";
      if (script === "hant" || region === "TW" || region === "HK" || region === "MO") return "zht";
      return locale.maximize().script === "Hant" ? "zht" : "zhs";
    }
    default:
      return locale.language;
  }
}

function localeFor(value: string | null | undefined): SonolusLocalization {
  return value === null || value === undefined ? "en" : (sonolusLocaleFor(value) ?? "en");
}

function normalizeSonolusLabels(labels: SonolusLocalizedLabels): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [label, value] of Object.entries(labels)) {
    if (typeof value !== "string") throw new Error(`Invalid localized text for ${label}`);
    const locale = sonolusLocaleFor(label);
    if (locale !== undefined && !(locale in normalized)) normalized[locale] = value;
  }
  return normalized;
}

/**
 * Encodes localized text using Sonolus 1.1.3+'s `##LOCALIZE` text function.
 * BCP47 labels are projected to the Sonolus locale codes used by this server.
 * The fallback locale is emitted first because the protocol uses the first
 * language when the player's language is absent. JSON.stringify supplies the
 * protocol's JSON quoting for quotes, newlines, backslashes, and controls.
 */
export function encodeSonolusLocalizedText(
  labels: SonolusLocalizedLabels,
  fallbackLocale: string | null | undefined = "en",
): string {
  const normalized = normalizeSonolusLabels(labels);
  const entries = Object.entries(normalized) as Array<[string, string]>;
  if (!entries.length) throw new Error("Localized text has no supported Sonolus locale");

  const fallback = fallbackLocale === null ? undefined : sonolusLocaleFor(fallbackLocale ?? "en");
  if (fallbackLocale !== null && fallback === undefined) {
    throw new Error(`Unsupported Sonolus fallback locale: ${fallbackLocale}`);
  }
  if (fallback !== undefined) {
    const index = entries.findIndex(([locale]) => locale === fallback);
    if (index > 0) {
      const [entry] = entries.splice(index, 1);
      entries.unshift(entry);
    }
  }

  return `${TextFunction.Localize}:${JSON.stringify(Object.fromEntries(entries))}`;
}

const CLIENT_LABELS: Readonly<Record<string, SonolusLocalizedLabels>> = {
  "GBP Charts": { en: "GBP Charts", ja: "GBP 譜面", "zh-CN": "GBP 谱面", "zh-TW": "GBP 譜面", ko: "GBP 채보" },
  "GBP Playlists": {
    en: "GBP Playlists",
    ja: "GBP プレイリスト",
    "zh-CN": "GBP 歌单",
    "zh-TW": "GBP 歌單",
    ko: "GBP 플레이리스트",
  },
};

/**
 * Localizes Sonolus JSON without introducing protocol-unsupported title
 * objects. Item titles are selected by their stable `name`; protocol text
 * tokens such as `#RANDOM` remain available for the Sonolus client. The input
 * is never mutated.
 */
export function localizeSonolusDocument(
  document: SonolusJsonValue,
  localization: string | null | undefined,
  itemLabels: Readonly<Record<string, SonolusLocalizedLabels>>,
): SonolusJsonValue {
  const locale = localeFor(localization);

  const visit = (value: SonolusJsonValue): SonolusJsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;

    const result: SonolusJsonObject = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, visit(entry)]),
    );
    const name = result.name;
    const title = result.title;
    if (typeof title === "string") {
      const itemLabel = (typeof name === "string" ? itemLabels[name] : undefined) ?? CLIENT_LABELS[title];
      if (itemLabel) result.title = encodeSonolusLocalizedText(itemLabel, locale);
    }
    return result;
  };

  return visit(document);
}
