import type { DataRow } from "../data";

export interface EventBonusRule {
  id: number;
  kind: "points" | "items" | "power" | "unknown";
  resourceTypeConstraint: number;
  memberCardId: number;
  supportCardId: number;
  characterId: number;
  bandId: number;
  attribute: number;
  tagId: number;
  perRank: { rank: number; basisPoints: number | null }[];
  sourceTable: string;
}
export interface EventBonusSubject {
  resourceType: 2 | 3;
  cardId: number;
  characterId: number | null;
  bandId: number | null;
  attribute: number | null;
  tagIds: number[] | null;
  rank: number | null;
}
/** Null preserves an unknown match/value; this is a table join, not an event payout formula. */
export function eventBonusBasisPoints(rules: readonly EventBonusRule[], subject: EventBonusSubject): number | null {
  let total = 0;
  for (const rule of rules) {
    if (rule.resourceTypeConstraint !== 2 && rule.resourceTypeConstraint !== 3) return null;
    if (rule.resourceTypeConstraint !== subject.resourceType) continue;
    const card = subject.resourceType === 2 ? rule.memberCardId : rule.supportCardId;
    if (card && card !== subject.cardId) continue;
    const checks: [[number, number | null], [number, number | null], [number, number | null]] = [
      [rule.characterId, subject.characterId],
      [rule.bandId, subject.bandId],
      [rule.attribute, subject.attribute],
    ];
    let mismatch = false,
      unknown = false;
    for (const [required, actual] of checks)
      if (required) {
        if (actual === null) unknown = true;
        else if (required !== actual) mismatch = true;
      }
    if (rule.tagId) {
      if (subject.tagIds === null) unknown = true;
      else if (!subject.tagIds.includes(rule.tagId)) mismatch = true;
    }
    if (mismatch) continue;
    if (unknown || subject.rank === null) return null;
    const value = rule.perRank.find((row) => row.rank === subject.rank)?.basisPoints;
    if (value === null || value === undefined) return null;
    total += value;
  }
  return total;
}
/** Detail support tables retain their native groups; challenge never becomes live reward. */
export function projectEventDetail(row: DataRow): DataRow {
  const effects = Array.isArray(row.effects) ? (row.effects as DataRow[]) : [];
  const rules = effects.map((effect): EventBonusRule => {
    const bonusType = Number(effect.eventBonusType ?? effect.bonusType);
    const ranks = Array.isArray(effect.perRank)
      ? (effect.perRank as DataRow[])
      : [1, 2, 3, 4, 5].map((rank) => ({ rank, value: effect[`rank${rank}EffectValue`] }));
    return {
      id: Number(effect.id ?? effect.sourceId),
      kind: ({ 0: "points", 1: "items", 2: "power" } as const)[bonusType as 0 | 1 | 2] ?? "unknown",
      resourceTypeConstraint: Number(effect.resourceTypeConstraint),
      memberCardId: Number(effect.memberCardId ?? 0),
      supportCardId: Number(effect.supportCardId ?? 0),
      characterId: Number(effect.characterId ?? 0),
      bandId: Number(effect.bandId ?? 0),
      attribute: Number(effect.cardType ?? 0),
      tagId: Number(effect.tagId ?? 0),
      perRank: ranks.map((rank) => ({
        rank: Number(rank.rank),
        basisPoints: typeof rank.value === "number" && Number.isFinite(rank.value) ? rank.value : null,
      })),
      sourceTable: String(effect.sourceTable ?? "MasterEventEffect"),
    };
  });
  const support =
    row.support && typeof row.support === "object" && !Array.isArray(row.support) ? (row.support as DataRow) : {};
  return {
    ...row,
    detailStatus: Array.isArray(row.effects) && Object.keys(support).length ? "loaded" : "summary-or-partial",
    bonusRules: {
      points: rules.filter((rule) => rule.kind === "points"),
      items: rules.filter((rule) => rule.kind === "items"),
      power: rules.filter((rule) => rule.kind === "power"),
      unknown: rules.filter((rule) => rule.kind === "unknown"),
    },
    tables: support,
  };
}
