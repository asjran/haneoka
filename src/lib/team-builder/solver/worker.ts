import type { SolverRequest, SolverResponse } from "../contracts.ts";
import { optimizeTeams, validateOptimizationInput } from "../optimizer.ts";
import { getTeamBuilderCapabilities } from "./capabilities.ts";
import { prepareEvaluationForSearch } from "./evaluation.ts";
import { loadSongOptions } from "./song-loader.ts";
import { createSearchCheckpoint, restoreSearchCheckpoint, searchFingerprint } from "./search-checkpoint.ts";
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
    let fingerprint;
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
      const { budget: _budget, ...semanticRequest } = message.request;
      fingerprint = await searchFingerprint({ kind: "prepare", request: semanticRequest, songs });
      ({ input, evaluate } = prepareEvaluationForSearch({ ...message.request, songs }));
    } else {
      input = message.input;
      const { budget: _budget, ...semanticInput } = input;
      fingerprint = await searchFingerprint({ kind: "start", input: semanticInput });
    }
    if (active !== run) return;
    validateOptimizationInput(input);
    const restored = await restoreSearchCheckpoint(message.checkpoint, fingerprint);
    if (active !== run) return;
    if (restored && !run.cancelled) {
      scope.postMessage({
        type: "progress",
        runId: run.runId,
        progress: {
          phase: "complete",
          evaluated: restored.evaluated,
          elapsedMs: 0,
          candidateCount: restored.candidates.length,
          proofStatus: "proven",
        },
      });
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: restored,
        checkpoint: { ...message.checkpoint!, result: restored },
        reusedCheckpoint: true,
      });
      active = null;
      return;
    }
    const result = await optimizeTeams(input, {
      evaluate,
      cancelled: () => run.cancelled,
      progress: (progress) => {
        if (active === run) scope.postMessage({ type: "progress", runId: run.runId, progress });
      },
    });
    const completed = { ...result, capabilities: getTeamBuilderCapabilities(input) };
    const checkpoint = await createSearchCheckpoint(fingerprint, completed);
    if (active === run) {
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: checkpoint?.result ?? completed,
        ...(checkpoint ? { checkpoint } : {}),
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
