import { compareRuns, searchRuns, type ComparisonResult, type Dataset, type RunSearchRequest } from "./evidence.ts";

export const rankingRuleVersion = "1";

type ConditionMatch = Pick<ComparisonResult["rows"][number], "key" | "label" | "status" | "reason">;

export type RankedCandidate = {
  runId: string;
  score: number | null;
  comparableCount: number;
  sameCount: number;
  differentCount: number;
  unknownCount: number;
  incompatibleCount: number;
  conditions: ConditionMatch[];
};

/** Rank exact recorded-condition matches for a known reference; null indicates an unknown reference ID. */
export function rankCandidates(
  dataset: Dataset,
  referenceRunId: string,
  search?: RunSearchRequest,
): RankedCandidate[] | null {
  if (!dataset.runs.some(({ id }) => id === referenceRunId)) return null;

  const ranked = searchRuns(dataset, search)
    .filter(({ id }) => id !== referenceRunId)
    .map(({ id: runId }) => {
      const { rows } = compareRuns(dataset, { runIds: [referenceRunId, runId] });
      const conditions = rows
        .filter(({ cells }) => cells[0].field?.kind === "condition")
        .map(({ key, label, status, reason }) => ({ key, label, status, reason }));

      const counts = { same: 0, different: 0, unknown: 0, incompatible: 0 };
      for (const { status } of conditions) counts[status]++;
      const comparableCount = counts.same + counts.different;

      return {
        runId,
        score: comparableCount === 0 ? null : counts.same / comparableCount,
        comparableCount,
        sameCount: counts.same,
        differentCount: counts.different,
        unknownCount: counts.unknown,
        incompatibleCount: counts.incompatible,
        conditions,
      };
    });

  return ranked.sort((left, right) => {
    const byScore = (right.score ?? -1) - (left.score ?? -1);
    const byCoverage = right.comparableCount - left.comparableCount;
    const byId = left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
    return byScore || byCoverage || byId;
  });
}
