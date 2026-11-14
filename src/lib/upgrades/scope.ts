import { z } from "zod";
import {
  runSearchSchema,
  searchRuns,
  type Dataset,
  type Run,
  type RunSearchRequest,
} from "../evidence.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetVersionSchema,
  type CorpusValidationIssue,
} from "./provenance.ts";
import {
  isFieldKey,
  isCompatibleFilterValue,
  recordedValueSchema,
} from "./field-catalog.ts";
import { upgradeContractVersions } from "./versions.ts";

/** A bounded, distinct list of explicit runs. */
export const explicitRunIdsSchema = z.array(canonicalRunIdSchema).min(1).max(128)
  .refine((ids) => new Set(ids).size === ids.length, "Use distinct run IDs");

/** A single-run inspection or a two/three-run comparison selection. */
export const analysisRunIdsSchema = z.array(canonicalRunIdSchema).min(1).max(3)
  .refine((ids) => new Set(ids).size === ids.length, "Use distinct run IDs");
export const comparisonRunIdsSchema = z.array(canonicalRunIdSchema).min(2).max(3)
  .refine((ids) => new Set(ids).size === ids.length, "Use distinct run IDs");

export const runSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("inspection"),
    runId: canonicalRunIdSchema,
  }),
  z.strictObject({
    mode: z.literal("comparison"),
    runIds: comparisonRunIdsSchema,
  }),
]);
export type RunSelection = z.infer<typeof runSelectionSchema>;

export const activeFilterSchema = z.strictObject({
  key: z.string().min(1).max(64),
  value: recordedValueSchema,
});
export type ActiveFilter = z.infer<typeof activeFilterSchema>;

/**
 * How a result's rows were selected. The scope is resolved before plotting or
 * comparing; it is not the same thing as the two/three-run comparison
 * selection a visitor may make afterwards.
 */
export const runScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all-reviewed-runs") }),
  z.strictObject({
    kind: z.literal("filtered-results"),
    search: runSearchSchema,
  }),
  z.strictObject({
    kind: z.literal("explicit-runs"),
    runIds: explicitRunIdsSchema,
  }),
]);
export type RunScope = z.infer<typeof runScopeSchema>;

export type ResolvedRunScope = {
  datasetVersion: string;
  scopeKind: RunScope["kind"];
  runs: Run[];
  runIds: string[];
  search: RunSearchRequest | null;
  activeFilters: ActiveFilter[];
  scopeRuleVersion: typeof upgradeContractVersions.runScope;
};

export type RunScopeResolution =
  | { ok: true; resolved: ResolvedRunScope }
  | { ok: false; issues: CorpusValidationIssue[] };

/** Mirrors the existing explorer/API filter checks without importing server-only code. */
export function validateSearchAgainstDataset(
  dataset: Dataset,
  search: RunSearchRequest,
  path = "search",
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  for (const [index, filter] of (search.filters ?? []).entries()) {
    const fieldPath = `${path}.filters.${index}`;
    if (!isFieldKey(filter.key)) {
      issues.push(corpusIssue(`${fieldPath}.key`, "unknown-filter-field", `Unreviewed filter field: ${filter.key}`));
      continue;
    }
    const fields = dataset.runs.flatMap((run) => run.fields.filter((field) => field.key === filter.key));
    if (!fields.length) {
      issues.push(corpusIssue(`${fieldPath}.key`, "unknown-filter-field", `Filter field is absent from the dataset: ${filter.key}`));
      continue;
    }
    if (filter.value !== null && !isCompatibleFilterValue(filter.key, filter.value)) {
      issues.push(corpusIssue(`${fieldPath}.value`, "invalid-filter-type", "Filter value has the wrong type for its field"));
      continue;
    }
    if (filter.value !== null && !fields.some((field) => field.value !== null && typeof field.value === typeof filter.value)) {
      issues.push(corpusIssue(`${fieldPath}.value`, "invalid-filter-type", "Filter value type is not recorded in the dataset"));
    }
  }
  return issues;
}

export function validateRunScopeAgainstDataset(
  dataset: Dataset,
  scope: RunScope,
  path = "scope",
): CorpusValidationIssue[] {
  if (scope.kind === "filtered-results") {
    return validateSearchAgainstDataset(dataset, scope.search, `${path}.search`);
  }
  if (scope.kind === "explicit-runs") {
    const runIds = new Set(dataset.runs.map(({ id }) => id));
    return scope.runIds.flatMap((runId, index) => runIds.has(runId)
      ? []
      : [corpusIssue(`${path}.runIds.${index}`, "unknown-run", `Unknown run ID: ${runId}`)]);
  }
  return [];
}

function resolvedScope(
  dataset: Dataset,
  scope: RunScope,
  runs: Run[],
  search: RunSearchRequest | null,
): ResolvedRunScope {
  return {
    datasetVersion: dataset.version,
    scopeKind: scope.kind,
    runs,
    runIds: runs.map(({ id }) => id),
    search,
    activeFilters: search?.filters?.map(({ key, value }) => ({ key, value })) ?? [],
    scopeRuleVersion: upgradeContractVersions.runScope,
  };
}

/** Resolve a scope in catalog order (all/filtered) or in the caller's order (explicit). */
export function resolveRunScope(dataset: Dataset, scope: RunScope): RunScopeResolution {
  const parsed = runScopeSchema.parse(scope);
  const issues = validateRunScopeAgainstDataset(dataset, parsed);
  if (issues.length) return { ok: false, issues };
  if (parsed.kind === "all-reviewed-runs") {
    return { ok: true, resolved: resolvedScope(dataset, parsed, dataset.runs, null) };
  }
  if (parsed.kind === "filtered-results") {
    return {
      ok: true,
      resolved: resolvedScope(dataset, parsed, searchRuns(dataset, parsed.search), parsed.search),
    };
  }
  const byId = new Map(dataset.runs.map((run) => [run.id, run]));
  return {
    ok: true,
    resolved: resolvedScope(dataset, parsed, parsed.runIds.map((id) => byId.get(id)!), null),
  };
}

export function assertRunScope(dataset: Dataset, scope: RunScope): ResolvedRunScope {
  const resolution = resolveRunScope(dataset, scope);
  if (!resolution.ok) {
    throw new RangeError(resolution.issues.map(({ message }) => message).join("; "));
  }
  return resolution.resolved;
}

export const scopeDatasetVersionSchema = datasetVersionSchema;

/** Map a selected-run list to the explicit inspection/comparison modes. */
export function classifyRunSelection(runIds: readonly string[]): RunSelection | null {
  const parsed = analysisRunIdsSchema.safeParse(runIds);
  if (!parsed.success) return null;
  return parsed.data.length === 1
    ? { mode: "inspection", runId: parsed.data[0] }
    : { mode: "comparison", runIds: comparisonRunIdsSchema.parse(parsed.data) };
}
