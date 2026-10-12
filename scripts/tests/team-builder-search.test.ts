import "./team-builder-execution.test";
import "./team-builder-gekiso-expectation.test";
import "./team-builder-gekiso-cold-start.test";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileFromMasterTables, type EventEffectRow, type Song, type SkillEffectRow } from "../../src/lib/team-builder/engine/master";
import { searchTeams, NO_CONSTRAINTS, type SearchInput, type SearchHit, type Team, type ObjectiveAdapter } from "../../src/lib/team-builder/engine/search";
import { teamPower, type MemberState, type SnapState, type PlayerState } from "../../src/lib/team-builder/engine/power";
import { eventObjective, eventScoreTieObjective, liveScoreObjective, scoreCapObjective, type EventRoute, type EventDetail } from "../../src/lib/team-builder/engine/objectives";
import { mergeShardResponses } from "../../src/lib/team-builder/engine/merge";
import { compileChart } from "../../src/lib/team-builder/engine/chart";
import { AP, prepareLive } from "../../src/lib/team-builder/engine/live";
import { ChartCache, runEngine, type EngineHit, type EngineResponse, type EngineRequest } from "../../src/lib/team-builder/engine/api";

function fixture(n = 7, s = 2) {
  const master = compileFromMasterTables({ server: "jp", releaseId: "search-regression" }, () => []);
  master.params = { musicTypeBase: 0, musicTagBase: 0, typeLinkBase: 0, skipRank: 2 };
  const members: MemberState[] = Array.from({ length: n }, (_, i) => ({
    key: `m${i}`, card: { id: i + 1, characterId: i + 1, bandId: 1, rarity: 4, cardType: 1, bestTags: [],
      statMax: [100 + 7 * i, 100, 100], levelGroup: 1, awakeGroup: 1, rankGroup: 1, liveSkillId: 0, gekisoSkillId: 0, leaderSkillId: 0, releasedAt: null },
    growth: { level: 1, awake: 1, rank: 1, liveSkillLevel: 1, gekisoSkillLevel: 1 },
    leaderSkillLevel: 1, musicTypeRate: 0, musicTagRate: 0, own: [10000 * (100 + 7 * i), 1000000, 1000000],
    liveSkillCategories: [], gekisoSkillCategories: [], gekisoMissionType: 0,
  }));
  const snaps: SnapState[] = Array.from({ length: s }, (_, i) => ({ key: `s${i}`,
    card: { id: i + 1, characterIds: [], bandIds: [], rarity: 4, cardType: 2, statMax: [0, 0, 0], levelGroup: 1, rankGroup: 1,
      supportSkillIds: [0, 0], gekisoSupportSkillIds: [0, 0] }, growth: { level: 1, rank: 1 },
    percent: [1000 + i * 100, 1000, 1000], typeLinkRate: 0, skillLevels: [1, 1], gekisoSkillLevels: [1, 1],
  }));
  const player: PlayerState = { characterRanks: new Map(), totalRank: 0, bandItems: new Map(), vipRank: 0,
    characterMemory: new Map(), musicMemory: new Map() };
  return { master, members, snaps, player, music: null };
}

test("member traversal hints keep the exhaustive constrained Top-K", () => {
  const data = fixture(7, 2);
  const constraints = { ...NO_CONSTRAINTS, requiredMembers: [1], excludedMembers: [6], requiredSnaps: [0], bindings: new Map([[0, 0]]) };
  for (const direction of [-1, 1]) {
    const objective: ObjectiveAdapter<null> = {
      skill: () => [0, 0], memberBonus: () => 0, snapBonus: () => 0,
      bound: totals => totals.power, interval: (_team, totals) => [totals.power, totals.power],
      exact: (_team, power) => ({ key: power, detail: null }), preferMember: member => direction * member,
    };
    const input: SearchInput<null> = { ...data, constraints, objective, k: 3, disableSnapDominance: true };
    const expected = exhaustive(input).slice(0, input.k).map(hit => hit.key);
    const result = searchTeams(input);
    assert.equal(result.proven, true);
    assert.deepEqual(result.hits.map(hit => hit.key), expected);
  }
});

/** Independent full enumeration, with no bounds, dominance, seed or candidate trimming. */
function exhaustive<D>(input: SearchInput<D>, compare = (a: SearchHit<D>, b: SearchHit<D>) => b.key - a.key): SearchHit<D>[] {
  const constraints = input.constraints ?? NO_CONSTRAINTS;
  const best = new Map<string, SearchHit<D>>();
  const members: number[] = [], snaps = Array<number>(5).fill(-1);
  const visitSnaps = (slot: number) => {
    if (slot < 5) {
      const bound = constraints.bindings.get(members[slot]!);
      for (const snap of bound === undefined ? [-1, ...input.snaps.map((_, i) => i)] : [bound]) {
        if (snap >= 0 && (constraints.noSnaps || constraints.excludedSnaps.includes(snap) || snaps.slice(0, slot).includes(snap))) continue;
        snaps[slot] = snap;
        visitSnaps(slot + 1);
      }
      return;
    }
    if (constraints.requiredSnaps.some(i => !snaps.includes(i))) return;
    const bonus = members.reduce((sum, i) => sum + input.objective.memberBonus(i), 0) +
      snaps.reduce((sum, i) => sum + (i < 0 ? 0 : input.objective.snapBonus(i)), 0);
    if ((constraints.minBonus !== null && bonus < constraints.minBonus) || (constraints.maxBonus != null && bonus > constraints.maxBonus)) return;
    const team = { members: [...members], snaps: [...snaps] };
    const power = teamPower(input.master, input.player, members.map(i => input.members[i]!),
      snaps.map(i => i < 0 ? null : input.snaps[i]!), 0, input.music);
    const exact = input.objective.exact(team, power.total, power.slots);
    const key = [...members].sort((a, b) => a - b).join(",");
    const hit = { team, power: power.total, slotPowers: power.slots, totals: { power: power.total, skill: 0, skillLow: 0, bonus }, ...exact };
    if (!best.has(key) || compare(hit, best.get(key)!) < 0) best.set(key, hit);
  };
  const visitMembers = (from: number) => {
    if (members.length === 5) {
      if (constraints.requiredMembers.some(i => !members.includes(i)) || [...constraints.bindings.keys()].some(i => !members.includes(i))) return;
      visitSnaps(0);
      return;
    }
    for (let i = from; i < input.members.length; i++) {
      if (constraints.excludedMembers.includes(i) || members.some(j => input.members[j]!.card.characterId === input.members[i]!.card.characterId)) continue;
      members.push(i); visitMembers(i + 1); members.pop();
    }
  };
  for (let leader = 0; leader < input.members.length; leader++) {
    if (constraints.leader !== null && leader !== constraints.leader || constraints.excludedMembers.includes(leader)) continue;
    members.push(leader); visitMembers(0); members.pop();
  }
  return [...best.values()].sort(compare).slice(0, input.k);
}

const keys = <D>(hits: SearchHit<D>[]) => hits.map(hit => hit.key);
function check<D>(input: SearchInput<D>) {
  const expected = exhaustive(input);
  const actual = searchTeams(input);
  assert.equal(actual.proven, true);
  assert.deepEqual(keys(actual.hits), keys(expected));
  assert.equal(new Set(actual.hits.map(hit => [...hit.team.members].sort().join(","))).size, actual.hits.length);
  return actual;
}

test("streaming preserves the exhaustive Top-K with bindings, locks, exclusions, duplicate characters and bonus limits", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const data = fixture();
    if (seed % 2 === 0) data.members[6]!.card.characterId = 1;
    const skill = (m: number, s: number) => (m * 17 + (s + 1) * 13 + seed * 7) % 29;
    const input: SearchInput<null> = { ...data, k: seed % 3 + 1, disableSnapDominance: true,
      constraints: { ...NO_CONSTRAINTS, requiredMembers: seed % 2 ? [0] : [], excludedMembers: seed === 3 ? [5] : [],
        requiredSnaps: seed === 4 ? [1] : [], excludedSnaps: seed === 5 ? [0] : [],
        bindings: seed === 6 ? new Map([[2, 1], [3, -1]]) : new Map(), leader: seed === 7 ? 2 : null,
        minBonus: seed === 8 ? 10 : null, maxBonus: seed === 8 ? 13 : null },
      objective: { skill: (m, s) => [0, skill(m, s)], memberBonus: m => m % 4, snapBonus: s => s + 1,
        productBase: 100, bound: totals => totals.power * (100 + totals.skill),
        interval: (_team, totals) => [0, totals.power * (100 + totals.skill)],
        exact: (team, power) => ({ key: power * (100 + team.members.reduce((sum, m, slot) => sum + skill(m, team.snaps[slot]!), 0)), detail: null }) },
    };
    const result = check(input);
    assert.deepEqual(keys(searchTeams({ ...input, seeds: result.hits.map(hit => hit.team), floor: result.hits.at(-1)?.key }).hits), keys(result.hits));
    const shards = [0, 1, 2].flatMap(index => searchTeams({ ...input, shard: { index, count: 3 } }).hits);
    const distinct = new Map<string, number>();
    for (const hit of shards) {
      const key = [...hit.team.members].sort().join(",");
      distinct.set(key, Math.max(distinct.get(key) ?? -Infinity, hit.key));
    }
    assert.deepEqual([...distinct.values()].sort((a, b) => b - a).slice(0, input.k), keys(result.hits));
  }
});

test("equal-score plateaus retain only K exact results without truncating the search domain", t => {
  const input: SearchInput<null> = { ...fixture(9, 3), k: 3, disableSnapDominance: true,
    objective: { skill: () => [0, 0], memberBonus: () => 0, snapBonus: () => 0, bound: () => 100,
      interval: () => [100, 100], exact: () => ({ key: 100, detail: null }) } };
  const deferred = searchTeams({ ...input, streaming: false });
  const streamed = searchTeams(input);
  assert.deepEqual(keys(streamed.hits), keys(deferred.hits));
  assert.equal(streamed.proven, true);
  assert.equal(streamed.stats.exact, input.k);
  assert.ok(deferred.stats.candidates > streamed.stats.candidates * 100);
  t.diagnostic(JSON.stringify({ deferred: deferred.stats, streamed: streamed.stats }));
});

function effect(resourceType: number, id: number, bonusType: number, value: number): EventEffectRow {
  return { resourceType, memberCardId: resourceType === 2 ? id : 0, supportCardId: resourceType === 3 ? id : 0,
    characterId: 0, bandId: 0, cardType: 0, tagId: 0, bonusType, perRank: [value] };
}
function route(effects: EventEffectRow[] = [], kind: EventRoute["kind"] = "skip"): EventRoute {
  return { kind, rate: 1, rewardRate: 1, points: new Map([[2, 100], [3, 200]]),
    rewards: [2, 3].map(scoreRank => ({ scoreRank, group: 1, resourceType: 1, resourceId: 1, count: 10 * scoreRank, probability: 10000 })),
    itemId: 1, challengePoints: new Map([[2, 1], [3, 2]]), effects };
}

test("skip reward bounds and snap dominance include the other reward", () => {
  const data = fixture(5, 6);
  data.snaps[5]!.percent = [0, 0, 0];
  for (const measure of ["points", "items"] as const) {
    const other = measure === "points" ? 1 : 0;
    const objective = eventObjective({ ...data, chart: null }, route([effect(3, 6, other, 10000)]), measure, 2);
    const result = check({ ...data, objective, k: 1 });
    assert.ok(result.hits[0]!.team.snaps.includes(5));
    const hit = result.hits[0]!;
    assert.ok(objective.bound(hit.totals) >= hit.key);
    assert.ok(objective.leafBound!(hit.team, hit.totals) >= hit.key);
  }
});

function liveFixture() {
  const data = fixture(6, 0);
  const skills = new Map<number, SkillEffectRow[]>();
  for (const [i, member] of data.members.entries()) {
    member.card.liveSkillId = i + 1;
    skills.set(i + 1, [{ id: i + 1, level: 1, triggerType: 1, executeLimit: 0, resetGroup: 0, type: 2000,
      value: 2000 + i * 1000, seconds: 2 + i % 3, conditionGroup: 0, triggerGroup: 0, releaseGroup: 0,
      cumulativeId: 0, targetIds: [], limitCount: 0, maxValue: 0 }]);
  }
  data.master.liveSkills = skills;
  data.master.live = { ...data.master.live, adjustment: 1, lifeBase: 1000,
    notePercent: new Map([[1, 100]]), judgePercent: new Map([[1, 110], [2, 100], [3, 80], [4, 50], [5, 0], [6, 0]]) };
  const difficulty = { difficulty: 3, scoreId: 1, playLevel: 20, displayLevel: 20, noteCount: 20, file: "fixture" };
  const song: Song = { id: 1, musicType: 2, bestTags: [], bandIds: [], rankGroup: 1, difficulties: [difficulty], gekisoMissions: [0, 0, 0] };
  const chart = compileChart(data.master, song, difficulty, { durationMs: 21000,
    notes: Array.from({ length: 20 }, (_, i) => ({ timeMs: i * 1000, operateType: 1, judgementType: 1, judged: true })),
    skillTimesMs: [0, 4000, 8000, 12000, 16000], feverMs: [] });
  chart.ranks = [{ rank: 2, required: 0, battleRequired: 0 }, { rank: 3, required: 2200, battleRequired: 2200 }];
  const live = prepareLive(data.master, chart);
  return { ...data, chart, live, play: AP };
}

test("a deadline returns exact candidates with an honest unresolved bound", t => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const input: SearchInput<null> = { ...fixture(7, 0), k: 1, timeLimitMs: 1,
    objective: { skill: () => [0, 0], memberBonus: () => 0, snapBonus: () => 0, bound: () => 200,
      interval: () => [0, 200], exact: () => { clock += 2; return { key: 100, detail: null }; } } };
  const result = searchTeams(input);
  assert.equal(result.proven, false);
  assert.equal(result.bound, 200);
  assert.deepEqual(keys(result.hits), [100]);
});

test("live mean, peak and floor searches agree with full team enumeration", () => {
  const data = liveFixture();
  for (const criterion of ["mean", "min", "max"] as const)
    check({ ...data, objective: liveScoreObjective(data, criterion), k: 3 });
});

test("score caps agree with exhaustive search", () => {
  const data = liveFixture();
  check({ ...data, objective: scoreCapObjective(data), k: 3 });
});

test("live reward bounds, joint targets and the mean-score tie search retain the optimum", () => {
  const data = liveFixture();
  for (const measure of ["points", "items"] as const) {
    const other = measure === "points" ? 1 : 0;
    const objective = eventObjective(data, route([effect(2, 1, other, 10000)], "live"), measure, 2);
    const result = check({ ...data, objective, k: 3 });
    for (const hit of result.hits) {
      let skill = 0, skillLow = 0;
      hit.team.members.forEach((member, slot) => {
        const [low, high] = objective.skill(member, hit.team.snaps[slot]!); skill += high; skillLow += low;
      });
      const totals = { ...hit.totals, skill, skillLow };
      assert.ok(objective.bound(totals) >= hit.key);
      const options = hit.team.members.map(() => [-1, ...data.snaps.map((_, i) => i)]);
      const bound = objective.assignmentBound?.(hit.team.members, options);
      for (let from = 0; from <= 5; from++)
        if (bound) assert.ok(bound(totals, hit.team.snaps, from) >= hit.key);
      assert.ok(objective.leafBound!(hit.team, totals) >= hit.key);
      assert.ok(objective.jointTargets!(hit.key).some(target => target.bonus <= totals.bonus && target.product <= totals.power * (objective.productBase! + totals.skill)));
    }
    const target = result.hits[0]!.key;
    const tie = eventScoreTieObjective(data, objective, target);
    check({ ...data, objective: tie, k: 1, seeds: [result.hits[0]!.team], floor: 0 });
  }
});

test("exact-reward searches preserve weaker snaps and do not repeat a higher-reward member set", () => {
  const data = liveFixture();
  data.snaps = fixture(5, 6).snaps;
  const members: number[] = [0, 1, 2, 3, 4];
  const lower: Team = { members, snaps: [5, -1, -1, -1, -1] };
  const event = eventObjective(data, route([effect(3, 6, 0, 10000)], "live"), "points", 2);
  const power = teamPower(data.master, data.player, members.map(i => data.members[i]!), lower.snaps.map(i => i < 0 ? null : data.snaps[i]!), 0, null);
  const target = event.exact(lower, power.total, power.slots).key;
  const tie = eventScoreTieObjective(data, event, target);
  const result = check({ ...data, objective: tie, k: 1, floor: 0 });
  assert.ok(result.hits[0]!.team.snaps.includes(5));
  const excluding = eventScoreTieObjective(data, event, target, [result.hits[0]!.team]);
  const next = check({ ...data, objective: excluding, k: 1, floor: 0 });
  assert.notDeepEqual([...next.hits[0]!.team.members].sort(), [...result.hits[0]!.team.members].sort());
});

test("the real engine entry ranks event results by reward, other reward, then mean score", async () => {
  const data = liveFixture();
  const { master, chart } = data;
  master.members = new Map(data.members.map(member => [member.card.id, member.card]));
  master.memberLevels = new Map([[1, new Map([[1, [10000, 10000, 10000] as const]])]]);
  master.memberRanks = new Map([[1, new Map([[1, { rates: [0, 0, 0] as const, leaderSkillLevel: 1, musicTypeRate: 0, musicTagRate: 0 }]])]]);
  master.songs = new Map([[chart.song.id, chart.song]]);
  master.scoreRanks = new Map([[1, chart.ranks]]);
  const effects = [effect(2, 1, 1, 10000), effect(2, 2, 0, 10000)];
  const rewards = route(effects, "live");
  master.events = new Map([[1, { id: 1, startAt: null, endAt: null, musicId: 1, itemId: 1, effects,
    livePoints: rewards.points, challengePoints: rewards.points, liveRewards: rewards.rewards, challengeRewards: rewards.rewards }]]);
  const cache = new ChartCache(master, async () => ({ durationMs: chart.durationMs,
    notes: Array.from(chart.times, timeMs => ({ timeMs, operateType: 1, judgementType: 1, judged: true })),
    skillTimesMs: chart.skillTimes, feverMs: chart.feverMs }));
  const request: EngineRequest = { members: data.members.map(member => ({ key: member.key, cardId: member.card.id, ...member.growth })),
    snaps: [], unknownPolicy: "min", player: { characterRanks: {}, characterTotalRank: 0, bandItems: {}, vipRank: 0, characterMemory: {}, musicMemory: {} },
    goal: { kind: "event", measure: "points", route: "live", eventId: 1, songs: [{ songId: 1, difficulty: 3 }], consumption: 0, play: AP },
    constraints: { requiredMembers: [], excludedMembers: [], requiredSnaps: [], excludedSnaps: [], leader: null, bindings: [], noSnaps: true, minBonusPercent: null },
    k: 3, timeLimitMs: null };
  const objective = eventObjective(data, rewards, "points", 2);
  const compare = (a: SearchHit<EventDetail | { bonus: number; mean: number }>, b: SearchHit<EventDetail | { bonus: number; mean: number }>) =>
    b.key - a.key || (b.detail as EventDetail).scores.mean - (a.detail as EventDetail).scores.mean;
  const expected = exhaustive({ ...data, objective, k: 3 }, compare);
  const actual = await runEngine(master, cache, request);
  assert.equal(actual.results[0]!.proven, true);
  assert.deepEqual(actual.overall.map(hit => [hit.key, hit.score!.mean]), expected.map(hit => [hit.key, (hit.detail as EventDetail).scores.mean]));
  assert.equal(new Set(actual.overall.map(hit => [...hit.members].sort().join(","))).size, 3);
  const primaryRequest: EngineRequest = { ...request, k: 1, goal: { ...request.goal as Extract<EngineRequest["goal"], { kind: "event" }>, ranking: "primary" } };
  const primary = await runEngine(master, cache, primaryRequest);
  const primaryExpected = exhaustive({ ...data, objective: eventObjective(data, rewards, "points", 2, 0, Infinity, "primary"), k: 1 });
  assert.equal(primary.overall[0]!.key, primaryExpected[0]!.key);
  const cutoff = { key: primary.overall[0]!.key, contextKey: "test", ranking: "reward-song-difficulty-v1" as const, comparison: "gt" as const };
  const excluded = await runEngine(master, cache, { ...primaryRequest, contextKey: "test", cutoff });
  assert.deepEqual(excluded.results[0]!.exclusion, cutoff);
  const tied = await runEngine(master, cache, { ...primaryRequest, contextKey: "test", cutoff: { ...cutoff, comparison: "gte" } });
  assert.equal(tied.overall[0]!.key, cutoff.key);
  const expired = await runEngine(master, new ChartCache(master, async () => { throw Error("must not load charts"); }), { ...primaryRequest, deadline: 0 });
  assert.equal(expired.overall.length, 0);
  assert.equal(expired.results[0]!.proven, false);
  const resumed = await runEngine(master, new ChartCache(master, async () => { throw Error("completed chart must not reload"); }), { ...primaryRequest, completed: primary.results });
  assert.equal(resumed.overall[0]!.key, cutoff.key);
  let powerCandidate: EngineHit | undefined;
  const power = await runEngine(master, cache, { ...request, goal: { kind: "power", song: null, challengeEventId: null }, k: 1 }, undefined,
    snapshot => { powerCandidate = snapshot.response.overall[0]; });
  assert.ok(powerCandidate);
  assert.equal(powerCandidate.key, powerCandidate.power);
  assert.equal(power.results[0]!.proven, true);


});

test("merging equal-reward duplicates always keeps the higher mean score", () => {
  const hit = (mean: number): EngineHit => ({ members: ["a", "b", "c", "d", "e"], snaps: [null, null, null, null, null],
    song: { songId: 1, difficulty: 3 }, key: 100, power: 1000, slotPowers: [], skipScore: null, event: null, potential: null,
    score: { mean, min: mean, max: mean, median: mean, worstOrder: [], bestOrder: [], orders: [], ranks: {} } });
  const response = (mean: number): EngineResponse => ({ unknownCards: [], elapsedMs: 0, overall: [hit(mean)], results: [{
    song: { songId: 1, difficulty: 3 }, proven: true, bound: null, hits: [hit(mean)],
    stats: { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 },
  }] });
  for (const means of [[100, 200], [200, 100]]) {
    const merged = mergeShardResponses(means.map(response), 1, 0);
    assert.equal(merged.overall[0]!.score!.mean, 200);
    assert.equal(merged.results[0]!.proven, true);
  }
});
