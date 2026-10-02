import type { EvidenceGap, SkillWindow } from "../contracts.ts";

const f = Math.fround;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });

export interface NormalSkillActivation {
  frameMs: number;
  /** Original trigger time, preserved when a frame jumps past a chart event. */
  executeMs: number;
}
/** Conditions are evaluated upstream, with one activation at most per frame.
 * member-event means the owner's current-frame Live event, not its active window.
 * Omitted releaseFramesMs means there is no native release checker.
 */
export interface NormalSkillCondition {
  activation: "member-event" | readonly NormalSkillActivation[];
  releaseFramesMs?: readonly number[];
  disabledIntervals?: readonly { startMs: number; endMs: number }[];
}
export interface NormalSkillEffect {
  id: number;
  type: 2000 | 15000;
  phase: 2;
  seconds: number;
  value: number;
  condition: NormalSkillCondition;
  /** Native per-effect FIFO capacity, when established by the condition factory. */
  poolSize?: number;
  /** The score consumer resolves native FactorOwnerId; local handles remain distinct. */
  factorOwnerId?: number;
}
export interface NormalSkillPlan {
  effects: readonly NormalSkillEffect[];
  gaps: readonly EvidenceGap[];
}
export interface NormalMemberSkills {
  live: NormalSkillPlan;
  /** Physical slots are retained even when 01 is empty and 02 has compact index0. */
  supports: readonly [NormalSkillPlan | null, NormalSkillPlan | null];
}
export interface NormalSkillInput {
  formation: readonly NormalMemberSkills[];
  /** Formation-slot permutation bound to original chart event indices 0..4. */
  order: readonly number[];
  skillTimesMs: readonly number[];
  musicLengthMs: number;
  /** Optional exact update frames. Each chart event is dispatched once on crossing. */
  frameTimesMs?: readonly number[];
}
export interface NormalFactorCommand {
  timeMs: number;
  diffMillPercent: number;
  handleId: number;
  factorOwnerId?: number;
  memberSkillIndex: number;
  effectId: number;
  sequence: number;
}
export interface NormalSkillWindow {
  window: SkillWindow;
  handleId: number;
  effectId: number;
  formationSlot: number;
  memberSkillIndex: number;
  physicalSupportSlot: "01" | "02" | null;
  nativeCompactSkillIndex: number | null;
  extendedTimeMs: number;
}
export interface NormalSkillResult {
  windows: SkillWindow[];
  bindings: NormalSkillWindow[];
  factorCommands: NormalFactorCommand[];
  leaderEventIndex: number;
  assumptions: string[];
  gaps: EvidenceGap[];
}

/** Resolve one skill's level independently; rows may be native underscore fields
 * or compact API rows. The caller establishes support trigger/enable conditions.
 */
export function resolveNormalSkillEffects(input: {
  rows: readonly Record<string, unknown>[];
  kind: "live" | "support";
  skillId: number;
  level: number;
  phaseByEffectType: Readonly<Record<number, number>>;
  resolveCondition?: (row: Readonly<Record<string, unknown>>) => NormalSkillCondition | null;
}): NormalSkillPlan {
  const effects: NormalSkillEffect[] = [],
    gaps: EvidenceGap[] = [];
  const rows = input.rows.map((raw) => {
    const nested = raw.raw && typeof raw.raw === "object" ? (raw.raw as Record<string, unknown>) : {};
    return Object.fromEntries(
      [...Object.entries(nested), ...Object.entries(raw)].map(([key, value]) => [key.replace(/^_/u, ""), value]),
    );
  });
  const skillKey = input.kind === "live" ? "liveSkillID" : "supportSkillID";
  const selected = rows.filter(
    (row) => row.level === input.level && (row[skillKey] === undefined || row[skillKey] === input.skillId),
  );
  if (!int(input.skillId) || input.skillId < 1 || !int(input.level) || input.level < 1 || !selected.length)
    gaps.push(gap("native-normal-skill-level-unresolved", `${input.kind}:${input.skillId}/level:${input.level}`));
  for (const row of selected) {
    const source = `${input.kind}:${input.skillId}/level:${input.level}/effect:${row.id}`;
    if (row.skillEffectType !== 2000 && row.skillEffectType !== 15000) {
      gaps.push(gap("native-normal-effect-type-unresolved", `${source}/type:${row.skillEffectType}`));
      continue;
    }
    if (input.phaseByEffectType[row.skillEffectType] !== 2) {
      gaps.push(gap("native-normal-effect-phase-unresolved", source));
      continue;
    }
    if (
      [
        "skillCumulativeConditionID",
        "effectExecuteLimitCount",
        "effectExecuteLimitResetConditionGroup",
        "effectLimitCount",
        "maxEffectValue",
      ].some((key) => row[key] !== 0) ||
      !Array.isArray(row.skillTargetIDs) ||
      row.skillTargetIDs.length
    ) {
      gaps.push(gap("native-normal-effect-counter-or-target-unresolved", source));
      continue;
    }
    let condition: NormalSkillCondition | null = null;
    if (input.kind === "live" && row.skillConditionGroup === 0 && row.skillReleaseConditionGroup === 0)
      condition = { activation: "member-event" };
    else condition = input.resolveCondition?.(row) ?? null;
    if (!condition || (row.skillReleaseConditionGroup !== 0 && !condition.releaseFramesMs)) {
      gaps.push(
        gap(
          "native-normal-effect-condition-unresolved",
          `${source}/condition:${row.skillConditionGroup}/trigger:${row.skillTriggerConditionGroup ?? 0}/release:${row.skillReleaseConditionGroup}`,
        ),
      );
      continue;
    }
    if (
      !int(row.id) ||
      !int(row.effectValue) ||
      typeof row.activationTimeSecond !== "number" ||
      !Number.isFinite(row.activationTimeSecond)
    ) {
      gaps.push(gap("native-normal-effect-input-unresolved", source));
      continue;
    }
    if (input.kind === "live" && !(row.activationTimeSecond > 0)) {
      gaps.push(gap("native-normal-live-nonpositive-duration-unresolved", source));
      continue;
    }
    effects.push({
      id: row.id,
      type: row.skillEffectType,
      phase: 2,
      seconds: f(row.activationTimeSecond),
      value: row.effectValue,
      condition,
    });
  }
  return { effects, gaps };
}

/** Every permutation has nominal weight1/120 for independent uniform native draws. */
export function normalSkillOrders(): number[][] {
  const result: number[][] = [];
  const visit = (chosen: number[]) => {
    if (chosen.length === 5) result.push(chosen);
    else for (let slot = 0; slot < 5; slot++) if (!chosen.includes(slot)) visit([...chosen, slot]);
  };
  visit([]);
  return result;
}

export function normalSupportHasTimedActivation(seconds: number): boolean {
  const value = f(seconds),
    sentinel = f(2147483648);
  return value > 0 && Math.abs(f(sentinel - value)) >= f(f(Math.max(Math.abs(value), sentinel)) * f(1e-6));
}

interface EffectRuntime {
  effect: NormalSkillEffect;
  formationSlot: number;
  memberSkillIndex: number;
  physicalSupportSlot: "01" | "02" | null;
  nativeCompactSkillIndex: number | null;
  activations: Map<number, number>;
  release: Set<number> | null;
  timed: boolean;
  pool: Instance[];
  active: Instance[];
}
interface Instance {
  extendedMs: number;
  state: 0 | 2 | 3 | 4;
  startMs: number;
  handleId: number;
  delta: number;
  binding: NormalSkillWindow | null;
}
const fresh = (): Instance => ({
  extendedMs: 0,
  state: 0,
  startMs: 0,
  handleId: 0,
  delta: 0,
  binding: null,
});
const duration = (runtime: EffectRuntime, instance: Instance) =>
  f(f(runtime.effect.seconds * f(1000)) + instance.extendedMs);
const disabled = (runtime: EffectRuntime, time: number) =>
  runtime.effect.condition.disabledIntervals?.some((interval) => interval.startMs <= time && time < interval.endMs) ??
  false;

/** Construct type2000 score commands and type15000 duration changes for an explicit
 * order. Exact supplied frames preserve phase/state timing. With no frame list,
 * positive Live windows and isolated support pulses use event-time dispatch;
 * support pool reuse needs explicit frames when multiple pulses exceed capacity.
 * Score commands are authoritative; the inclusive SkillWindow view is compatible
 * with existing contracts but does not specify same-time note/command ordering.
 */
export function buildNormalSkillWindows(input: NormalSkillInput): NormalSkillResult {
  const result: NormalSkillResult = {
    windows: [],
    bindings: [],
    factorCommands: [],
    leaderEventIndex: input.order.indexOf(2),
    assumptions: input.frameTimesMs ? [] : ["normal-skill-event-time-dispatch"],
    gaps: [],
  };
  const fail = (code: string, source: string) => result.gaps.push(gap(code, source));
  if (
    input.formation.length !== 5 ||
    input.order.length !== 5 ||
    new Set(input.order).size !== 5 ||
    input.order.some((slot) => !int(slot) || slot > 4)
  )
    fail("native-normal-five-slot-order-required", "formation/order");
  if (input.skillTimesMs.length !== 5 || input.skillTimesMs.some((time) => !int(time)))
    fail("native-normal-five-chart-events-required", "skillTimesMs");
  if (
    !int(input.musicLengthMs) ||
    input.musicLengthMs < 1 ||
    input.skillTimesMs.some((time) => time > input.musicLengthMs)
  )
    fail("native-normal-music-length-unresolved", "musicLengthMs");
  if (
    input.frameTimesMs &&
    (!input.frameTimesMs.length ||
      input.frameTimesMs.some((time, index) => !int(time) || (index > 0 && time <= input.frameTimesMs![index - 1]!)) ||
      input.frameTimesMs.at(-1)! < Math.max(...input.skillTimesMs))
  )
    fail("native-normal-frame-times-invalid", "frameTimesMs");
  if (result.gaps.length) return result;
  const memberFrames = new Map<number, Map<number, number>>();
  for (const [index, executeMs] of input.skillTimesMs.entries()) {
    const frameMs = input.frameTimesMs?.find((time) => time >= executeMs) ?? executeMs;
    memberFrames.set(index, new Map([[frameMs, executeMs]]));
  }
  const runtimes: EffectRuntime[] = [];
  const frameSet = new Set(input.frameTimesMs ?? input.skillTimesMs);
  frameSet.add(input.musicLengthMs);
  for (const [memberSkillIndex, formationSlot] of input.order.entries()) {
    const member = input.formation[formationSlot]!;
    if (member.supports.length !== 2) fail("native-normal-two-support-slots-required", `slot:${formationSlot}`);
    let compact = 0;
    const plans = [
      { plan: member.live, physical: null, compact: null },
      ...member.supports.flatMap((plan, index) =>
        plan
          ? [
              {
                plan,
                physical: index === 0 ? ("01" as const) : ("02" as const),
                compact: compact++,
              },
            ]
          : [],
      ),
    ];
    for (const { plan, physical, compact: compactIndex } of plans) {
      result.gaps.push(...plan.gaps);
      for (const effect of plan.effects) {
        const source = `slot:${formationSlot}/support:${physical ?? "live"}/effect:${effect.id}`;
        if (
          (effect.type !== 2000 && effect.type !== 15000) ||
          effect.phase !== 2 ||
          !int(effect.id) ||
          !int(effect.value) ||
          !Number.isFinite(effect.seconds) ||
          (effect.poolSize !== undefined && (!int(effect.poolSize) || effect.poolSize < 1 || effect.poolSize > 256))
        ) {
          fail("native-normal-effect-input-unresolved", source);
          continue;
        }
        const delta = Math.floor(f(f(f(effect.value) / f(10000)) * f(100000)));
        if (effect.type === 2000 && !int(delta)) {
          fail("native-normal-score-delta-out-of-int32", source);
          continue;
        }
        if (
          (physical === null && !normalSupportHasTimedActivation(effect.seconds)) ||
          (effect.type === 2000 && effect.seconds <= 0 && !effect.condition.releaseFramesMs)
        ) {
          fail("native-normal-live-duration-unresolved", source);
          continue;
        }
        const activations =
          effect.condition.activation === "member-event"
            ? new Map(memberFrames.get(memberSkillIndex))
            : new Map<number, number>();
        if (effect.condition.activation !== "member-event")
          for (const pulse of effect.condition.activation) {
            if (
              !int(pulse.frameMs) ||
              !int(pulse.executeMs) ||
              pulse.executeMs > pulse.frameMs ||
              pulse.frameMs > input.musicLengthMs
            )
              fail("native-normal-condition-frame-invalid", source);
            else activations.set(pulse.frameMs, pulse.executeMs); // Last match in this frame.
          }
        if (physical === null && effect.condition.activation !== "member-event") {
          const own = memberFrames.get(memberSkillIndex)!;
          for (const time of [...activations.keys()]) {
            if (!own.has(time)) activations.delete(time);
            else activations.set(time, own.get(time)!);
          }
        }
        if (
          physical !== null &&
          !input.frameTimesMs &&
          (activations.size > (effect.poolSize ?? 1) ||
            (!normalSupportHasTimedActivation(effect.seconds) && activations.size > 1))
        )
          fail("native-normal-support-pool-reuse-needs-frames", source);
        for (const time of activations.keys()) frameSet.add(time);
        for (const time of effect.condition.releaseFramesMs ?? []) {
          if (!int(time) || time > input.musicLengthMs) fail("native-normal-release-frame-invalid", source);
          else frameSet.add(time);
        }
        for (const interval of effect.condition.disabledIntervals ?? []) {
          if (!int(interval.startMs) || !int(interval.endMs) || interval.endMs < interval.startMs)
            fail("native-normal-disabled-interval-invalid", source);
          else {
            frameSet.add(interval.startMs);
            frameSet.add(interval.endMs);
          }
        }
        if (
          input.frameTimesMs &&
          [
            ...activations.keys(),
            ...(effect.condition.releaseFramesMs ?? []),
            ...(effect.condition.disabledIntervals ?? []).flatMap((interval) => [interval.startMs, interval.endMs]),
          ].some((time) => !input.frameTimesMs!.includes(time))
        )
          fail("native-normal-condition-frame-not-in-timeline", source);
        runtimes.push({
          effect,
          formationSlot,
          memberSkillIndex,
          physicalSupportSlot: physical,
          nativeCompactSkillIndex: compactIndex,
          activations,
          release: effect.condition.releaseFramesMs ? new Set(effect.condition.releaseFramesMs) : null,
          timed: physical === null || normalSupportHasTimedActivation(effect.seconds),
          pool: Array.from({ length: physical === null ? 1 : (effect.poolSize ?? 1) }, fresh),
          active: [],
        });
      }
    }
  }
  if (result.gaps.length) return result;
  // Native updates normal skills before support skills within the same phase.
  runtimes.sort((a, b) => Number(a.physicalSupportSlot !== null) - Number(b.physicalSupportSlot !== null));
  let nextHandle = 1;
  const command = (runtime: EffectRuntime, instance: Instance, timeMs: number, diff: number) => {
    result.factorCommands.push({
      timeMs,
      diffMillPercent: diff,
      handleId: instance.handleId,
      factorOwnerId: runtime.effect.factorOwnerId,
      memberSkillIndex: runtime.memberSkillIndex,
      effectId: runtime.effect.id,
      sequence: result.factorCommands.length,
    });
  };
  const finish = (runtime: EffectRuntime, instance: Instance, timeMs: number) => {
    instance.state = 4;
    if (instance.binding) {
      instance.binding.window.endMs = Math.min(input.musicLengthMs, timeMs);
      instance.binding.extendedTimeMs = instance.extendedMs;
      command(runtime, instance, instance.binding.window.endMs, -instance.delta);
    }
  };
  const frames = [...frameSet].filter((time) => time <= input.musicLengthMs).sort((a, b) => a - b);
  for (const now of frames) {
    const started: { runtime: EffectRuntime; instance: Instance }[] = [];
    for (const runtime of runtimes) {
      const off = disabled(runtime, now);
      const executeMs = runtime.activations.get(now);
      // A returning instance was unavailable to this frame's condition/pop step.
      const requested = !off && executeMs !== undefined && (runtime.timed || runtime.active.length === 0);
      const instanceToStart = requested ? runtime.pool.shift() : undefined;
      for (const instance of [...runtime.active]) {
        if (instance.state === 4) {
          instance.state = 0; // ExtendedTimeMs survives Stay and FIFO reuse.
          runtime.active.splice(runtime.active.indexOf(instance), 1);
          runtime.pool.push(instance);
          continue;
        }
        const elapsed = f((now - instance.startMs) | 0),
          ms = duration(runtime, instance);
        if (off || runtime.release?.has(now)) finish(runtime, instance, now);
        else if (instance.state === 2 && !runtime.release && ms <= elapsed)
          finish(runtime, instance, (instance.startMs + Math.ceil(ms)) | 0);
        else if (instance.state === 3 && runtime.effect.seconds > 0 && elapsed > ms)
          finish(runtime, instance, (instance.startMs + Math.ceil(ms)) | 0);
        else instance.state = 3;
      }
      if (!requested) continue;
      if (!instanceToStart) {
        fail(
          "native-normal-support-pool-capacity-unresolved",
          `slot:${runtime.formationSlot}/effect:${runtime.effect.id}`,
        );
        continue;
      }
      const instance = instanceToStart;
      instance.state = 2;
      instance.startMs = executeMs!;
      instance.handleId = nextHandle++;
      instance.binding = null;
      runtime.active.push(instance);
      started.push({ runtime, instance });
    }
    // Phase2 appliers run after all phase2 updaters, so expired Live effects stay ended.
    for (const { runtime, instance } of started) {
      if (runtime.effect.type === 15000) {
        for (const live of runtimes)
          if (live.physicalSupportSlot === null && live.memberSkillIndex === runtime.memberSkillIndex)
            for (const target of live.active)
              if (target.state === 2 || target.state === 3)
                target.extendedMs = f(target.extendedMs + f(runtime.effect.value));
      } else {
        instance.delta = Math.floor(f(f(f(runtime.effect.value) / f(10000)) * f(100000)));
        const window: SkillWindow = {
          startMs: instance.startMs,
          endMs: input.musicLengthMs,
          scoreBonus: f(f(instance.delta) / f(100000)),
          perfectBonus: 0,
          justBonus: 0,
          comboBonus: 0,
          gekisoComboBonus: 0,
          luckBonusPercent: 0,
          powerDelta: 0,
        };
        instance.binding = {
          window,
          handleId: instance.handleId,
          effectId: runtime.effect.id,
          formationSlot: runtime.formationSlot,
          memberSkillIndex: runtime.memberSkillIndex,
          physicalSupportSlot: runtime.physicalSupportSlot,
          nativeCompactSkillIndex: runtime.nativeCompactSkillIndex,
          extendedTimeMs: instance.extendedMs,
        };
        result.windows.push(window);
        result.bindings.push(instance.binding);
        command(runtime, instance, instance.startMs, instance.delta);
      }
    }
    if (!input.frameTimesMs) {
      // The next integer frame strictly beyond a duration provides expiry state
      // before subsequent pulses, while commands retain the recorded finish time.
      const times: number[] = [];
      for (const runtime of runtimes)
        for (const instance of runtime.active) {
          if (instance.state === 4) times.push(now + 1);
          else if (instance.state === 2) times.push(now + 1);
          else if (runtime.effect.seconds > 0 && normalSupportHasTimedActivation(runtime.effect.seconds)) {
            const ms = duration(runtime, instance);
            let next = Math.max(now + 1, instance.startMs + Math.floor(ms) + 1);
            while (next <= input.musicLengthMs && f((next - instance.startMs) | 0) <= ms) next++;
            times.push(next);
          }
        }
      for (const time of times) if (time <= input.musicLengthMs && !frames.includes(time)) frames.push(time);
      frames.sort((a, b) => a - b);
    }
  }
  for (const runtime of runtimes)
    for (const instance of runtime.active)
      if (instance.state === 2 || instance.state === 3) finish(runtime, instance, input.musicLengthMs);
  result.factorCommands.sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
  if (result.gaps.length) {
    result.windows = [];
    result.bindings = [];
    result.factorCommands = [];
  }
  return result;
}
