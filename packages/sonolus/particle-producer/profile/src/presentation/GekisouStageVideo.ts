import type { OurNotesGekisouEffectProfile } from "./GekisouStage.js";

export interface OurNotesGekisouStageVideoInput {
  readonly executorExists: boolean;
  readonly memberIndex: number;
  /** Actual ILiveResourceContainer order, supplied by the owning team/session. */
  readonly orderedAssets: readonly string[];
}

/** Watch playback supplies no executor; the asset catalogue is not a team order. */
export function ourNotesGekisouStageVideoAsset(
  source: OurNotesGekisouEffectProfile,
  input?: OurNotesGekisouStageVideoInput,
): string | undefined {
  if (!input?.executorExists || input.memberIndex === source.lifecycle.video.absentIndex) return undefined;
  return input.orderedAssets[input.memberIndex];
}

/** GekisouBgMaterialSetter controls the video's mask, independently of jacket/background alpha. */
export function ourNotesGekisouVideoCutoff(visible: number, softWidth: number): number {
  const from = Math.fround(1 + softWidth),
    t = Math.max(0, Math.min(1, visible));
  return Math.fround(from + Math.fround(Math.fround(-from) * Math.fround(t)));
}
