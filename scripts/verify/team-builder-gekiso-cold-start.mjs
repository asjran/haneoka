import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
if (!options.has("--data") || !options.has("--charts"))
  throw Error(
    "Usage: node scripts/verify/team-builder-gekiso-cold-start.mjs --data DTO.json --charts saved-chart-directory [--runs 3] [--songs 100076,100110] [--output receipt.json]",
  );
const root = fileURLToPath(new URL("../../", import.meta.url));
const dataPath = resolve(options.get("--data"));
const chartsPath = resolve(options.get("--charts"));
const runs = Number(options.get("--runs") ?? 3);
const songs = (options.get("--songs") ?? "100076,100110").split(",").map(Number);
assert.ok(Number.isInteger(runs) && runs > 0);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(dataPath);
const data = JSON.parse(bytes);
const directory = await mkdtemp(join(tmpdir(), "haneoka-luck-cold-"));
const workerFile = join(directory, "worker.mjs");
const clientFile = join(directory, "client.mjs");
const bootstrapFile = join(directory, "bootstrap.mjs");
const activeWorkers = new Set();
const originalWorker = globalThis.Worker;
try {
  await build({
    entryPoints: [join(root, "src/lib/team-builder/engine/worker.ts")],
    outfile: workerFile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await build({
    stdin: {
      contents: `export {EngineClient} from './src/lib/team-builder/engine/client'; export {compileFromTeamData} from './src/lib/team-builder/engine/master'; export {theoreticalBox} from './src/lib/team-builder/engine/box'; export {playerState,musicView} from './src/lib/team-builder/engine/api'; export {teamPower} from './src/lib/team-builder/engine/power'; export {performer} from './src/lib/team-builder/engine/full/deck'; export {resolveSlotSkill} from './src/lib/team-builder/engine/skills'; export {gekisoChart,gekisoContext,scoreOrdersGekiso} from './src/lib/team-builder/engine/gekiso'; export {convertChartBytes} from './src/lib/team-builder/engine/chart';`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: clientFile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await writeFile(
    bootstrapFile,
    `import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
globalThis.self={postMessage:message=>parentPort.postMessage(message)};
globalThis.fetch=async url=>{
const match=String(url).match(/MusicScore\\/\\d+\\/(\\d+)_03/);
if(!match)throw Error('Unknown saved chart: '+url);
return new Response(fs.readFileSync(path.join(workerData.charts,'h-chart-'+(100000+Number(match[1]))+'03.bytes')));
};
const queued=[];let ready=false;
parentPort.on('message',data=>ready?self.onmessage({data}):queued.push(data));
await import('./worker.mjs');ready=true;for(const data of queued)self.onmessage({data});
`,
  );
  class BrowserWorker {
    constructor() {
      this.worker = new Worker(bootstrapFile, { workerData: { charts: chartsPath } });
      activeWorkers.add(this.worker);
      this.worker.on("exit", () => activeWorkers.delete(this.worker));
      this.worker.on("message", (message) => this.onmessage?.({ data: message }));
      this.worker.on("error", (error) => this.onerror?.({ message: error.message }));
    }
    postMessage(message) {
      this.worker.postMessage(message);
    }
    terminate() {
      void this.worker.terminate();
    }
  }
  globalThis.Worker = BrowserWorker;
  const api = await import(pathToFileURL(clientFile));
  const master = api.compileFromTeamData(data);
  const box = api.theoreticalBox(master);
  assert.equal(box.members.length, master.members.size);
  assert.equal(box.snaps.length, master.snaps.size);
  assert.deepEqual(box.unknown, []);
  const request = {
    members: box.members.map((member) => ({ key: member.key, cardId: member.card.id, ...member.growth })),
    snaps: box.snaps.map((snap) => ({ key: snap.key, cardId: snap.card.id, ...snap.growth })),
    player: {
      characterRanks: Object.fromEntries([...master.characters.keys()].map((id) => [id, 1])),
      characterTotalRank: master.characters.size,
      vipRank: 1,
      bandItems: Object.fromEntries([...master.bandItems.keys()].map((id) => [id, 0])),
      characterMemory: {},
      musicMemory: {},
    },
    unknownPolicy: "min",
    constraints: {
      requiredMembers: [],
      excludedMembers: [],
      requiredSnaps: [],
      excludedSnaps: [],
      leader: null,
      bindings: [],
      noSnaps: false,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs: 3000,
  };
  const observations = [];
  for (const songId of songs) {
    const song = master.songs.get(songId);
    assert.ok(song?.gekisoMissions.includes(2), "Expected a Luck chart");
    const difficulty = song.difficulties.find((value) => value.difficulty === 3);
    const chartBytes = await readFile(join(chartsPath, `h-chart-${songId}03.bytes`));
    const chart = api.gekisoChart(
      master,
      await api.convertChartBytes(chartBytes),
      difficulty.playLevel,
      song.gekisoMissions,
      { great: 0, just: 0, missEvery: 0 },
      1,
    );
    for (let run = 0; run < runs; run++) {
      const client = new api.EngineClient(data);
      const input = {
        ...request,
        contextKey: `luck-cold:${songId}:${run}`,
        goal: {
          kind: "gekiso",
          songs: [{ songId, difficulty: 3 }],
          criterion: "mean",
          accuracy: { great: 0, just: 0, missEvery: 0 },
          rank: 1,
          seeds: 0,
        },
      };
      const started = performance.now();
      let firstCandidateMs = null;
      const cold = await client.run(input, undefined, (snapshot) => {
        if (firstCandidateMs === null && snapshot.response.overall.length)
          firstCandidateMs = performance.now() - started;
      });
      const coldMs = performance.now() - started;
      assert.ok(
        firstCandidateMs !== null && firstCandidateMs < input.timeLimitMs,
        "No settled candidate before deadline",
      );
      assert.ok(cold.overall.length > 0);
      assert.equal(cold.results[0].proven, false);
      const candidate = cold.overall[0];
      const members = candidate.members.map((key) => box.members.find((member) => member.key === key));
      const snaps = candidate.snaps.map((key) => (key === null ? null : box.snaps.find((snap) => snap.key === key)));
      assert.equal(new Set(members.map((member) => member.card.characterId)).size, 5);
      assert.equal(new Set(candidate.snaps.filter(Boolean)).size, candidate.snaps.filter(Boolean).length);
      const power = api.teamPower(
        master,
        api.playerState(master, input.player),
        members,
        snaps,
        0,
        api.musicView(master, songId, null),
        [],
      );
      const deck = members.map((member, i) => api.performer(master, member, snaps[i]));
      const skills = members.map((member, i) => api.resolveSlotSkill(master, member, snaps[i]));
      const scores = api.scoreOrdersGekiso(
        master,
        chart,
        api.gekisoContext(master, chart, deck, []),
        power.total,
        skills,
      );
      assert.equal(candidate.power, power.total);
      assert.ok(Math.abs(candidate.key - scores.mean) < 1e-6, "Candidate did not use the settled expectation scorer");
      const continuationStart = performance.now();
      const continuation = await client.run({ ...input, seeds: cold.overall });
      const continuationMs = performance.now() - continuationStart;
      assert.ok(continuation.overall[0].key >= candidate.key);
      assert.ok(continuationMs < input.timeLimitMs + 250, "Continuation exceeded the shared deadline");
      client.dispose();
      const row = {
        songId,
        run,
        firstCandidateMs,
        coldMs,
        continuationMs,
        key: candidate.key,
        continuedKey: continuation.overall[0].key,
        candidate: { members: candidate.members, snaps: candidate.snaps, power: candidate.power },
        directScore: scores.mean,
        chartSha256: hash(chartBytes),
        stopReason: cold.stopReason,
      };
      observations.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const sourceFiles = [
    "src/lib/team-builder/engine/gekiso-objective.ts",
    "src/lib/team-builder/engine/gekiso.ts",
    "src/lib/team-builder/engine/full/luck.ts",
    "src/lib/team-builder/engine/client.ts",
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(join(root, file)))])),
  );
  const receipt = {
    schema: "haneoka-luck-cold-start-verification-v1",
    identity: data.identity,
    dataSha256: hash(bytes),
    members: box.members.length,
    snaps: box.snaps.length,
    sourceSha256,
    request,
    observations,
    scope:
      "Actual client and bundled production Worker, fresh Worker pool per cold sample, saved chart transport; no browser DOM or global-optimum claim.",
  };
  if (options.has("--output"))
    await writeFile(resolve(options.get("--output")), JSON.stringify(receipt, null, 2) + "\n");
} finally {
  globalThis.Worker = originalWorker;
  await Promise.all([...activeWorkers].map((worker) => worker.terminate()));
  const cleanupPath = await realpath(directory);
  assert.equal(dirname(cleanupPath), await realpath(tmpdir()));
  assert.ok(basename(cleanupPath).startsWith("haneoka-luck-cold-"));
  await rm(cleanupPath, { recursive: true, force: true });
}
