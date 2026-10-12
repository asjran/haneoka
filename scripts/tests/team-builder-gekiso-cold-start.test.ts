import assert from "node:assert/strict";
import test from "node:test";
import { compileFromMasterTables, type SkillEffectRow } from "../../src/lib/team-builder/engine/master";
import {
  gekisoSearch,
  type GekisoSearchInput,
  type GekisoDetail,
} from "../../src/lib/team-builder/engine/gekiso-objective";
import { gekisoChart, gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";
import { teamPower, type MemberState, type SnapState } from "../../src/lib/team-builder/engine/power";
import { NO_CONSTRAINTS, type SearchHit } from "../../src/lib/team-builder/engine/search";

function fixture(): GekisoSearchInput {
  const master = compileFromMasterTables({ server: "intl", releaseId: "cold-start-regression" }, () => []);
  master.params = { musicTypeBase: 0, musicTagBase: 0, typeLinkBase: 0, skipRank: 2 };
  Object.assign(master.live, {
    adjustment: 0.1,
    lifeBase: 1000,
    lifeOnus: 0.5,
    notePercent: new Map([[1, 100]]),
    judgePercent: new Map([
      [2, 100],
      [1, 100],
    ]),
    combo: new Map(),
    damage: [],
  });
  master.live.gekiso = {
    gaugeMax: 100,
    gaugeMaxRush: 100,
    rushPercent: 100,
    luckBasePoints: [{ category: 0, judgement: 5, weight: 1, point: 100 }],
    luckBonusLots: [0, 1, 2, 3, 4].map((lotType) => ({ lotType, result: 3, weight: 1 })),
    rankingBonuses: [],
  };
  const row: SkillEffectRow = {
    id: 1,
    level: 1,
    triggerType: 2,
    executeLimit: 0,
    resetGroup: 0,
    type: 2000,
    value: 1000,
    seconds: 0,
    conditionGroup: 0,
    triggerGroup: 1,
    releaseGroup: 0,
    cumulativeId: 0,
    targetIds: [],
    limitCount: 0,
    maxValue: 0,
  };
  master.conditions = new Map([[1, { id: 1, type: 7021, targetIds: [], values: [], positive: true }]]);
  master.conditionSets = new Map([[1, [[1]]]]);
  master.gekisoSkills = new Map([[1, { missionType: 2, effects: [] }]]);
  master.gekisoSupportSkills = new Map(
    Array.from({ length: 69 }, (_, i) => [
      i + 1,
      { missionType: 2, effects: [{ ...row, id: i + 1, value: 1000 + i * 50 }] },
    ]),
  );
  const members: MemberState[] = Array.from({ length: 67 }, (_, i) => ({
    key: `m${i}`,
    card: {
      id: i + 1,
      characterId: 1 + (i % 15),
      bandId: 1,
      rarity: 4,
      cardType: 1,
      bestTags: [],
      statMax: [100 + i, 100, 100],
      levelGroup: 1,
      awakeGroup: 1,
      rankGroup: 1,
      liveSkillId: 0,
      gekisoSkillId: 1,
      leaderSkillId: 0,
      releasedAt: null,
    },
    growth: { level: 1, awake: 1, rank: 1, liveSkillLevel: 1, gekisoSkillLevel: 1 },
    leaderSkillLevel: 1,
    musicTypeRate: 0,
    musicTagRate: 0,
    own: [(100 + i) * 10000, 1000000, 1000000],
    liveSkillCategories: [],
    gekisoSkillCategories: [],
    gekisoMissionType: 2,
  }));
  const snaps: SnapState[] = Array.from({ length: 69 }, (_, i) => ({
    key: `s${i}`,
    card: {
      id: i + 1,
      characterIds: [],
      bandIds: [],
      rarity: 4,
      cardType: 1,
      statMax: [0, 0, 0],
      levelGroup: 1,
      rankGroup: 1,
      supportSkillIds: [0, 0],
      gekisoSupportSkillIds: [i + 1, 0],
    },
    growth: { level: 1, rank: 1 },
    percent: [1000 + i * 50, 1000, 1000],
    typeLinkRate: 0,
    skillLevels: [1, 1],
    gekisoSkillLevels: [1, 1],
  }));
  const chart = gekisoChart(
    master,
    {
      durationMs: 7000,
      notes: [],
      skillTimesMs: [],
      feverMs: [
        [1000, 2000],
        [3000, 4000],
        [5000, 6000],
      ],
      enumeration: [1100, 1500, 1900, 3500, 5500].map((timeMs) => ({ op: 1, timeMs })),
    },
    5,
    [2, 1, 3],
    { great: 0, just: 0 },
  );
  chart.rangePercent = [370, 370, 370];
  return {
    master,
    members,
    snaps,
    chart,
    player: {
      characterRanks: new Map(),
      totalRank: 0,
      bandItems: new Map(),
      vipRank: 0,
      characterMemory: new Map(),
      musicMemory: new Map(),
    },
    music: null,
    criterion: "mean",
    seeds: [],
    constraints: NO_CONSTRAINTS,
    k: 1,
    timeLimitMs: 1000,
  };
}

function verifySettled(input: GekisoSearchInput, hit: SearchHit<GekisoDetail>) {
  const members = hit.team.members.map((i) => input.members[i]!);
  const snaps = hit.team.snaps.map((i) => (i < 0 ? null : input.snaps[i]!));
  const power = teamPower(input.master, input.player, members, snaps, 0, input.music, []);
  const deck = members.map((member, i) => performer(input.master, member, snaps[i]!));
  const slots = members.map((member, i) => resolveSlotSkill(input.master, member, snaps[i]!));
  const scores = scoreOrdersGekiso(
    input.master,
    input.chart,
    gekisoContext(input.master, input.chart, deck, input.seeds),
    power.total,
    slots,
  );
  assert.equal(hit.power, power.total);
  assert.ok(Math.abs(hit.key - scores.mean) < 1e-8);
  assert.deepEqual(hit.detail.scores.scores, scores.scores);
}

test("Luck cold start streams a settled legal incumbent from the full constrained box", () => {
  const input = fixture();
  input.constraints = {
    ...NO_CONSTRAINTS,
    requiredMembers: [0, 1],
    excludedMembers: [66],
    requiredSnaps: [0, 1],
    excludedSnaps: [68],
    leader: 0,
    bindings: new Map([
      [0, 0],
      [1, -1],
    ]),
  };
  const snapshots: SearchHit<GekisoDetail>[][] = [];
  input.onCandidate = (hits) => snapshots.push([...hits]);
  const result = gekisoSearch(input);
  assert.ok(snapshots.length > 0);
  const first = snapshots[0]![0]!;
  assert.equal(first.team.members[0], 0);
  assert.ok(first.team.members.includes(1));
  assert.ok(!first.team.members.includes(66));
  assert.equal(new Set(first.team.members.map((i) => input.members[i]!.card.characterId)).size, 5);
  assert.equal(first.team.snaps[0], 0);
  assert.equal(first.team.snaps[first.team.members.indexOf(1)], -1);
  assert.ok(first.team.snaps.includes(1));
  assert.ok(!first.team.snaps.includes(68));
  const used = first.team.snaps.filter((i) => i >= 0);
  assert.equal(new Set(used).size, used.length);
  verifySettled(input, first);
  assert.ok(result.hits[0]!.key >= first.key);
  assert.equal(result.proven, false);
  assert.equal(input.members.length, 67);
  assert.equal(input.snaps.length, 69);
});

test("Luck continuation publishes the existing settled team before pool calibration", () => {
  const input = fixture();
  input.constraints = { ...NO_CONSTRAINTS, noSnaps: true };
  input.initialTeams = [{ members: [0, 1, 2, 3, 4], snaps: [-1, -1, -1, -1, -1] }];
  const snapshots: SearchHit<GekisoDetail>[][] = [];
  input.onCandidate = (hits) => snapshots.push([...hits]);
  const result = gekisoSearch(input);
  assert.deepEqual(snapshots[0]![0]!.team, input.initialTeams[0]);
  verifySettled(input, snapshots[0]![0]!);
  assert.ok(result.hits[0]!.key >= snapshots[0]![0]!.key);
  assert.ok(result.hits[0]!.team.snaps.every((i) => i === -1));
});

test("a seeded Luck shard starts from the seeding's teams instead of seeding again", () => {
  const seeding = fixture();
  seeding.seedOnly = true;
  const seeded = gekisoSearch(seeding);
  assert.ok(seeded.hits.length > 0);
  assert.equal(seeded.proven, false);
  const input = fixture();
  input.shard = { index: 1, count: 8 };
  input.seeded = true;
  input.initialTeams = seeded.hits.map((hit) => hit.team);
  const snapshots: SearchHit<GekisoDetail>[][] = [];
  input.onCandidate = (hits) => snapshots.push([...hits]);
  const result = gekisoSearch(input);
  assert.deepEqual(snapshots[0]![0]!.team, seeded.hits[0]!.team);
  assert.ok(result.hits[0]!.key >= seeded.hits[0]!.key);
});

test("an expired Luck request does not start candidate scoring", () => {
  const input = fixture();
  input.timeLimitMs = 0;
  assert.deepEqual(gekisoSearch(input).hits, []);
});
