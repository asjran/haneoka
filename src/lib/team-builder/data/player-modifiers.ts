import type { TeamBuilderData } from "../data";
import type { InventoryIssue } from "../inventory";

export interface PlayerModifiers {
  characterTotalRank: number | null;
  vipRank: number | null;
  /** Direct integer points per power component, keyed by native entity ID. */
  musicMemoryPoints: Record<string, number | null>;
  characterMemoryPoints: Record<string, number | null>;
}
export const MAX_MODIFIER_VALUE = 0x7fffffff;
export const MAX_MODIFIER_MAP_ENTRIES = 2048;
export const createUnknownPlayerModifiers = (): PlayerModifiers => ({
  characterTotalRank: null,
  vipRank: null,
  musicMemoryPoints: {},
  characterMemoryPoints: {},
});
export function playerModifierRanges(data: TeamBuilderData) {
  const thresholds = [...new Set((data.progression.characterTotalRanks ?? []).map((row) => row.totalRank))]
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    .sort((a, b) => a - b);
  const ranks = (data.progression.characterRanks ?? [])
    .map((row) => row.rank)
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const maximum = ranks.length ? Math.max(...ranks) * Object.keys(data.characters).length : null;
  const vipTable = data.runtimeRules?.tables.vipRanks;
  const vipRanks =
    data.runtimeRules?.status === "ready" && vipTable?.status === "ready"
      ? [...new Set(vipTable.rows.map((row) => row.vipRank))]
          .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
          .sort((a, b) => a - b)
      : [];
  return {
    characterTotalRank: {
      minimum: thresholds[0] ?? null,
      maximum: maximum !== null && maximum > 0 ? maximum : null,
      thresholds,
    },
    vipRanks,
    memoryPoints: { minimum: 0, maximum: MAX_MODIFIER_VALUE, status: "representation-only" as const },
  };
}
export function validatePlayerModifiers(value: unknown, data: TeamBuilderData, requireKnown = false): InventoryIssue[] {
  const issues: InventoryIssue[] = [];
  const problem = (field: string, code: string, values?: number[]) =>
    issues.push({ path: `playerModifiers${field ? "." + field : ""}`, code, ...(values ? { values } : {}) });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "playerModifiers", code: "invalid-modifiers" }];
  const row = value as Record<string, unknown>;
  const keys = ["characterTotalRank", "vipRank", "musicMemoryPoints", "characterMemoryPoints"];
  for (const key of Object.keys(row)) if (!keys.includes(key)) problem(key, "unknown-field");
  for (const key of keys) if (!Object.hasOwn(row, key)) problem(key, "missing-field");
  const scalar = (field: string, value: unknown): value is number => {
    if (value === null) {
      if (requireKnown) problem(field, "unknown-modifier");
      return false;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MODIFIER_VALUE) {
      problem(field, "out-of-representation-range");
      return false;
    }
    return true;
  };
  const ranges = playerModifierRanges(data);
  if (scalar("characterTotalRank", row.characterTotalRank)) {
    const { minimum, maximum } = ranges.characterTotalRank;
    if (minimum !== null && maximum !== null) {
      if (row.characterTotalRank < minimum || row.characterTotalRank > maximum)
        problem("characterTotalRank", "out-of-native-range");
    } else if (requireKnown) problem("characterTotalRank", "native-modifier-domain-unavailable");
  }
  if (scalar("vipRank", row.vipRank)) {
    if (row.vipRank === 0) problem("vipRank", "out-of-representation-range");
    else if (ranges.vipRanks.length) {
      if (!ranges.vipRanks.includes(row.vipRank)) problem("vipRank", "out-of-native-range", ranges.vipRanks);
    } else if (requireKnown) problem("vipRank", "native-modifier-domain-unavailable");
  }
  for (const field of ["musicMemoryPoints", "characterMemoryPoints"] as const) {
    const map = row[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      problem(field, "invalid-modifier-map");
      continue;
    }
    if (Object.keys(map).length > MAX_MODIFIER_MAP_ENTRIES) {
      problem(field, "too-many-modifiers");
      continue;
    }
    const entities = field === "musicMemoryPoints" ? data.songs : data.characters;
    for (const [id, points] of Object.entries(map)) {
      if (!/^[1-9]\d{0,9}$/u.test(id) || Number(id) > MAX_MODIFIER_VALUE || !Object.hasOwn(entities, id))
        problem(`${field}.${id}`, "unknown-entity");
      scalar(`${field}.${id}`, points);
    }
  }
  return issues;
}
