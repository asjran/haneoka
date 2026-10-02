import type { SolverRequest, SolverResponse } from "../contracts.ts";
import { optimizeTeams } from "../optimizer.ts";
import { getTeamBuilderCapabilities } from "./capabilities.ts";
import { prepareEvaluationForSearch } from "./evaluation.ts";
import { loadSongOptions } from "./song-loader.ts";
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SolverRequest>) => void) | null;
  postMessage(message: SolverResponse): void;
};
let active: { runId: string; cancelled: boolean; controller: AbortController } | null = null;
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    if (active?.runId === message.runId) {
      active.cancelled = true;
      active.controller.abort();
    }
    return;
  }
  if (message.type !== "start" && message.type !== "prepare") return;
  if (active) {
    active.cancelled = true;
    active.controller.abort();
  }
  const run = { runId: message.runId, cancelled: false, controller: new AbortController() };
  active = run;
  const execute = async () => {
    let input;
    let evaluate;
    if (message.type === "prepare") {
      scope.postMessage({
        type: "progress",
        runId: run.runId,
        progress: { phase: "loading", evaluated: 0, elapsedMs: 0 },
      });
      const songs = await loadSongOptions(message.request.data, message.request.selections, run.controller.signal);
      if (active !== run) return;
      if (run.cancelled) {
        scope.postMessage({
          type: "result",
          runId: run.runId,
          result: { candidates: [], completeness: "cancelled", evaluated: 0, elapsedMs: 0, gaps: [] },
        });
        active = null;
        return;
      }
      ({ input, evaluate } = prepareEvaluationForSearch({ ...message.request, songs }));
    } else input = message.input;
    const result = await optimizeTeams(input, {
      evaluate,
      cancelled: () => run.cancelled,
      progress: (progress) => {
        if (active === run) scope.postMessage({ type: "progress", runId: run.runId, progress });
      },
    });
    if (active === run) {
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: { ...result, capabilities: getTeamBuilderCapabilities(input) },
      });
      active = null;
    }
  };
  void execute().catch((error: unknown) => {
    if (active === run) {
      if (run.cancelled)
        scope.postMessage({
          type: "result",
          runId: run.runId,
          result: { candidates: [], completeness: "cancelled", evaluated: 0, elapsedMs: 0, gaps: [] },
        });
      else
        scope.postMessage({
          type: "error",
          runId: run.runId,
          code: error instanceof Error ? error.message : "solver-error",
        });
      active = null;
    }
  });
};
