/** Local reward jobs. A completed or certified-excluded chart is the smallest resumable unit. */
import type { EngineHit, EngineRequest, EngineResponse, SongRef, SongResult } from "./engine/api";
import { cpExchange } from "./engine/pt-value";

export const PT_VERSION = "solo-cp-rewards-v2";
export type PtMeasure = "points" | "items";
export type PtScope = "top-five" | "all";
export interface PtCycleInput {
  songs: SongRef[];
  consumption: number;
}
export type PtStatus = "queued" | "running" | "complete" | "empty" | "pruned" | "failed";
export interface PtTask {
  route: "live" | "challenge";
  measure: PtMeasure;
  song: SongRef;
  status: PtStatus;
  result: SongResult | null;
  error: string;
}
export interface PtJob {
  version: typeof PT_VERSION;
  id: string;
  fingerprint: string;
  dataFingerprint: string;
  owner: string;
  server: string;
  releaseId: string;
  sourceId: string;
  request: EngineRequest;
  cycle: PtCycleInput | null;
  /** Missing on older jobs, which retain their original exhaustive chart scope. */
  scope?: PtScope;
  assumptions: string[];
  createdAt: number;
  updatedAt: number;
  tasks: PtTask[];
}
/** Canonical JSON, including explicit Map/Set encoding; object insertion order cannot change identity. */
export function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Map)
      return [...item].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, normalize(v)]);
    if (item instanceof Set) return [...item].sort().map(normalize);
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const ptFingerprint = (
  request: EngineRequest,
  dataFingerprint: string,
  owner: string,
  cycle: PtCycleInput | null = null,
) => digest({ version: PT_VERSION, dataFingerprint, owner, request, cycle });

export async function createPtJob(
  request: EngineRequest,
  context: Pick<PtJob, "server" | "releaseId" | "sourceId" | "dataFingerprint" | "owner" | "assumptions">,
  cycle: PtCycleInput | null = null,
): Promise<PtJob> {
  if (
    request.goal.kind !== "event" ||
    request.goal.ranking !== "pt-only" ||
    request.goal.route !== "live" ||
    (request.goal.measure !== "points" && request.goal.measure !== "items")
  )
    throw new Error("pt-mode");
  if (cycle && (!cycle.songs.length || !Number.isSafeInteger(cycle.consumption) || cycle.consumption <= 0))
    throw new Error("pt-cycle-input");
  const tasks: PtTask[] = [];
  const add = (route: PtTask["route"], measures: readonly PtMeasure[], songs: SongRef[]) =>
    tasks.push(
      ...songs.flatMap((song) =>
        measures.map((measure): PtTask => ({
          route,
          measure,
          song: { ...song },
          status: "queued",
          result: null,
          error: "",
        })),
      ),
    );
  if (cycle) add("challenge", ["points", "items"], cycle.songs);
  add("live", cycle ? ["points", "items"] : [request.goal.measure], request.goal.songs);
  return {
    ...structuredClone(context),
    version: PT_VERSION,
    id: crypto.randomUUID(),
    fingerprint: await ptFingerprint(request, context.dataFingerprint, context.owner, cycle),
    request: structuredClone(request),
    cycle: structuredClone(cycle),
    scope: "top-five",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks,
  };
}
const chartKey = (song: SongRef) => `${song.songId}:${song.difficulty}`;
const compareHit = (a: EngineHit, b: EngineHit) =>
  b.key - a.key ||
  a.song!.songId - b.song!.songId ||
  a.song!.difficulty - b.song!.difficulty ||
  canonical([a.members, a.snaps]).localeCompare(canonical([b.members, b.snaps]));
export function ptSongRanking(job: PtJob, measure: PtMeasure = "points", route: PtTask["route"] = "live"): EngineHit[] {
  const songs = new Map<number, EngineHit>();
  for (const task of job.tasks) {
    if (task.status !== "complete" || task.measure !== measure || task.route !== route) continue;
    for (const hit of task.result?.hits ?? []) {
      if (!hit.song || !hit.event || !Number.isFinite(hit.event.mean)) continue;
      const previous = songs.get(hit.song.songId);
      if (!previous || compareHit(hit, previous) < 0) songs.set(hit.song.songId, hit);
    }
  }
  return [...songs.values()].sort(compareHit);
}
export function ptChallengeBest(job: PtJob, measure: PtMeasure): EngineHit | null {
  const tasks = job.tasks.filter((task) => task.route === "challenge" && task.measure === measure);
  if (
    !tasks.length ||
    !tasks.every((task) => (task.status === "complete" || task.status === "empty") && task.result?.proven)
  )
    return null;
  return ptSongRanking(job, measure, "challenge")[0] ?? null;
}
/** A threshold only exists after five different songs have exact, legal solutions. */
export function ptCutoff(job: PtJob, measure: PtMeasure): number | undefined {
  const ranking = ptSongRanking(job, measure);
  return ranking.length >= 5 ? ranking[4]!.key : undefined;
}
const chartComplete = (task: PtTask) =>
  (task.status === "complete" || task.status === "empty") && task.result?.proven === true;
const chartExcluded = (task: PtTask, cutoff: number | undefined) => {
  const excluded = task.result?.excludedBelow;
  return (
    task.route === "live" &&
    task.status === "pruned" &&
    excluded !== undefined &&
    Number.isFinite(excluded) &&
    cutoff !== undefined &&
    excluded <= cutoff &&
    task.result?.hits.length === 0 &&
    task.result.proven === false
  );
};
export const ptAllComplete = (job: PtJob) => job.tasks.length > 0 && job.tasks.every(chartComplete);
export const ptComplete = (job: PtJob) => {
  if (!job.tasks.length) return false;
  const cutoffs = { points: ptCutoff(job, "points"), items: ptCutoff(job, "items") };
  return job.tasks.every(
    (task) => chartComplete(task) || (job.scope === "top-five" && chartExcluded(task, cutoffs[task.measure])),
  );
};

export interface PtEngine {
  run(request: EngineRequest, progress?: (done: number, total: number) => void): Promise<EngineResponse>;
  cancel(): void;
}
export interface PtJobStore {
  save(job: PtJob): Promise<void>;
  latest(server: string, owner: string): Promise<PtJob | null>;
}
export class PtRunner {
  running = false;
  private stopped = false;
  constructor(
    private readonly engine: PtEngine,
    private readonly store: PtJobStore,
    private readonly changed: (job: PtJob) => void,
    private readonly storageFailed: () => void,
  ) {}
  stop() {
    this.stopped = true;
    this.engine.cancel();
  }
  async run(job: PtJob, scope: PtScope = job.scope ?? "all"): Promise<void> {
    if (this.running) throw new Error("pt-busy");
    this.running = true;
    this.stopped = false;
    job.scope = scope;
    // The page redraws at most four times a second and the resumable checkpoint is written at most once a second;
    // both are written once more at the end.
    let savedAt = 0;
    let shownAt = 0;
    const publish = async (force = false) => {
      job.updatedAt = Date.now();
      if (force || job.updatedAt - shownAt >= 250) {
        shownAt = job.updatedAt;
        this.changed(job);
      }
      if (!force && job.updatedAt - savedAt < 1000) return;
      savedAt = job.updatedAt;
      try {
        await this.store.save(job);
      } catch {
        this.storageFailed();
      }
    };
    try {
      const cutoffs = { points: ptCutoff(job, "points"), items: ptCutoff(job, "items") };
      for (const task of job.tasks)
        if (!chartComplete(task) && !(scope === "top-five" && chartExcluded(task, cutoffs[task.measure]))) {
          task.status = "queued";
          task.result = null;
          task.error = "";
        }
      await publish();
      const tasks = [...job.tasks].sort(
        (a, b) =>
          Number(a.route === "live") - Number(b.route === "live") ||
          a.song.songId - b.song.songId ||
          a.song.difficulty - b.song.difficulty ||
          Number(a.measure === "items") - Number(b.measure === "items"),
      );
      /** Runs one task; false once the run was stopped. */
      const step = async (task: PtTask): Promise<boolean> => {
        if (this.stopped) return false;
        if (chartComplete(task) || (scope === "top-five" && task.status === "pruned")) return true;
        const challenge = job.cycle && task.route === "live" ? ptChallengeBest(job, task.measure) : null;
        if (job.cycle && task.route === "live" && !challenge) return true;
        task.status = "running";
        await publish();
        if (this.stopped) {
          task.status = "queued";
          return false;
        }
        try {
          const request = structuredClone(job.request);
          if (request.goal.kind !== "event") throw new Error("pt-mode");
          request.goal.songs = [task.song];
          request.goal.route = task.route;
          request.goal.measure = task.measure;
          delete request.rewardCutoff;
          const cutoff = scope === "top-five" && task.route === "live" ? ptCutoff(job, task.measure) : undefined;
          // Tasks run in song order and equal rewards rank by song, so a later song only enters the top five by
          // beating the fifth reward: a tie is pruned at the root instead of searched to proof.
          if (cutoff !== undefined) request.rewardCutoff = cutoff + Math.max(1, Math.abs(cutoff)) * 1e-9;
          if (task.route === "challenge") {
            request.goal.consumption = job.cycle!.consumption;
            delete request.goal.gekiso;
          }
          if (challenge)
            request.goal.cpExchange = cpExchange(
              challenge.event!.rewardSum!,
              challenge.event!.orders!,
              job.cycle!.consumption,
            );
          const response = await this.engine.run(request);
          if (this.stopped) {
            task.status = "queued";
            return false;
          }
          const result = response.results.find((r) => r.song && chartKey(r.song) === chartKey(task.song));
          if (!result) throw new Error("pt-incomplete");
          if (result.excludedBelow !== undefined) {
            task.result = result;
            task.status = "pruned";
            await publish();
            return true;
          }
          if (!result.proven) throw new Error("pt-incomplete");
          task.result = result;
          task.status = result.hits.length ? "complete" : "empty";
        } catch (error) {
          if (this.stopped) {
            task.status = "queued";
            return false;
          }
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
        await publish();
        return true;
      };
      // Points and medals rank separately, so their song sequences run side by side. Within one, two live songs are
      // in flight: each starts under the cutoff of songs that started before it, so pruning stays valid.
      const lane = async (measure: PtMeasure) => {
        const own = tasks.filter((task) => task.measure === measure);
        for (const task of own.filter((entry) => entry.route === "challenge")) if (!(await step(task))) return;
        const live = own.filter((entry) => entry.route === "live");
        let next = 0;
        const runner = async () => {
          while (next < live.length && !this.stopped) if (!(await step(live[next++]!))) return;
        };
        await Promise.all([runner(), runner()]);
      };
      await Promise.all((["points", "items"] as const).map(lane));
    } finally {
      for (const task of job.tasks) if (task.status === "running") task.status = "queued";
      this.running = false;
      await publish(true);
    }
  }
}
