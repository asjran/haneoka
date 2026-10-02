import { dataRows, nativeRow, type DataRow, type TeamBuilderData } from "../data.ts";

/** Score-equivalent omissions for the normal all-PERFECT/basic-Live scenario.
 * Recovery can raise LIFE up to twice InitialLife, but the native score core
 * distinguishes only positive/zero LIFE. GREAT→PERFECT converters never match
 * an AP judgement. The caller still validates the selected skill and conditions.
 */
export function createNativeNormalAPNeutralResolver(data: TeamBuilderData) {
  const life = Number(
    dataRows(data.liveTools.liveSettings)
      .map(nativeRow)
      .find((row) => row.key === "life_base")?.value,
  );
  const perfect = dataRows(data.liveTools.judgementParameters)
    .map(nativeRow)
    .find((row) => row.noteSimulateJudgement === 5);
  const phases = new Map(
    dataRows(data.skillReference.effectSettings)
      .map(nativeRow)
      .map((row) => [row.skillEffectType, row.phase]),
  );
  const targets = new Map(
    dataRows(data.skillReference.targets)
      .map(nativeRow)
      .map((row) => [row.id, row]),
  );
  const int = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
  return (row: DataRow): boolean => {
    if (
      !int(row.id) ||
      !int(row.effectValue) ||
      row.skillTriggerType !== 1 ||
      row.skillReleaseConditionGroup !== 0 ||
      row.skillCumulativeConditionID !== 0 ||
      row.effectExecuteLimitCount !== 0 ||
      row.effectExecuteLimitResetConditionGroup !== 0 ||
      row.maxEffectValue !== 0 ||
      !Array.isArray(row.skillTargetIDs)
    )
      return false;
    if (row.skillEffectType === 3001)
      return (
        phases.get(3001) === 1 &&
        row.activationTimeSecond === 0 &&
        row.effectLimitCount === 0 &&
        row.skillTargetIDs.length === 0 &&
        perfect?.damage === 0 &&
        int(life) &&
        life > 0 &&
        life <= 0x3fffffff &&
        row.effectValue <= 0x7fffffff - life * 2
      );
    if (row.skillEffectType === 12006)
      return (
        phases.get(12006) === 2 &&
        row.effectValue === 5 &&
        typeof row.activationTimeSecond === "number" &&
        Number.isFinite(row.activationTimeSecond) &&
        row.activationTimeSecond > 0 &&
        int(row.effectLimitCount) &&
        row.skillTargetIDs.length > 0 &&
        row.skillTargetIDs.every((id) => int(id) && [3, 4].includes(Number(targets.get(id)?.judgement)))
      );
    return false;
  };
}
