import type { PowerStats } from "../contracts.ts";
import { addPower, floorPowerBP, multiplyPowerBP } from "./power.ts";

/** Resolved inputs to Intl CardParameterCalculator.CalculateSlotPower.
 * Power uses 10,000 BP units per point; percentage fields use 10,000 = +100%.
 * Target/condition/rank lookups are resolved by the caller, before arithmetic.
 */
export interface NativeSlotPowerInput {
  basePowerBP: PowerStats;
  characterRankBonusBP: PowerStats;
  characterTotalRankBonusBP: PowerStats;
  /** Music and character memory award this many points to each component. */
  memoryBonusPoints: number;
  memberEventBonusBP: PowerStats;
  snapshotPresent: boolean;
  snapshotBonusBP: PowerStats;
  snapshotEventBonusBP: PowerStats;
  bandItemBonusBP: PowerStats;
  leaderSkillBonusBP: PowerStats;
  typeLinkBonusBP: PowerStats;
  musicTypeBonusBP: number;
  musicTagBonusBP: number;
  vipBonusBP: number;
}
export interface NativeSlotPowerResult {
  totalPowerBP: PowerStats;
  /** Includes the independently floored member event increase. */
  basePowerBP: PowerStats;
  characterRankBonusBP: PowerStats;
  characterTotalRankBonusBP: PowerStats;
  snapshotBonusPowerBP: PowerStats;
  typeLinkBonusPowerBP: PowerStats;
  bandItemBonusPowerBP: PowerStats;
  musicTypeBonusPowerBP: PowerStats;
  musicTagBonusPowerBP: PowerStats;
  leaderSkillBonusPowerBP: PowerStats;
  memoryBonusPowerBP: PowerStats;
  vipBonusPowerBP: PowerStats;
}
const uniform = (value: number): PowerStats => ({ performance: value, technique: value, visual: value });
const zero = (): PowerStats => uniform(0);
const bonus = (base: PowerStats, percentBP: PowerStats): PowerStats => floorPowerBP(multiplyPowerBP(base, percentBP));

/** Original Intl method VA 0x55ba6b4. Each percentage contribution is separately
 * floored against the same common base; snapshot power does not compound the
 * other percentages. Memory and rank bonuses are direct points.
 */
export function calculateNativeSlotPower(input: NativeSlotPowerInput): NativeSlotPowerResult {
  for (const scalar of [input.memoryBonusPoints, input.musicTypeBonusBP, input.musicTagBonusBP, input.vipBonusBP]) {
    if (!Number.isSafeInteger(scalar) || scalar < 0 || scalar > 0x7fffffff) throw new RangeError("slot-power-input");
  }
  if (typeof input.snapshotPresent !== "boolean") throw new TypeError("snapshot-present");
  const basePowerBP = addPower(input.basePowerBP, bonus(input.basePowerBP, input.memberEventBonusBP));
  const memoryBonusPowerBP = uniform(input.memoryBonusPoints * 10000);
  const commonBaseBP = addPower(
    basePowerBP,
    input.characterRankBonusBP,
    input.characterTotalRankBonusBP,
    memoryBonusPowerBP,
  );
  const snapshotPercentBP = addPower(
    input.snapshotPresent ? input.snapshotBonusBP : zero(),
    input.snapshotEventBonusBP,
  );
  const snapshotBonusPowerBP = bonus(commonBaseBP, snapshotPercentBP);
  const typeLinkBonusPowerBP = bonus(commonBaseBP, input.snapshotPresent ? input.typeLinkBonusBP : zero());
  const bandItemBonusPowerBP = bonus(commonBaseBP, input.bandItemBonusBP);
  const leaderSkillBonusPowerBP = bonus(commonBaseBP, input.leaderSkillBonusBP);
  const musicTypeBonusPowerBP = bonus(commonBaseBP, uniform(input.musicTypeBonusBP));
  const musicTagBonusPowerBP = bonus(commonBaseBP, uniform(input.musicTagBonusBP));
  const vipBonusPowerBP = bonus(commonBaseBP, uniform(input.vipBonusBP));
  return {
    totalPowerBP: addPower(
      commonBaseBP,
      snapshotBonusPowerBP,
      typeLinkBonusPowerBP,
      bandItemBonusPowerBP,
      leaderSkillBonusPowerBP,
      musicTypeBonusPowerBP,
      musicTagBonusPowerBP,
      vipBonusPowerBP,
    ),
    basePowerBP,
    characterRankBonusBP: { ...input.characterRankBonusBP },
    characterTotalRankBonusBP: { ...input.characterTotalRankBonusBP },
    snapshotBonusPowerBP,
    typeLinkBonusPowerBP,
    bandItemBonusPowerBP,
    musicTypeBonusPowerBP,
    musicTagBonusPowerBP,
    leaderSkillBonusPowerBP,
    memoryBonusPowerBP,
    vipBonusPowerBP,
  };
}
