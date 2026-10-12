import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineRequest, EngineHit, EngineResponse } from "../../src/lib/team-builder/engine/api";
import { EngineClient } from "../../src/lib/team-builder/engine/client";
import { clock, emptyResponse, pendingSong, acceptsReward, excludesBound } from "../../src/lib/team-builder/engine/execution";
import type { EngineCall, EngineReply } from "../../src/lib/team-builder/engine/protocol";
import type { TeamBuilderData } from "../../src/lib/team-builder/data";
import { createPtJob, PtRunner, ptComplete, ptSongRanking, ptTaskCutoff, chartExcluded } from "../../src/lib/team-builder/pt-recommendation";

const request = (): EngineRequest => ({
  members: [], snaps: [], player: { characterRanks: {}, characterTotalRank: 0, bandItems: {}, vipRank: 0, characterMemory: {}, musicMemory: {} },
  unknownPolicy: "min", goal: { kind: "event", ranking: "pt-only", measure: "points", route: "live", eventId: 1, songs: [{ songId: 1, difficulty: 3 }], consumption: 1, play: { great: 0, good: 0, bad: 0, miss: 0 } },
  constraints: { requiredMembers: [], excludedMembers: [], requiredSnaps: [], excludedSnaps: [], leader: null, bindings: [], noSnaps: false, minBonusPercent: null }, k: 1, timeLimitMs: 80,
});
const hit = (songId = 1, difficulty = 3, key = 100): EngineHit => ({ song: { songId, difficulty }, members: ["a", "b", "c", "d", "e"], snaps: [null, null, null, null, null], key, power: 10, slotPowers: [], score: null, skipScore: null, potential: null,
  event: { mean: key, bonusPercent: 0, challengePoints: 0, perPlayMin: key, perPlayMax: key } });
const response = (input: EngineRequest, proven = false): EngineResponse => {
  const result = emptyResponse(input);
  const song = result.results[0]!.song!;
  result.results[0]!.hits = [hit(song.songId, song.difficulty)];
  result.results[0]!.proven = proven;
  result.overall = result.results[0]!.hits;
  return result;
};
const context = { server: "intl", releaseId: "r", sourceId: "s", dataFingerprint: "data", owner: "local", assumptions: [] };

test("cutoffs keep equal rewards when an earlier song or difficulty can win, independent of dispatch order", async () => {
  const input = request();
  if (input.goal.kind !== "event") throw Error();
  input.goal.songs = [{ songId: 2, difficulty: 4 }, { songId: 1, difficulty: 4 }, { songId: 2, difficulty: 3 }];
  const job = await createPtJob(input, context);
  const completed = job.tasks[0]!;
  completed.result = { ...pendingSong(completed.song), hits: [hit(2, 4)], proven: true };
  completed.status = "complete";
  const initialCutoffs = job.tasks.slice(1).map(task => ptTaskCutoff(job, task)!);
  for (const [index, task] of job.tasks.slice(1).entries()) {
    const cutoff = initialCutoffs[index]!;
    assert.equal(cutoff.comparison, "gte");
    assert.equal(acceptsReward(100, cutoff), true);
    assert.equal(excludesBound(100, cutoff), false);
    task.result = { ...pendingSong(task.song), hits: [hit(task.song.songId, task.song.difficulty)], proven: true };
    task.status = "complete";
  }
  assert.deepEqual(ptSongRanking(job).map(item => item.song), [{ songId: 1, difficulty: 4 }, { songId: 2, difficulty: 3 }]);
  const later = job.tasks[0]!;
  const cutoff = ptTaskCutoff(job, later)!;
  assert.equal(cutoff.comparison, "gt");
  assert.equal(excludesBound(100, cutoff), true);
  later.status = "pruned";
  later.result = { ...pendingSong(later.song), exclusion: cutoff };
  assert.equal(chartExcluded(job, later), true);
  later.result.exclusion = { ...cutoff, contextKey: "another inventory" };
  assert.equal(chartExcluded(job, later), false);
});

test("completed activity checkpoints resume without running; partial candidates persist on cancellation", async () => {
  const job = await createPtJob(request(), context);
  let calls = 0;
  const runner = new PtRunner({ run: async input => { calls++; return response(input, true); }, cancel() {} }, { save: async () => {}, latest: async () => null }, () => {}, () => {});
  await runner.run(job, "top-one", Infinity);
  assert.equal(ptComplete(job), true);
  await runner.run(job, "top-one", Infinity);
  assert.equal(calls, 1);
  const partial = await createPtJob(request(), context);
  const cancel = new PtRunner({ run: async (input, _progress, snapshot) => {
    const result = response(input);
    snapshot?.({ requestId: "test", contextKey: partial.fingerprint, response: result, coverage: { completed: 0, total: 1 } });
    cancel.stop();
    return { ...emptyResponse(input), stopReason: "cancelled" };
  }, cancel() {} }, { save: async () => {}, latest: async () => null }, () => {}, () => {});
  await cancel.run(partial, "top-one", Infinity);
  assert.equal(partial.tasks[0]!.result?.hits.length, 1);
  assert.equal(ptComplete(partial), false);
});

test("the worker queue shares initialization and run deadlines, keeps snapshots and ignores late messages", async () => {
  const original = globalThis.Worker;
  let initialized = 0, terminated = 0, running = 0, maximum = 0;
  const sent: EngineRequest[] = [];
  class FakeWorker {
    onmessage?: (event: { data: EngineReply }) => void;
    onerror?: (event: { message: string }) => void;
    live = false;
    postMessage(call: EngineCall) {
      if (call.type === "init") { initialized++; setTimeout(() => this.onmessage?.({ data: { type: "ready", id: call.id } }), 20); return; }
      if (call.type !== "run") return;
      sent.push(call.request);
      this.live = true; maximum = Math.max(maximum, ++running);
      const result = response(call.request);
      setTimeout(() => this.onmessage?.({ data: { type: "snapshot", id: call.id, snapshot: { requestId: call.request.requestId!, contextKey: call.request.contextKey!, response: result, coverage: { completed: 0, total: 1 } } } }), 5);
      setTimeout(() => this.onmessage?.({ data: { type: "result", id: call.id, result: { ...result, overall: [hit(999)] } } }), 110);
    }
    terminate() { terminated++; if (this.live) { running--; this.live = false; } }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const client = new EngineClient({ identity: context } as unknown as TeamBuilderData);
  try {
    const started = clock();
    let first = Infinity;
    const a = client.run(request(), undefined, snapshot => { if (snapshot.response.overall.length) first = Math.min(first, clock() - started); });
    const b = client.run({ ...request(), deadline: started + 40 });
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.stopReason, "budget");
    assert.equal(one.overall[0]?.key, 100);
    assert.equal(two.stopReason, "budget");
    assert.equal(two.overall.length, 0);
    assert.equal(two.results[0]!.proven, false);
    assert.ok(first < 80);
    assert.ok(clock() - started < 200);
    assert.equal(initialized, 1);
    assert.equal(maximum, 1);
    assert.equal(sent.length, 1);
    assert.ok(terminated >= 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(one.overall[0]?.song?.songId, 1);
  } finally { client.dispose(); globalThis.Worker = original; }
});

test("quick run, shards and retry cannot extend the task deadline", async () => {
  const original = globalThis.Worker;
  const calls: EngineRequest[] = [];
  class FakeWorker {
    onmessage?: (event: { data: EngineReply }) => void;
    postMessage(call: EngineCall) {
      if (call.type === "init") { queueMicrotask(() => this.onmessage?.({ data: { type: "ready", id: call.id } })); return; }
      if (call.type !== "run") return;
      calls.push(call.request);
      if (call.request.noFloor) return;
      const result = emptyResponse(call.request);
      result.results[0]!.floor = 100;
      queueMicrotask(() => this.onmessage?.({ data: { type: "result", id: call.id, result } }));
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const client = new EngineClient({ identity: context } as unknown as TeamBuilderData);
  try {
    const input = request();
    input.members = Array.from({ length: 16 }, (_, i) => ({ key: `m${i}`, cardId: i, level: 1, awake: 0, rank: 0, liveSkillLevel: 1, gekisoSkillLevel: 1 }));
    input.deadline = clock() + 100;
    const result = await client.run(input);
    assert.equal(result.stopReason, "budget");
    assert.ok(calls.some(call => call.shard));
    assert.ok(calls.some(call => call.noFloor));
    assert.ok(calls.every(call => call.deadline! <= input.deadline!));
    assert.ok(calls.filter(call => call.shard || call.noFloor).every(call => call.deadline === input.deadline));
    assert.equal(result.results[0]!.proven, false);
  } finally { client.dispose(); globalThis.Worker = original; }
});
