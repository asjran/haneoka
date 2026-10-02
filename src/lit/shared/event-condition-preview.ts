import type { TeamBuilderData } from "../../lib/team-builder/data";
import type { InventoryV1 } from "../../lib/team-builder/inventory";
import { createNativeEventSubjectResolver, nativeRewardSources } from "../../lib/team-builder/data/reward-input";
import { sumEventEffectBP } from "../../lib/team-builder/solver/event-rewards";
import { getTeamBuilderCapabilities } from "../../lib/team-builder/solver/capabilities";

export type EventBonusAxis = "points" | "items" | "power";
export type EventCardBonuses = Record<EventBonusAxis, number | null>;
const unknown = (): EventCardBonuses => ({ points: null, items: null, power: null });

/** A selected-event condition preview. Reward ranking and held-event selection remain with the Worker factory. */
export function createEventConditionPreview(data: TeamBuilderData, inventory: InventoryV1) {
  const sources = nativeRewardSources(data, null);
  const subjects = createNativeEventSubjectResolver(data, inventory);
  const cache = new Map<string, EventCardBonuses>();
  const verifiedSource = getTeamBuilderCapabilities(data.identity).targets.some(
    (target) => target.mode === "normal" && target.objective === "event-points" && target.supported,
  );
  return {
    sources,
    bonus(eventId: string, kind: "members" | "snapshots", instanceId: string): EventCardBonuses {
      const key = JSON.stringify([eventId, kind, instanceId]);
      const known = cache.get(key);
      if (known) return known;
      const event = sources.events[eventId];
      const profile = kind === "members" ? subjects.memberById.get(instanceId) : subjects.snapshotById.get(instanceId);
      if (
        !verifiedSource ||
        data.events[eventId]?.detailStatus !== "loaded" ||
        !event ||
        !profile?.subject ||
        profile.gaps.length ||
        sources.gaps.some((gap) => gap.source === `event:${eventId}/MasterEventEffect`)
      )
        return unknown();
      try {
        const member = kind === "members" ? subjects.memberById.get(instanceId)?.subject : null;
        const snapshot = kind === "snapshots" ? subjects.snapshotById.get(instanceId)?.subject : null;
        const result: EventCardBonuses = {
          points: sumEventEffectBP(event.effects, [member ?? null], [snapshot ?? null], 0),
          items: sumEventEffectBP(event.effects, [member ?? null], [snapshot ?? null], 1),
          power: sumEventEffectBP(event.effects, [member ?? null], [snapshot ?? null], 2),
        };
        cache.set(key, result);
        return result;
      } catch {
        return unknown();
      }
    },
  };
}
