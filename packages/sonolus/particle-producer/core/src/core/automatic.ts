import { NoteJudgementType, NoteSimulateJudgement } from "./enums.js";

export interface AutomaticJudgementRule {
  readonly startMicros: number;
  readonly endMicros: number;
  readonly judgementTypes: readonly NoteJudgementType[];
  readonly judgement: NoteSimulateJudgement;
}
export interface AutomaticJudgementPolicy {
  readonly rules: readonly AutomaticJudgementRule[];
}

export function automaticPolicyWire(
  policy: AutomaticJudgementPolicy = { rules: [] },
) {
  return {
    rules: policy.rules.map((rule) => ({
      ...rule,
      judgementTypes: rule.judgementTypes.map((type) => {
        const name = NoteJudgementType[type];
        if (!name) throw new TypeError(`Unknown judgement type: ${type}`);
        return name[0]!.toLowerCase() + name.slice(1);
      }),
    })),
  };
}

export function resolveAutomaticJudgement(
  policy: AutomaticJudgementPolicy,
  type: NoteJudgementType,
  observedTimeMs: number,
): NoteSimulateJudgement {
  const time = Math.floor(observedTimeMs) * 1000;
  return (
    policy.rules.find(
      (rule) =>
        rule.startMicros <= time &&
        time < rule.endMicros &&
        rule.judgementTypes.includes(type),
    )?.judgement ?? NoteSimulateJudgement.Perfect
  );
}
