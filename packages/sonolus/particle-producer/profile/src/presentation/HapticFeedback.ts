import { NoteOperateType, NoteSimulateJudgement } from "@haneoka/cassiopeia";
import type { JudgementEvent } from "@haneoka/cassiopeia";
import hapticMaster from "../assets/haptic-feedback-profile.json";

export type HapticFamily = "normal" | "flick" | "trace" | "slideCombo" | "beginLong" | "inVain";
export interface HapticCue {
  family: HapticFamily;
  /** MasterLiveHaptic recipe ID; the host supplies the platform recipe. */
  feedbackType: number;
  timeMs: number;
  noteId?: number;
  judgement?: NoteSimulateJudgement;
}
export interface HapticPort {
  emit(cue: Readonly<HapticCue>): void;
  stop(): void;
}
export type HapticProfile = Readonly<Record<HapticFamily, readonly number[]>>;

const recipes = new Map(
  hapticMaster.haptics._allData
    .filter((row) => row._setID === hapticMaster.setId)
    .map((row) => [row._liveHapticType, row._recipeID]),
);
const noneRecipeId = hapticMaster.recipes._allData.find(
  (row) => row._iosPlayType === 0 && row._androidPlayType === 0,
)!._id;
export const OUR_NOTES_HAPTIC_TIMING = Object.freeze({
  minimumIntervalMs: hapticMaster.minimumIntervalMicros / 1000,
  maximumPendingRequests: hapticMaster.maximumPendingRequests,
});
const judgementRecipes = (firstType: number): readonly number[] =>
  Object.freeze([0, 0, ...Array.from({ length: 5 }, (_, index) => recipes.get(firstType + index) ?? 0)]);
const cueRecipes = (type: number): readonly number[] =>
  Object.freeze([0, 0, ...Array<number>(5).fill(recipes.get(type) ?? 0)]);
export const OUR_NOTES_HAPTIC_PROFILE: HapticProfile = Object.freeze({
  normal: judgementRecipes(1),
  flick: judgementRecipes(6),
  trace: judgementRecipes(11),
  slideCombo: judgementRecipes(16),
  beginLong: cueRecipes(22),
  inVain: cueRecipes(21),
});

/** Browsers intentionally do not synthesize arbitrary vibration durations. */
export const NO_HAPTICS: HapticPort = Object.freeze({ emit() {}, stop() {} });

export function hapticFamily(type: NoteOperateType): HapticFamily {
  switch (type) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "flick";
    case NoteOperateType.Trace:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "trace";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.Combo:
      return "slideCombo";
    default:
      return "normal";
  }
}

/** No delayed work survives pause, seek, or destruction; hosts own device APIs. */
export class HapticFeedback {
  constructor(
    private port: HapticPort = NO_HAPTICS,
    private profile: HapticProfile = OUR_NOTES_HAPTIC_PROFILE,
    public enabled = true,
  ) {}

  judgement(event: JudgementEvent): void {
    if (!this.enabled || event.judgement <= NoteSimulateJudgement.Miss) return;
    const family = hapticFamily(event.note.operateType);
    const feedbackType = this.profile[family][event.judgement] ?? 0;
    if (feedbackType !== 0 && feedbackType !== noneRecipeId)
      this.port.emit({
        family,
        feedbackType,
        timeMs: event.judgedAtMs,
        noteId: event.note.id,
        judgement: event.judgement,
      });
  }

  cue(family: "beginLong" | "inVain", timeMs: number): void {
    const feedbackType = this.profile[family][NoteSimulateJudgement.Perfect] ?? 0;
    if (this.enabled && feedbackType !== 0 && feedbackType !== noneRecipeId)
      this.port.emit({ family, feedbackType, timeMs });
  }

  stop(): void {
    this.port.stop();
  }
}
