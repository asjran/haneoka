import type { EvidenceGap, NativeEventScene } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import { nativeRewardSources } from "../data/reward-input.ts";

/** MasterEvent.GetEventStatus uses start>now and end>now: start is inclusive,
 * end exclusive. An unset native end leaves the held state open indefinitely.
 * Dates here are the producer's JST-parsed UTC millisecond projection.
 */
export function validateNativeEventScene(data: TeamBuilderData, scene: NativeEventScene): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const gap = (code: string, source: string) => gaps.push({ code, source });
  const int = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
  if (data.identity.server !== "intl" || !/^v\d+-c0b6a1541e45-/u.test(data.identity.sourceId ?? ""))
    gap("native-event-source-unverified", data.identity.sourceId ?? data.identity.server);
  if (
    !int(scene.eventId) ||
    scene.eventId < 1 ||
    !["normal", "challenge"].includes(scene.kind) ||
    !int(scene.consumedCount) ||
    scene.consumedCount < 1 ||
    !int(scene.masterTimeSlot) ||
    scene.masterTimeSlot < 0 ||
    scene.masterTimeSlot > 4
  )
    gap("native-event-scene-unresolved", "event/kind/consumption/Master time slot");
  if (!Array.isArray(scene.heldEventIds) || scene.heldEventIds.length !== 1 || scene.heldEventIds[0] !== scene.eventId)
    gap("native-event-single-held-context-required", "complete native held-event list");
  const clock = scene.liveStartServerTime;
  if (
    !clock ||
    !int(clock.epochMilliseconds) ||
    clock.epochMilliseconds < 0 ||
    !["game-server", "explicit-scenario"].includes(clock.source) ||
    typeof clock.reference !== "string" ||
    !clock.reference
  )
    gap("native-live-start-server-time-unresolved", "observed start or identified replay scenario");
  const event = data.events[String(scene.eventId)];
  if (!event) gap("native-held-event-row-missing", String(scene.eventId));
  else if (clock && int(clock.epochMilliseconds)) {
    const value = (field: string) => (Array.isArray(event[field]) ? event[field][scene.masterTimeSlot] : event[field]);
    const start = value("startAt"),
      end = value("endAt");
    if (!int(start) || (end !== null && (!int(end) || end < start)))
      gap("native-event-time-column-unresolved", String(scene.eventId));
    else if (clock.epochMilliseconds < start || (end !== null && clock.epochMilliseconds >= end))
      gap("native-event-not-held-at-live-start", String(scene.eventId));
  }
  if (scene.kind === "normal" || scene.kind === "challenge") {
    const availability = nativeRewardSources(data, null).boostTableAvailability[scene.kind];
    if (availability.status !== "ready") gaps.push(...availability.gaps);
    const key = scene.kind === "normal" ? "liveBoostBonuses" : "challengeBoostBonuses";
    const field = scene.kind === "normal" ? "consumedLiveBoostCount" : "consumedChallengePointCount";
    if (
      !Array.isArray(data.liveTools[key]) ||
      !dataRows(data.liveTools[key])
        .map(nativeRow)
        .some((row) => row[field] === scene.consumedCount) ||
      (scene.kind === "challenge" && scene.consumedCount < 1)
    )
      gap("native-event-configured-consumption-unresolved", `${scene.kind}:${scene.consumedCount}`);
  }
  return gaps;
}
