import assert from "node:assert/strict";
import test from "node:test";
import { compileFromMasterTables } from "../../src/lib/team-builder/engine/master";
import {
  gekisoChart,
  gekisoContext,
  scoreOrdersGekiso,
  type GekisoContext,
} from "../../src/lib/team-builder/engine/gekiso";
import { luckCurve } from "../../src/lib/team-builder/engine/full/luck";
import type { LuckRecord } from "../../src/lib/team-builder/engine/full/model";
import type { GekisouTables } from "../../src/lib/team-builder/engine/full/gekisou";

function fixture(times = [100]) {
  const master = compileFromMasterTables({ server: "intl", releaseId: "synthetic-expectation" }, () => []);
  Object.assign(master.live, {
    adjustment: 0.1,
    lifeBase: 1000,
    lifeOnus: 0.5,
    damage: [0, 0, 0, 0, 0, 0, 0],
    notePercent: new Map([[1, 100]]),
    judgePercent: new Map([
      [2, 100],
      [1, 100],
    ]),
    combo: new Map(),
  });
  const chart = gekisoChart(
    master,
    {
      durationMs: 10000,
      notes: [],
      skillTimesMs: [],
      feverMs: [
        [0, 1000],
        [3000, 4000],
        [6000, 7000],
      ],
      enumeration: times.map((timeMs) => ({ op: 1, timeMs })),
    },
    5,
    [2, 1, 3],
    { great: 0, just: 0 },
  );
  chart.rangeOf.fill(-1);
  chart.rangePercent = [];
  return { master, chart };
}
const deterministic = (factors: readonly number[]): GekisoContext => ({
  judgement: new Int8Array(factors.length).fill(5),
  gk: new Float32Array(factors.length).fill(1),
  up: Float64Array.from(factors),
  luck: Float64Array.from(factors),
  seeds: 1,
});
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("integer outcome scoring preserves the A/B ranking in nominal and seeded aggregation", () => {
  const { master, chart } = fixture();
  const results = [
    [11, 0.75],
    [19, 0.25],
  ].map(([power, probability]) => {
    const ctx = deterministic([1 + probability!]);
    ctx.seeds = 0;
    ctx.nominal = {
      probabilities: [
        Float64Array.of(1 - probability!),
        Float64Array.of(probability!),
        Float64Array.of(0),
        Float64Array.of(0),
      ],
      noteUp: Float32Array.of(1),
      rushUp: 0,
      rushFactor: 2,
      rankRemainder: () => 0,
    };
    const nominal = scoreOrdersGekiso(master, chart, ctx, power!, []).mean;
    const factors = probability === 0.75 ? [1, 2, 2, 2] : [1, 1, 1, 2];
    const draws = factors.map((factor) => deterministic([factor]));
    const seeded = scoreOrdersGekiso(master, chart, { ...deterministic([1]), draws: () => draws, seeds: 4 }, power!, []).mean;
    return { nominal, seeded };
  });
  assert.deepEqual(results, [
    { nominal: 1.75, seeded: 1.75 },
    { nominal: 1.5, seeded: 1.5 },
  ]);
});

test("seed aggregation settles each whole range before averaging, including per-draw judgements", () => {
  const { master, chart } = fixture([100, 200]);
  chart.rangeOf.fill(0);
  chart.rangePercent = [250];
  chart.full.convertedCount = 1;
  chart.judgeFrac[4] = 0.5;
  const draws = [deterministic([1, 1]), deterministic([2, 2])];
  draws[0]!.judgement[0] = 4;
  const individual = draws.map((ctx) => scoreOrdersGekiso(master, chart, ctx, 11, []));
  const combined = scoreOrdersGekiso(master, chart, { ...draws[0]!, seeds: 2, draws: () => draws }, 11, []);
  for (let order = 0; order < 120; order++)
    close(combined.scores[order]!, (individual[0]!.scores[order]! + individual[1]!.scores[order]!) / 2);
  assert.equal(combined.mean, 8.5);
});

const tables: GekisouTables = {
  gaugeMax: 100,
  gaugeMaxRush: 100,
  rushPercent: 100,
  luckBasePoints: [{ category: 0, judgement: 5, weight: 1, point: 0 }],
  luckBonusLots: [0, 1, 2, 3, 4].flatMap((lotType) => [
    { lotType, result: 0, weight: 1 },
    { lotType, result: 3, weight: 1 },
  ]),
  rankingBonuses: [],
};
function recording(pending: boolean): {
  record: LuckRecord;
  frames: { timeMs: number; judged: { noteId: number; timeMs: number }[] }[];
} {
  const frames = [
    { timeMs: 0, judged: pending ? [] : [{ noteId: 1, timeMs: 0 }] },
    {
      timeMs: 40,
      judged: pending
        ? [
            { noteId: 1, timeMs: 40 },
            { noteId: 2, timeMs: 40 },
          ]
        : [{ noteId: 2, timeMs: 40 }],
    },
    { timeMs: 80, judged: [] },
  ];
  const record: LuckRecord = {
    actions: [{ frame: 0, range: 0, type: 11003, value: 10000, limit: 0, chance: 1 }],
    frames: [
      { states: [3], updates: [0], playing: 0 },
      { states: [4], updates: [0], playing: 0 },
      { states: [8], updates: [0], playing: -1 },
    ],
    notes: pending ? [] : [{ frame: 0, range: 0, op: 1, judgement: 5, timeMs: 0, speed: 0, buff: 0 }],
  };
  if (pending) {
    frames.splice(1, 0, { timeMs: 20, judged: [] });
    record.frames.splice(1, 0, { states: [4], updates: [0], playing: 0 });
  }
  return { record, frames };
}

for (const pending of [false, true])
  test(`joint residues retain two-note correlation (${pending ? "pending lot on empty frame" : "note draw"})`, () => {
    const { record, frames } = recording(pending);
    const curve = luckCurve(tables, record, frames, [0], []);
    close(curve.rush.get(1)!, 0.5);
    close(curve.rush.get(2)!, 0.5);
    for (const percent of [250, 370, 190, 333, 222, 111]) {
      const residues = new Float64Array(100);
      luckCurve(tables, record, frames, [0], [], {
        modulus: 100,
        initial: 0,
        residues,
        noteScore: (_id, bonus) => (bonus ? 2 : 1),
      });
      close(residues[2]!, 0.5);
      close(residues[4]!, 0.5);
      close(residues[3]!, 0);
      const actual = residues.reduce(
        (sum, probability, score) => sum + probability * Math.floor((score * percent) / 100),
        0,
      );
      const expected = (Math.floor((2 * percent) / 100) + Math.floor((4 * percent) / 100)) / 2;
      close(actual, expected);
    }
    const residues = new Float64Array(100);
    luckCurve(tables, record, frames, [0], [], {
      modulus: 100,
      initial: 99,
      residues,
      noteScore: (_id, bonus, skill) => 1 + Number(bonus) + Number(skill),
    });
    close(residues[1]!, 0.5);
    close(residues[pending ? 5 : 4]!, 0.5);
  });

test("public context production retains seeded outcomes and nominal settlement with deterministic lotteries", () => {
  const { master, chart } = fixture([100, 200, 300, 3200, 6200]);
  chart.rangeOf.set([0, 0, 0, 1, 2]);
  chart.rangePercent = [370, 370, 370];
  master.live.gekiso = {
    ...tables,
    luckBasePoints: [{ category: 0, judgement: 5, weight: 1, point: 100 }],
    luckBonusLots: [0, 1, 2, 3, 4].map((lotType) => ({ lotType, result: 3, weight: 1 })),
  };
  const nominal = gekisoContext(master, chart, [], []);
  const seeds = [0, 1, 17];
  const many = gekisoContext(master, chart, [], seeds);
  assert.equal([...many.draws!()].length, 3);
  for (const power of [11, 19, 99991]) {
    const expected =
      seeds
        .map((seed) => scoreOrdersGekiso(master, chart, gekisoContext(master, chart, [], [seed]), power, []).mean)
        .reduce((a, b) => a + b, 0) / seeds.length;
    close(scoreOrdersGekiso(master, chart, nominal, power, []).mean, expected);
    close(scoreOrdersGekiso(master, chart, many, power, []).mean, expected);
  }
});

test("nominal context and scoring equal explicit enumeration of correlated lottery outcomes", () => {
  const { master, chart } = fixture([100, 200, 300]);
  master.live.notePercent = new Map([...master.live.notePercent, [21, 100]]);
  chart.notes.slice(1).forEach((note) => {
    note.op = 21;
  });
  chart.full.notes.slice(1).forEach((note) => {
    note.op = 21;
  });
  chart.rangeOf.fill(0);
  chart.rangePercent = [370];
  master.live.gekiso = {
    ...tables,
    luckBasePoints: [
      { category: 0, judgement: 5, weight: 1, point: 100 },
      { category: 1, judgement: 5, weight: 1, point: 0 },
    ],
  };
  const nominal = gekisoContext(master, chart, [], []);
  assert.ok(nominal.nominal!.probabilities[1]!.some((p) => p > 0 && p < 1));
  const branches = [0, 3].map((result) => {
    const within = {
      ...master,
      live: {
        ...master.live,
        gekiso: {
          ...master.live.gekiso,
          luckBonusLots: [0, 1, 2, 3, 4].map((lotType) => ({ lotType, result, weight: 1 })),
        },
      },
    };
    return gekisoContext(within, chart, [], [0]);
  });
  for (const power of [11, 19, 99991]) {
    const expected =
      branches.map((ctx) => scoreOrdersGekiso(master, chart, ctx, power, []).mean).reduce((a, b) => a + b, 0) / 2;
    close(scoreOrdersGekiso(master, chart, nominal, power, []).mean, expected);
  }
});
