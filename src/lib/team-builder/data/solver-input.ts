import type { EvidenceGap, MemberOption, PowerStats, SnapshotOption } from "../contracts";
import { nativeSnapshotEquipRuleKnown, type MemberCatalog, type SnapshotCatalog, type TeamBuilderData } from "../data";
import {
  snapshotSkillLevels,
  validateInventory,
  type InventoryV1,
  type MemberEntry,
  type SnapshotEntry,
} from "../inventory";

/** Native formula owner supplies power; adapter never substitutes a max-trained value. */
export interface PowerResolver {
  member(
    card: MemberCatalog,
    state: MemberEntry,
    data: TeamBuilderData,
  ): { stats: PowerStats | null; bpPower?: PowerStats; gaps: EvidenceGap[] };
  snapshot(
    card: SnapshotCatalog,
    state: SnapshotEntry,
    data: TeamBuilderData,
  ): { stats: PowerStats | null; bonusBP?: PowerStats; gaps: EvidenceGap[] };
}
export function inventoryOptions(
  inventory: InventoryV1,
  data: TeamBuilderData,
  resolver: PowerResolver,
): {
  members: MemberOption[];
  snapshots: SnapshotOption[];
  gaps: EvidenceGap[];
} {
  const validation = validateInventory(inventory, data);
  if (!validation.valid)
    throw new Error(`Invalid inventory: ${validation.issues.map((issue) => issue.path).join(",")}`);
  const members: MemberOption[] = [],
    snapshots: SnapshotOption[] = [],
    gaps: EvidenceGap[] = [];
  const validStats = (stats: PowerStats | null): stats is PowerStats =>
    !!stats && Object.values(stats).every((value) => Number.isFinite(value) && value >= 0);
  for (const state of inventory.members) {
    if (state.excluded) continue;
    if (
      [state.level, state.training, state.awakening, state.liveSkillLevel, state.gekisoSkillLevel].some(
        (value) => value === null,
      )
    ) {
      gaps.push({ code: "unknown-member-practice", source: state.instanceId });
      continue;
    }
    const card = data.members[String(state.cardId)];
    if (!card) {
      gaps.push({ code: "unknown-member-card", source: state.instanceId });
      continue;
    }
    const power = resolver.member(card, state, data);
    gaps.push(...power.gaps);
    if (!validStats(power.stats)) {
      gaps.push({ code: "unresolved-member-power", source: state.instanceId });
      continue;
    }
    members.push({
      instanceId: state.instanceId,
      cardId: state.cardId,
      characterId: card.characterId,
      bandId: card.bandId,
      attribute: card.attribute,
      stats: power.stats,
      liveSkillId: card.liveSkillId,
      liveSkillLevel: state.liveSkillLevel!,
      gekisoSkillId: card.gekisoSkillId,
      gekisoSkillLevel: state.gekisoSkillLevel!,
      gaps: power.gaps,
    });
    const rank = (data.progression.memberCardRanks || []).find(
      (row) => Number(row.group) === card.awakeningGroup && Number(row.rank) === state.awakening,
    );
    const option = members.at(-1)!;
    option.leaderSkillId = card.leaderSkillId;
    option.leaderSkillLevel = Number(rank?.leaderSkillLevel);
    if (power.bpPower) option.bpPower = power.bpPower;
  }
  for (const state of inventory.snapshots) {
    if (state.excluded) continue;
    if (state.level === null || state.awakening === null) {
      gaps.push({ code: "unknown-snapshot-practice", source: state.instanceId });
      continue;
    }
    const card = data.snapshots[String(state.cardId)];
    if (!card) {
      gaps.push({ code: "unknown-snapshot-card", source: state.instanceId });
      continue;
    }
    const power = resolver.snapshot(card, state, data);
    gaps.push(...power.gaps);
    if (!validStats(power.stats)) {
      gaps.push({ code: "unresolved-snapshot-power", source: state.instanceId });
      continue;
    }
    const rank = (data.progression.supportCardRanks || []).find(
      (row) => Number(row.group) === card.awakeningGroup && Number(row.rank) === state.awakening,
    );
    if (!rank) {
      gaps.push({ code: "missing-snapshot-rank", source: state.instanceId });
      continue;
    }
    const skills = snapshotSkillLevels(data, state.cardId, state.awakening);
    if ([...skills.support, ...skills.gekisoSupport].some((skill) => skill.level === null)) {
      gaps.push({ code: "missing-snapshot-skill-rank-field", source: state.instanceId });
      continue;
    }
    snapshots.push({
      instanceId: state.instanceId,
      cardId: state.cardId,
      stats: power.stats,
      supportSkillId: card.supportSkillIds[0] || 0,
      supportSkillLevel: skills.support[0]?.level ?? 0,
      gekisoSupportSkillId: card.gekisoSupportSkillIds[0] || 0,
      gekisoSupportSkillLevel: skills.gekisoSupport[0]?.level ?? 0,
      gaps: [
        ...power.gaps,
        ...(!nativeSnapshotEquipRuleKnown(data.identity)
          ? [
              {
                code: "native-snapshot-equip-restriction-unverified",
                source: "formal Intl support equip rule not established for this source",
              },
            ]
          : []),
      ],
    });
    const option = snapshots.at(-1)!;
    if (nativeSnapshotEquipRuleKnown(data.identity))
      option.allowedCharacterIds = Object.keys(data.characters).map(Number);
    option.supportSkills = skills.support.map((skill) => ({ id: skill.id, level: skill.level! }));
    option.gekisoSupportSkills = skills.gekisoSupport.map((skill) => ({ id: skill.id, level: skill.level! }));
    if (power.bonusBP) option.bonusBP = power.bonusBP;
  }
  return { members, snapshots, gaps };
}
