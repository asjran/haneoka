import type { EvidenceGap, TeamAssignment } from "../contracts.ts";
import type { TeamBuilderData } from "../data.ts";
import { createNativeEventSubjectResolver, nativeRewardSources } from "../data/reward-input.ts";
import type { Inventory } from "../inventory.ts";
import { sumEventEffectBP, type EventMember, type EventSnapshot, type NativeEventEffect } from "./event-rewards.ts";

export interface PreparedCardEventBonus {
  /** Point, item and power bonus types, in native enum order. */
  values: [number | null, number | null, number | null];
  gaps: EvidenceGap[];
}
export interface AssignmentEventBonus {
  pointBonusBP: number | null;
  itemBonusBP: number | null;
  /** Power bonuses belong to each corresponding slot, before its native floor. */
  memberPowerBonusBP: (number | null)[];
  snapshotPowerBonusBP: (number | null)[];
  gaps: EvidenceGap[];
}

function cardBonus(
  id: string,
  effects: readonly NativeEventEffect[],
  member: EventMember | null,
  snapshot: EventSnapshot | null,
  gaps: EvidenceGap[],
): PreparedCardEventBonus {
  if (gaps.length || (!member && !snapshot)) return { values: [null, null, null], gaps: [...gaps] };
  const values: PreparedCardEventBonus["values"] = [null, null, null];
  for (const type of [0, 1, 2] as const) {
    try {
      values[type] = sumEventEffectBP(effects, [member], [snapshot], type);
    } catch (error) {
      // The native matcher can require an unresolved band/rank. Keep that
      // instance unresolved without re-reading its inventory in every candidate.
      gaps = [...gaps, { code: error instanceof Error ? error.message : "event-bonus-input", source: id }];
    }
  }
  return { values, gaps };
}

/** Immutable per-run preparation: full inventory validation/conversion and all
 * Master effect matching happen here. Candidate resolution reads selected slots.
 * Held-event selection is supplied by the native live-start context, separately.
 */
export function createNativeEventBonusResolver(data: TeamBuilderData, inventory: Inventory) {
  const subjects = createNativeEventSubjectResolver(data, inventory);
  const sources = nativeRewardSources(data, null);
  const events = new Map(
    Object.entries(sources.events).map(([id, event]) => [
      Number(id),
      {
        gaps: sources.gaps.filter((gap) => gap.source === `event:${id}/MasterEventEffect`),
        members: new Map(
          [...subjects.memberById].map(([key, profile]) => [
            key,
            cardBonus(key, event.effects, profile.subject, null, profile.gaps),
          ]),
        ),
        snapshots: new Map(
          [...subjects.snapshotById].map(([key, profile]) => [
            key,
            cardBonus(key, event.effects, null, profile.subject, profile.gaps),
          ]),
        ),
      },
    ]),
  );
  return {
    identity: { ...subjects.identity },
    sources,
    resolve(eventId: number, assignment: TeamAssignment): AssignmentEventBonus {
      const event = events.get(eventId);
      const gaps: EvidenceGap[] = [];
      const missing = (id: string): PreparedCardEventBonus => ({
        values: [null, null, null],
        gaps: [{ code: "event-bonus-instance-missing", source: id }],
      });
      if (!event) gaps.push({ code: "event-bonus-event-missing", source: String(eventId) });
      else gaps.push(...event.gaps);
      const members = assignment.memberInstanceIds.map((id) => event?.members.get(id) ?? missing(id));
      const snapshots = assignment.snapshotInstanceIds.map((id) =>
        id === null
          ? { values: [0, 0, 0] as PreparedCardEventBonus["values"], gaps: [] }
          : (event?.snapshots.get(id) ?? missing(id)),
      );
      for (const profile of [...members, ...snapshots]) gaps.push(...profile.gaps);
      const sum = (type: 0 | 1): number | null => {
        if (!event || event.gaps.length || members.length !== snapshots.length) return null;
        let total = 0;
        for (const profile of [...members, ...snapshots]) {
          const value = profile.values[type];
          if (value === null) return null;
          total = (total + value) | 0;
        }
        return total;
      };
      if (members.length !== snapshots.length) gaps.push({ code: "slot-count-mismatch", source: "assignment" });
      return {
        pointBonusBP: sum(0),
        itemBonusBP: sum(1),
        memberPowerBonusBP: members.map((profile) => (event?.gaps.length ? null : profile.values[2])),
        snapshotPowerBonusBP: snapshots.map((profile) => (event?.gaps.length ? null : profile.values[2])),
        gaps,
      };
    },
  };
}
