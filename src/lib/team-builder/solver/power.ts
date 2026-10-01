import type { PowerStats } from "../contracts.ts";
const fields = ["performance", "technique", "visual"] as const;
const f = Math.fround;
function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("power-input");
}
function map(stats: PowerStats, transform: (value: number, key: keyof PowerStats) => number): PowerStats {
  return Object.fromEntries(fields.map((key) => [key, transform(stats[key], key)])) as unknown as PowerStats;
}
/** MasterMemberCardLevelExtensions / RankExtensions: int64 product → float32 divide → floor. */
export function calcMemberLevelOrRankPower(maximum: PowerStats, ratesBP: PowerStats): PowerStats {
  return map(maximum, (value, key) => {
    integer(value);
    integer(ratesBP[key]);
    const product = value * ratesBP[key];
    if (!Number.isSafeInteger(product)) throw new RangeError("power-product-overflow");
    return Math.floor(f(f(product) / 10000));
  });
}
/** MasterMemberCardAwakeExtensions divides the float32 rate before multiplying. */
export function calcMemberTrainingPower(maximum: PowerStats, ratesBP: PowerStats): PowerStats {
  return map(maximum, (value, key) => {
    integer(value);
    integer(ratesBP[key]);
    return Math.floor(f(f(f(ratesBP[key]) / 10000) * f(value)));
  });
}
/** Snapshot's level-scaled BP percentage, returned through CardPower.CreateBP. */
export function calcSnapshotBonusBP(maximum: PowerStats, ratesBP: PowerStats): PowerStats {
  return map(maximum, (value, key) => {
    integer(value);
    integer(ratesBP[key]);
    const product = value * ratesBP[key];
    if (product > 0x7fffffff) throw new RangeError("snapshot-product-int32-overflow");
    return Math.floor(f(f(product) / 10000));
  });
}
/** CardPower.op_Multiply uses int64 BP product / 10,000, truncating each component. */
export function multiplyPowerBP(left: PowerStats, right: PowerStats): PowerStats {
  return map(left, (value, key) => {
    integer(value);
    integer(right[key]);
    const product = BigInt(value) * BigInt(right[key]);
    if (product > 0x7fffffffffffffffn) throw new RangeError("power-bp-int64-overflow");
    const result = Number(product / 10000n);
    if (!Number.isSafeInteger(result)) throw new RangeError("power-bp-js-overflow");
    return result;
  });
}
/** CardPower.ToFloor: cast BP long to float32, divide, floor, store whole-point BP. */
export function floorPowerBP(power: PowerStats): PowerStats {
  return map(power, (value) => {
    integer(value);
    return Math.floor(f(f(value) / 10000)) * 10000;
  });
}
export function addPower(...powers: PowerStats[]): PowerStats {
  return map({ performance: 0, technique: 0, visual: 0 }, (_, key) => {
    const value = powers.reduce((sum, power) => sum + power[key], 0);
    integer(value);
    return value;
  });
}
