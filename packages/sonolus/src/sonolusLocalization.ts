export type SonolusLocalization = "en" | "ja" | "ko" | "zhs" | "zht";

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

function localeFor(value: string | null | undefined): SonolusLocalization {
  switch (value) {
    case "ja":
    case "ko":
    case "zhs":
    case "zht":
    case "en":
      return value;
    default:
      return "en";
  }
}

function labelFor(labels: SonolusLocalizedLabels, locale: SonolusLocalization): string {
  const key = locale === "zhs" ? "zh-CN" : locale === "zht" ? "zh-TW" : locale;
  return labels[key] ?? labels.en ?? Object.values(labels)[0] ?? "";
}

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
      const itemLabel = typeof name === "string" ? itemLabels[name] : undefined;
      if (itemLabel) result.title = labelFor(itemLabel, locale);
    }
    return result;
  };

  return visit(document);
}
