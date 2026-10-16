export const UI_MARK_PROJECTION = 2;

/** Changes only the presentation version of official UI-mark requests. */
export function withUiMarksProjection(value: string): string {
  const url = new URL(value, "https://catalog.invalid");
  if (!/^\/api\/v1\/servers\/[^/]+\/ui-marks$/u.test(url.pathname)) return value;
  url.searchParams.set("projection", String(UI_MARK_PROJECTION));
  return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

export const UI_MARK_NAMES =
  /^(?:RarityIconCenter_(?:R|SR|SSR|EX|BD)|CardType-(?:Red|Blue|Green|Yellow|Purple)|CardRank[0-5]|snaplimit_[0-5]|SpecialTraining|sp_icon_live_music_type_(?:1|2|3|4|5|99))\.png$/u;

export function projectUiMarks(value: unknown): Record<string, string> {
  const outputs = value && typeof value === "object" && "outputs" in value ? value.outputs : null;
  if (!Array.isArray(outputs)) return {};
  const marks: Record<string, string> = {};
  for (const output of outputs) {
    if (!output || typeof output !== "object" || output.type !== "Sprite" || typeof output.path !== "string") continue;
    const filename = output.path.split("/").at(-1) || "";
    const logical = filename.replace(/--Sprite-?-?\d+\.png$/u, ".png");
    if (UI_MARK_NAMES.test(logical)) marks[logical] = output.path;
  }
  return marks;
}

export interface CardGrowthIcons {
  memberRanks: string[];
  supportRanks: string[];
  training: string;
}

export function cardGrowthIcons(mark: (name: string) => string): CardGrowthIcons {
  return {
    memberRanks: Array.from({ length: 6 }, (_, rank) => mark(`CardRank${rank}.png`)),
    supportRanks: Array.from({ length: 6 }, (_, rank) => mark(`snaplimit_${rank}.png`)),
    training: mark("SpecialTraining.png"),
  };
}
