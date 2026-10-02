import type { EvidenceGap, TeamAssignment } from "../contracts";
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";
import { validateInventory, type Inventory } from "../inventory";
import type {
  BoostBonusRow,
  EventMember,
  EventSnapshot,
  NativeEventEffect,
  SelectedEventReward,
} from "../solver/event-rewards";
import type { NativeScoreRankRow } from "../solver/score-ranks";

const int32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const integerFields = (row: DataRow, fields: readonly string[]) => fields.every((field) => int32(row[field]));
export interface NativeRewardResourceRow extends SelectedEventReward {
  scoreRank: number;
  probability: number;
  rewardGroup: number;
  eventGroup: number;
}

/** Field translation only. Held-event selection, native rank calculation,
 * reward selection and all arithmetic belong to the runtime factory.
 */
export function nativeRewardSources(data: TeamBuilderData, songId: number | null) {
  const gaps: EvidenceGap[] = [];
  const gap = (source: string, code = "native-reward-source-unavailable") => gaps.push({ source, code });
  const read = (value: unknown, source: string) => {
    if (!Array.isArray(value)) {
      gap(source);
      return [];
    }
    return dataRows(value).map(nativeRow);
  };
  const boostRows = (mode: "normal" | "challenge"): BoostBonusRow[] => {
    const source = mode === "normal" ? "MasterLiveMusicBoostBonus" : "MasterChallengeMusicBoostBonus";
    const count = mode === "normal" ? "consumedLiveBoostCount" : "consumedChallengePointCount";
    const rows = read(data.liveTools[mode === "normal" ? "liveBoostBonuses" : "challengeBoostBonuses"], source);
    return rows.flatMap((row) => {
      if (
        !integerFields(row, [
          count,
          "liveMusicRewardRate",
          "playerExpRate",
          "memberCardExpRate",
          "friendshipExpRate",
          "eventPointRate",
        ])
      ) {
        gap(source, "native-reward-source-malformed");
        return [];
      }
      return [
        {
          consumedCount: row[count] as number,
          rewardRate: row.liveMusicRewardRate as number,
          playerExpRate: row.playerExpRate as number,
          memberExpRate: row.memberCardExpRate as number,
          friendshipExpRate: row.friendshipExpRate as number,
          eventPointRate: row.eventPointRate as number,
        },
      ];
    });
  };
  const normalBoostRows = boostRows("normal"),
    challengeBoostRows = boostRows("challenge");
  let scoreRankRows: NativeScoreRankRow[] = [];
  if (songId !== null) {
    const group = data.songs[String(songId)]?.liveScoreRankGroup;
    if (!int32(group) || group <= 0) gap(`song:${songId}/liveScoreRankGroup`);
    else
      scoreRankRows = read(data.liveTools.scoreRanks, "MasterLiveScoreRank")
        .filter((row) => row.group === group)
        .flatMap((row) => {
          if (!integerFields(row, ["liveScoreRank", "requiredScore", "battleLiveRequiredScore"])) {
            gap("MasterLiveScoreRank", "native-reward-source-malformed");
            return [];
          }
          return [
            {
              rank: row.liveScoreRank as number,
              requiredScore: row.requiredScore as number,
              battleRequiredScore: row.battleLiveRequiredScore as number,
            },
          ];
        });
    if (!scoreRankRows.length) gap(`song:${songId}/MasterLiveScoreRank`, "native-score-rank-group-missing");
  }
  const events = Object.fromEntries(
    Object.entries(data.events).map(([id, event]) => {
      const tables = objectRow(event.tables),
        groups = objectRow(event.rewardGroups);
      const effects: NativeEventEffect[] = read(tables.MasterEventEffect, `event:${id}/MasterEventEffect`).flatMap(
        (row) => {
          const fields = [
            "eventId",
            "eventBonusType",
            "resourceTypeConstraint",
            "characterId",
            "bandId",
            "cardType",
            "tagId",
            "memberCardId",
            "supportCardId",
            ...[1, 2, 3, 4, 5].map((rank) => `rank${rank}EffectValue`),
          ];
          if (
            !integerFields(row, fields) ||
            ![0, 1, 2].includes(row.eventBonusType as number) ||
            String(row.eventId) !== id
          ) {
            gap(`event:${id}/MasterEventEffect`, "native-reward-source-malformed");
            return [];
          }
          return [
            {
              eventId: row.eventId as number,
              bonusType: row.eventBonusType as 0 | 1 | 2,
              resourceTypeConstraint: row.resourceTypeConstraint as number,
              characterId: row.characterId as number,
              bandId: row.bandId as number,
              cardType: row.cardType as number,
              tagId: row.tagId as number,
              memberCardId: row.memberCardId as number,
              supportCardId: row.supportCardId as number,
              rankValues: [1, 2, 3, 4, 5].map(
                (rank) => row[`rank${rank}EffectValue`] as number,
              ) as NativeEventEffect["rankValues"],
            },
          ];
        },
      );
      const pointRows = (table: string, field: string) => {
        const group = groups[field];
        if (!int32(group) || group <= 0) {
          gap(`event:${id}/${field}`);
          return [];
        }
        return read(tables[table], `event:${id}/${table}`)
          .filter((row) => row.group === group)
          .flatMap((row) => {
            if (!integerFields(row, ["scoreRank", "value"])) {
              gap(table, "native-reward-source-malformed");
              return [];
            }
            return [{ scoreRank: row.scoreRank as number, value: row.value as number }];
          });
      };
      const itemRows = (table: string, field: string): NativeRewardResourceRow[] => {
        const group = groups[field];
        if (!int32(group) || group <= 0) {
          gap(`event:${id}/${field}`);
          return [];
        }
        // Reward rows use eventGroup; their group is the lottery/reward subgroup.
        return read(tables[table], `event:${id}/${table}`)
          .filter((row) => row.eventGroup === group)
          .flatMap((row) => {
            if (
              !integerFields(row, [
                "id",
                "resourceType",
                "resourceId",
                "resourceCount",
                "scoreRank",
                "probability",
                "group",
                "eventGroup",
              ])
            ) {
              gap(table, "native-reward-source-malformed");
              return [];
            }
            return [
              {
                rewardId: row.id as number,
                resourceType: row.resourceType as number,
                resourceId: row.resourceId as number,
                count: row.resourceCount as number,
                scoreRank: row.scoreRank as number,
                probability: row.probability as number,
                rewardGroup: row.group as number,
                eventGroup: row.eventGroup as number,
              },
            ];
          });
      };
      return [
        id,
        {
          effects,
          normalPointRows: pointRows("MasterLiveEventPoint", "liveEventPoint"),
          challengePointRows: pointRows("MasterChallengeLiveEventPoint", "challengeLiveEventPoint"),
          normalItemRows: itemRows("MasterLiveEventReward", "liveEventReward"),
          challengeItemRows: itemRows("MasterChallengeLiveEventReward", "challengeLiveEventReward"),
          timing: { startAt: event.startAt, endAt: event.endAt, displayEndAt: event.displayEndAt },
        },
      ] as const;
    }),
  );
  return { identity: { ...data.identity }, normalBoostRows, challengeBoostRows, scoreRankRows, events, gaps };
}

/** Prepare once per immutable solver input; resolve only the chosen slots.
 * Recreate after inventory/data changes. Profiles are cached by instance.
 */
export function createNativeEventSubjectResolver(data: TeamBuilderData, inventory: Inventory) {
  const checked = validateInventory(inventory, data);
  if (!checked.valid) throw new Error(`Invalid event inventory:${checked.issues[0]?.path}`);
  const identity = { ...data.identity };
  const memberStates = new Map(inventory.members.map((state) => [state.instanceId, { ...state }]));
  const snapshotStates = new Map(inventory.snapshots.map((state) => [state.instanceId, { ...state }]));
  const locked = new Set<string>();
  for (const states of [memberStates, snapshotStates])
    for (const state of states.values()) if (state.locked) locked.add(state.instanceId);
  const memberCache = new Map<string, { subject: EventMember | null; gaps: EvidenceGap[] }>();
  const snapshotCache = new Map<string, { subject: EventSnapshot | null; gaps: EvidenceGap[] }>();
  const memberProfile = (id: string) => {
    const cached = memberCache.get(id);
    if (cached) return cached;
    const gaps: EvidenceGap[] = [];
    const gap = (code: string) => gaps.push({ code, source: id });
    const state = memberStates.get(id),
      card = state ? data.members[String(state.cardId)] : undefined;
    if (
      !state ||
      !card ||
      state.awakening === null ||
      !Array.isArray(card.bestMusicTagIds) ||
      !int32(card.attribute) ||
      !int32(card.characterId) ||
      state.awakening < 1 ||
      state.awakening > 5
    ) {
      gap("event-member-input-unresolved");
      return { subject: null, gaps };
    }
    const bandId = Object.hasOwn(data.bands, String(card.bandId)) ? card.bandId : null;
    if (bandId === null) gap("event-member-band-unresolved");
    const subject: EventMember = {
      cardId: card.id,
      characterId: card.characterId,
      bandId,
      cardType: card.attribute,
      musicTagIds: [...card.bestMusicTagIds],
      rank: state.awakening,
    };
    const result = { subject, gaps };
    memberCache.set(id, result);
    return result;
  };
  const snapshotProfile = (id: string) => {
    const cached = snapshotCache.get(id);
    if (cached) return cached;
    const gaps: EvidenceGap[] = [];
    const gap = (code: string) => gaps.push({ code, source: id });
    const state = snapshotStates.get(id),
      card = state ? data.snapshots[String(state.cardId)] : undefined;
    if (
      !state ||
      !card ||
      state.awakening === null ||
      !Array.isArray(card.characterIds) ||
      !int32(card.attribute) ||
      state.awakening < 1 ||
      state.awakening > 5
    ) {
      gap("event-snapshot-input-unresolved");
      return { subject: null, gaps };
    }
    const bands = card.characterIds.map((characterId) => data.characters[String(characterId)]?.bandId);
    if (bands.some((band) => !int32(band) || !Object.hasOwn(data.bands, String(band)))) {
      gap("event-snapshot-band-unresolved");
      return { subject: null, gaps };
    }
    const subject: EventSnapshot = {
      cardId: card.id,
      characterIds: [...card.characterIds],
      bandIds: [...new Set(bands as number[])],
      cardType: card.attribute,
      rank: state.awakening,
    };
    const result = { subject, gaps };
    snapshotCache.set(id, result);
    return result;
  };
  return {
    identity,
    resolve(assignment: TeamAssignment) {
      const gaps: EvidenceGap[] = [];
      const gap = (code: string, source: string) => gaps.push({ code, source });
      const used = new Set<string>();
      let selectedLocked = 0;
      const select = (id: string, excluded: boolean | undefined) => {
        if (excluded === undefined || excluded || used.has(id)) gap("missing-excluded-or-reused-instance", id);
        if (!used.has(id) && locked.has(id)) selectedLocked++;
        used.add(id);
      };
      const members = assignment.memberInstanceIds.map((id) => {
        select(id, memberStates.get(id)?.excluded);
        const profile = memberProfile(id);
        gaps.push(...profile.gaps);
        return profile.subject;
      });
      const snapshots = assignment.snapshotInstanceIds.map((id) => {
        if (id === null) return null;
        select(id, snapshotStates.get(id)?.excluded);
        const profile = snapshotProfile(id);
        gaps.push(...profile.gaps);
        return profile.subject;
      });
      if (members.length !== snapshots.length) gap("slot-count-mismatch", "assignment");
      if (!assignment.memberInstanceIds.includes(assignment.leaderInstanceId))
        gap("leader-not-in-team", "leaderInstanceId");
      if (selectedLocked !== locked.size) gap("locked-instance-missing", "assignment");
      return { identity: { ...identity }, members, snapshots, gaps };
    },
  };
}

/** Convenience for a single assignment. The solver uses the prepared resolver. */
export function nativeEventSubjects(data: TeamBuilderData, inventory: Inventory, assignment: TeamAssignment) {
  return createNativeEventSubjectResolver(data, inventory).resolve(assignment);
}
