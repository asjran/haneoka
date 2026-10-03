import type { SearchBudget } from "../contracts.ts";

/** Budget validation also runs before a complete checkpoint is restored. */
export function validateSearchBudget(budget: SearchBudget): void {
  for (const name of ["maxEvaluations", "maxMilliseconds", "maxCandidates"] as const)
    if (!Number.isSafeInteger(budget?.[name]) || budget[name] < 1) throw new RangeError(`budget:${name}`);
  for (const [name, value] of Object.entries(budget))
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`budget:${name}`);
  if (budget.maxCandidates > 1000 || budget.maxMilliseconds > 60000 || budget.maxEvaluations > 2000000)
    throw new RangeError("solver-budget-size");
}
