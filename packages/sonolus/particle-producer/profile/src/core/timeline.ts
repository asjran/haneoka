import { TickConverter } from "@haneoka/cassiopeia";
import type {
  ChartCallChangeEvent,
  ChartFeverSection,
  ChartSkillEvent,
  ChartTimeline,
  SsRoot,
} from "@haneoka/cassiopeia";

/**
 * Builds normalized skill, fever, and call timelines. Skill order remains
 * source-stable, while fever and call entries are ordered by their first tick.
 */
export function buildChartTimeline(root: SsRoot, converter: TickConverter): ChartTimeline {
  const skills: ChartSkillEvent[] = root.skill.map((tick, index) => ({
    index,
    tick,
    timeMs: converter.tickToTimeMs(tick),
  }));

  const fever: ChartFeverSection[] = root.fever
    .map(([startTick, endTick], sourceIndex) => ({ startTick, endTick, sourceIndex }))
    .sort((left, right) => left.startTick - right.startTick || left.sourceIndex - right.sourceIndex)
    .map(({ startTick, endTick }, index) => ({
      index,
      startTick,
      endTick,
      startTimeMs: converter.tickToTimeMs(startTick),
      endTimeMs: converter.tickToTimeMs(endTick),
    }));

  const callChanges: ChartCallChangeEvent[] = root.call
    .map((call, sourceIndex) => ({ call, sourceIndex }))
    .sort((left, right) => left.call.t - right.call.t || left.sourceIndex - right.sourceIndex)
    .map(({ call }, index) => ({
      index,
      tick: call.t,
      timeMs: converter.tickToTimeMs(call.t),
      rhythms: Object.freeze(
        call.timing.flatMap((value, timingIndex) =>
          value === 1 ? [Math.fround((timingIndex + 1) / call.timing.length)] : [],
        ),
      ),
    }));

  return Object.freeze({
    skills: Object.freeze(skills),
    fever: Object.freeze(fever),
    callChanges: Object.freeze(callChanges),
  });
}
