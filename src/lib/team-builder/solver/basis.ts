import type { EvaluationBasis, EvaluationBasisRequest, MetricValue, Objective } from "../contracts.ts";

/** Time/cost denominators are supplied explicitly; chart last-note time is not
 * silently treated as audio duration or as one player's actual consumption.
 */
export function applyEvaluationBasis(
  metric: MetricValue,
  objective: Objective,
  songKey: string,
  request: EvaluationBasisRequest = { kind: "single" },
): MetricValue {
  let basis: EvaluationBasis;
  if (request.kind === "single") basis = { kind: "single", denominator: 1, unit: "play", source: "one-play" };
  else if (request.kind === "time") {
    const seconds = request.secondsBySong[songKey];
    const valid =
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds > 0 &&
      Number.isFinite(request.downtimeSeconds) &&
      request.downtimeSeconds >= 0 &&
      !!request.source;
    basis = {
      kind: "time",
      denominator:
        valid && Number.isFinite(seconds + request.downtimeSeconds) ? seconds + request.downtimeSeconds : null,
      unit: "second",
      source: request.source,
    };
  } else {
    const valid = Number.isSafeInteger(request.amount) && request.amount > 0 && !!request.source;
    basis = {
      kind: "consumption",
      denominator: valid ? request.amount : null,
      unit: request.resource,
      source: request.source,
    };
  }
  const result = {
    ...metric,
    perPlayValue: metric.value,
    basis,
    assumptions: [...metric.assumptions],
    gaps: [...metric.gaps],
  };
  if (metric.value === null) return result;
  if (basis.denominator === null || (objective === "ss-surplus" && basis.kind !== "single")) {
    result.value = null;
    result.status = "unavailable";
    result.gaps.push({
      code: objective === "ss-surplus" ? "ss-surplus-requires-per-play-basis" : "evaluation-denominator-unresolved",
      source: basis.source,
    });
    return result;
  }
  result.value = metric.value / basis.denominator;
  if (basis.kind !== "single") {
    result.status = "conditional";
    result.assumptions.push("explicit-efficiency-denominator");
  }
  return result;
}
