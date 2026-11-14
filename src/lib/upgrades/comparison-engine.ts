/**
 * Comparison Context engine (U04.1–U04.5).
 *
 * Implements the deterministic parts of the accepted Comparison Context
 * contracts:
 *
 * - `buildSelectedRunsContext` resolves exactly the requested 2/3 distinct
 *   runs in request order and describes their recorded conditions and
 *   outcomes separately. `compareRuns` from `src/lib/evidence.ts` remains the
 *   authority for the published `same` / `different` / `unknown` /
 *   `incompatible` status. Native units come from the reviewed field catalog;
 *   values, raw original text and stable source references come from the
 *   active dataset. Native deltas are always `toRunId` minus `fromRunId` in the
 *   ordered selection (the same direction as `compareRuns`).
 * - `searchComparators` searches the requested candidate scope for runs that
 *   satisfy the declared matching rule. The reference run is never a
 *   candidate, and the chosen focus condition is excluded from required
 *   matches (approved U02 r1.1 behavior: "Focus-variable search excludes that
 *   focus from matching, keeps other required conditions visible, and never
 *   silently relaxes rules"). Every remaining reviewed condition field is
 *   required: exact by default, or an inclusive non-negative finite tolerance
 *   in the field's native unit when the request declares one. Unknown values
 *   and incompatible units never count as matches.
 *
 * Failures are typed as `ComparisonEngineError`. A valid scope that yields no
 * candidate, or no eligible candidate, is a normal `no-eligible-match`
 * outcome and is not a failure.
 *
 * Contract limits applied here: eligible matches are listed up to 10,
 * nearest ineligible candidates up to 5, a candidate scope up to 128 run IDs.
 * Additional limitation-card rendering, assistant integration, persistence and
 * UI wiring are outside U04-A (U04-B/U07 own them).
 */
import type { ComparisonResult, Dataset, Run, RunField } from "../evidence.ts";
import { compareRuns, comparisonRuleVersion } from "../evidence.ts";
import {
  comparatorRequestSchema,
  comparatorSearchResultSchema,
  comparisonContextLimitations,
  contextStatusFromComparisonRow,
  effectiveMatchingPolicy,
  gasCompositionLimitations,
  selectedRunsContextRequestSchema,
  selectedRunsContextResultSchema,
  validateComparisonContextRequestAgainstDataset,
  type ComparatorCandidate,
  type ComparatorMatchOutcome,
  type ComparatorRequest,
  type ComparatorSearchResult,
  type ComparisonContextField,
  type ContextCell,
  type ContextEvidence,
  type ContextFieldStatus,
  type GasCompositionContext,
  type MatchingPolicy,
  type NativeDelta,
  type SelectedRunsContextRequest,
  type SelectedRunsContextResult,
} from "./comparison-context.ts";
import {
  conditionFieldKeys,
  fieldDefinitionByKey,
  reviewedFieldCatalog,
  type ConditionFieldKey,
  type FieldDefinition,
  type FieldKey,
  type GasCompositionFieldKey,
  type NumericFieldKey,
} from "./field-catalog.ts";
import {
  corpusIssue,
  type CorpusValidationIssue,
  type StableFieldReference,
} from "./provenance.ts";
import { resolveRunScope } from "./scope.ts";
import { upgradeContractVersions } from "./versions.ts";

/** Deterministic rule versions emitted by this engine. */
export const comparisonEngineRuleVersions = {
  comparisonContext: "comparison-context-1",
  nativeDelta: "native-delta-1",
  gasComposition: "gas-composition-context-1",
} as const;

export type ComparisonEngineFailureCode =
  | "invalid-request"
  | "invalid-corpus"
  | "unsupported-dataset";

/**
 * Typed engine failure. Invalid request structure, unknown runs/fields,
 * unknown filter fields or an unusable corpus throw this; a valid search with
 * no candidates does not.
 */
export class ComparisonEngineError extends Error {
  readonly code: ComparisonEngineFailureCode;
  readonly issues: CorpusValidationIssue[];

  constructor(
    code: ComparisonEngineFailureCode,
    message: string,
    issues: CorpusValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ComparisonEngineError";
    this.code = code;
    this.issues = issues;
  }
}

const gasFieldKeys: GasCompositionContext["fieldKeys"] = [
  "oxygen",
  "nitrogen",
  "carbon_dioxide",
  "helium",
];

type MatchClass = "match" | "mismatch" | "unknown" | "incompatible";

type FieldMatch = {
  status: MatchClass;
  /** Dimensionless distance used only to order nearest candidates. */
  deviation: number;
};

type CandidateEvaluation = {
  candidate: Run;
  matchedKeys: ConditionFieldKey[];
  mismatchedKeys: ConditionFieldKey[];
  unknownKeys: ConditionFieldKey[];
  incompatibleKeys: ConditionFieldKey[];
  deviation: number;
};

function describeParseFailure(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseSelectedRunsRequest(request: unknown): SelectedRunsContextRequest {
  const parsed = selectedRunsContextRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new ComparisonEngineError(
      "invalid-request",
      `Invalid selected-runs context request: ${describeParseFailure(parsed.error)}`,
    );
  }
  return parsed.data;
}

function parseComparatorRequest(request: unknown): ComparatorRequest {
  const parsed = comparatorRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new ComparisonEngineError(
      "invalid-request",
      `Invalid comparator request: ${describeParseFailure(parsed.error)}`,
    );
  }
  return parsed.data;
}

function assertCorpusRequest(
  dataset: Dataset,
  request: SelectedRunsContextRequest | ComparatorRequest,
): void {
  const issues = validateComparisonContextRequestAgainstDataset(dataset, request);
  if (issues.length) {
    throw new ComparisonEngineError(
      "invalid-corpus",
      issues.map(({ message }) => message).join("; "),
      issues,
    );
  }
}

function resolveRequestedRuns(dataset: Dataset, runIds: readonly string[]): Run[] {
  const runsById = new Map(dataset.runs.map((run) => [run.id, run]));
  return runIds.map((runId) => {
    const run = runsById.get(runId);
    if (!run) {
      throw new ComparisonEngineError(
        "invalid-corpus",
        `Unknown run ID: ${runId}`,
        [corpusIssue("runIds", "unknown-run", `Unknown run ID: ${runId}`)],
      );
    }
    return run;
  });
}

function runField(run: Run, key: FieldKey): RunField | undefined {
  return run.fields.find((field) => field.key === key);
}

function contextCell(dataset: Dataset, run: Run, key: FieldKey): ContextCell {
  const field = runField(run, key);
  if (!field) {
    return { runId: run.id, value: null, original: null, reference: null };
  }
  if (typeof field.value === "number" && !Number.isFinite(field.value)) {
    throw new ComparisonEngineError(
      "unsupported-dataset",
      `Recorded value for ${run.id}/${key} is not a finite number; the context contract cannot represent it.`,
    );
  }
  return {
    runId: run.id,
    value: field.value,
    original: field.original,
    reference: {
      datasetVersion: dataset.version,
      runId: run.id,
      fieldKey: key,
      sourceId: field.sourceId,
    },
  };
}

function nativeFieldUnit(definition: FieldDefinition): string {
  if (definition.nativeUnit === null) {
    throw new ComparisonEngineError(
      "unsupported-dataset",
      `Numeric field ${definition.key} has no reviewed native unit.`,
    );
  }
  return definition.nativeUnit;
}

function nativeDeltas(cells: readonly ContextCell[], unit: string): NativeDelta[] {
  const deltas: NativeDelta[] = [];
  for (const [index, from] of cells.entries()) {
    if (typeof from.value !== "number") continue;
    for (const to of cells.slice(index + 1)) {
      if (typeof to.value !== "number") continue;
      const delta = to.value - from.value;
      if (!Number.isFinite(delta)) continue;
      deltas.push({
        fromRunId: from.runId,
        toRunId: to.runId,
        delta,
        unit,
        provenanceClass: "deterministic-derived",
        ruleVersion: comparisonEngineRuleVersions.nativeDelta,
      });
    }
  }
  return deltas;
}

function fieldReason(
  definition: FieldDefinition,
  cells: readonly ContextCell[],
  status: ContextFieldStatus,
  unitMismatch: boolean,
  authorityReason: string | undefined,
): string {
  if (unitMismatch) {
    return `Incompatible: a recorded unit does not match the reviewed native unit (${definition.nativeUnit ?? "unitless"}) for ${definition.label}.`;
  }
  if (status === "same") {
    return "Recorded values match exactly for the selected runs.";
  }
  if (status === "different") {
    return definition.dataType === "numeric"
      ? "Recorded values differ; each native delta is the later ordered run minus the earlier run."
      : "Recorded categorical values differ; no numeric delta applies.";
  }
  if (status === "unknown") {
    const unknown = cells.map((cell) => {
      if (cell.value !== null) return null;
      return cell.reference === null ? `${cell.runId} (field not recorded)` : `${cell.runId} (unknown)`;
    }).filter((text): text is string => text !== null);
    return `Unknown for ${unknown.join(", ")}; an unknown value never counts as a match.`;
  }
  return `Incompatible: ${authorityReason ?? "the recorded values cannot be compared."}`;
}

function buildContextFields(
  dataset: Dataset,
  runs: readonly Run[],
  rowsByKey: ReadonlyMap<string, ComparisonResult["rows"][number]>,
): { conditions: ComparisonContextField[]; outcomes: ComparisonContextField[] } {
  const conditions: ComparisonContextField[] = [];
  const outcomes: ComparisonContextField[] = [];

  for (const definition of reviewedFieldCatalog.fields) {
    const key = definition.key;
    if (!runs.some((run) => run.fields.some((field) => field.key === key))) continue;

    const cells = runs.map((run) => contextCell(dataset, run, key));
    // The reviewed catalog is the only accepted source of native units. A
    // recorded unit that differs from it cannot be compared as the reviewed
    // native unit, so the field is incompatible rather than silently relabelled.
    const unitMismatch = runs.some((run) => {
      const field = runField(run, key);
      return field !== undefined && field.unit !== definition.nativeUnit;
    });
    const authorityRow = rowsByKey.get(key);
    const status: ContextFieldStatus = unitMismatch
      ? "incompatible"
      : authorityRow
        ? contextStatusFromComparisonRow(authorityRow.status)
        : "unknown";
    const deltas = status !== "same" && status !== "incompatible" && definition.dataType === "numeric"
      ? nativeDeltas(cells, nativeFieldUnit(definition))
      : [];

    const field: ComparisonContextField = {
      key,
      label: definition.label,
      kind: definition.kind,
      status,
      unit: definition.nativeUnit,
      cells,
      deltas,
      reason: fieldReason(definition, cells, status, unitMismatch, authorityRow?.reason),
    };
    if (definition.kind === "condition") conditions.push(field);
    else outcomes.push(field);
  }

  return { conditions, outcomes };
}

function gasNumber(run: Run, key: GasCompositionFieldKey): number | null {
  const field = runField(run, key);
  if (!field) return null;
  if (field.value === null) return null;
  if (typeof field.value !== "number" || !Number.isFinite(field.value)) {
    throw new ComparisonEngineError(
      "unsupported-dataset",
      `Recorded gas value for ${run.id}/${key} is not a finite number or null.`,
    );
  }
  return field.value;
}

function buildGasComposition(runs: readonly Run[]): GasCompositionContext {
  const values: GasCompositionContext["values"] = runs.map((run) => ({
    runId: run.id,
    values: {
      oxygen: gasNumber(run, "oxygen"),
      nitrogen: gasNumber(run, "nitrogen"),
      carbon_dioxide: gasNumber(run, "carbon_dioxide"),
      helium: gasNumber(run, "helium"),
    },
  }));

  // Zero is a recorded value; only null is unknown. Note that every gas value
  // of a pair must be known to emit the contractual four-value difference row.
  const complete = values.every(({ values: gas }) => gasFieldKeys.every((key) => gas[key] !== null));
  const differences: GasCompositionContext["differences"] = [];
  for (const [index, from] of values.entries()) {
    for (const to of values.slice(index + 1)) {
      if (!gasFieldKeys.every((key) => from.values[key] !== null && to.values[key] !== null)) continue;
      differences.push({
        fromRunId: from.runId,
        toRunId: to.runId,
        values: gasFieldKeys.map((key) => ({
          key,
          delta: (to.values[key] as number) - (from.values[key] as number),
          unit: "mole fraction" as const,
        })),
      });
    }
  }

  return {
    fieldKeys: [...gasFieldKeys],
    complete,
    values,
    differences,
    limitation: "Gas fractions are linked. Inspect the complete recorded composition; a difference in oxygen alone does not establish an isolated oxygen effect.",
  };
}

function stableReferences(
  dataset: Dataset,
  runs: readonly Run[],
  keys: readonly FieldKey[],
  limit: number,
): StableFieldReference[] {
  const references: StableFieldReference[] = [];
  for (const key of keys) {
    for (const run of runs) {
      const field = runField(run, key);
      if (!field) continue;
      references.push({
        datasetVersion: dataset.version,
        runId: run.id,
        fieldKey: key,
        sourceId: field.sourceId,
      });
      if (references.length >= limit) return references;
    }
  }
  return references;
}

type StatusCounts = Record<ContextFieldStatus, number>;

function countStatuses(fields: readonly ComparisonContextField[]): StatusCounts {
  const counts: StatusCounts = { same: 0, different: 0, unknown: 0, incompatible: 0 };
  for (const { status } of fields) counts[status] += 1;
  return counts;
}

function summarizeContext(
  conditions: readonly ComparisonContextField[],
  outcomes: readonly ComparisonContextField[],
): string {
  const conditionCounts = countStatuses(conditions);
  const outcomeCounts = countStatuses(outcomes);
  return `Conditions (${conditions.length}): ${conditionCounts.same} same, ${conditionCounts.different} different, ${conditionCounts.unknown} unknown, ${conditionCounts.incompatible} incompatible. Outcomes (${outcomes.length}): ${outcomeCounts.same} same, ${outcomeCounts.different} different, ${outcomeCounts.unknown} unknown, ${outcomeCounts.incompatible} incompatible.`;
}

function buildContextEvidence(
  dataset: Dataset,
  runs: readonly Run[],
  conditions: readonly ComparisonContextField[],
  outcomes: readonly ComparisonContextField[],
  gasComposition: GasCompositionContext,
): ContextEvidence[] {
  const allFields = [...conditions, ...outcomes];
  const allKeys = allFields.map(({ key }) => key);
  const outcomeKeys = outcomes.map(({ key }) => key);
  const nonSameKeys = allFields.filter(({ status }) => status !== "same").map(({ key }) => key);

  return [
    {
      category: "recorded-observation",
      text: `Recorded condition and outcome values for ${runs.map(({ id }) => id).join(", ")}. Null values are unknown; no value is interpolated.`,
      fieldKeys: allKeys.slice(0, 11),
      sourceReferences: stableReferences(dataset, runs, outcomeKeys, 16),
    },
    {
      category: "computed-comparison",
      text: summarizeContext(conditions, outcomes),
      fieldKeys: nonSameKeys.slice(0, 11),
      sourceReferences: stableReferences(dataset, runs, nonSameKeys, 16),
      ruleVersion: comparisonEngineRuleVersions.comparisonContext,
    },
    {
      category: "computed-comparison",
      text: gasComposition.complete
        ? "All four recorded initial ambient gas fractions are known for each displayed run; differences are computed for the complete group."
        : "At least one recorded initial ambient gas fraction is unknown; incomplete composition is marked and differences are shown only for pairs with all four values recorded.",
      fieldKeys: [...gasFieldKeys],
      sourceReferences: stableReferences(dataset, runs, gasFieldKeys, 16),
      ruleVersion: comparisonEngineRuleVersions.gasComposition,
    },
    {
      category: "not-established",
      text: "Recorded differences do not establish a cause, and gas differences shown together do not establish an isolated oxygen effect.",
      fieldKeys: [...gasFieldKeys],
      sourceReferences: [],
    },
  ];
}

function selectedContextLimitations(gasComposition: GasCompositionContext): string[] {
  const limitations: string[] = [
    comparisonContextLimitations.recordedOnly,
    comparisonContextLimitations.causal,
    comparisonContextLimitations.unknown,
    comparisonContextLimitations.gas,
    comparisonContextLimitations.extinction,
  ];
  if (!gasComposition.complete) limitations.push(gasCompositionLimitations.incomplete);
  return limitations;
}

/**
 * Build the ordered condition/outcome context for exactly the requested
 * two or three distinct runs. Unknown run IDs and structurally invalid
 * requests throw `ComparisonEngineError`; they are never dropped silently.
 * The returned object is parsed by `selectedRunsContextResultSchema`.
 */
export function buildSelectedRunsContext(
  dataset: Dataset,
  request: SelectedRunsContextRequest,
): SelectedRunsContextResult {
  const parsedRequest = parseSelectedRunsRequest(request);
  assertCorpusRequest(dataset, parsedRequest);
  const runs = resolveRequestedRuns(dataset, parsedRequest.runIds);

  const comparison = compareRuns(dataset, { runIds: parsedRequest.runIds });
  const rowsByKey = new Map(comparison.rows.map((row) => [row.key, row]));
  const { conditions, outcomes } = buildContextFields(dataset, runs, rowsByKey);
  if (!conditions.length || !outcomes.length) {
    throw new ComparisonEngineError(
      "unsupported-dataset",
      "The selected runs record no reviewed condition and/or outcome fields; the context result contract requires at least one of each.",
    );
  }

  const gasComposition = buildGasComposition(runs);
  const result: SelectedRunsContextResult = {
    version: upgradeContractVersions.comparisonContextResult,
    kind: "selected-runs-context",
    datasetVersion: dataset.version,
    comparisonRuleVersion,
    contextRuleVersion: comparisonEngineRuleVersions.comparisonContext,
    request: parsedRequest,
    runIds: [...parsedRequest.runIds],
    conditions,
    outcomes,
    gasComposition,
    evidence: buildContextEvidence(dataset, runs, conditions, outcomes, gasComposition),
    limitations: selectedContextLimitations(gasComposition),
  };
  return selectedRunsContextResultSchema.parse(result);
}

function matchField(
  key: ConditionFieldKey,
  referenceField: RunField | undefined,
  candidateField: RunField | undefined,
  tolerance: number | undefined,
): FieldMatch {
  // A missing field and a recorded null are both unknown, and an unknown value
  // never satisfies a match.
  if (!referenceField || !candidateField) return { status: "unknown", deviation: 0 };
  const definition = fieldDefinitionByKey[key];
  if (referenceField.unit !== definition.nativeUnit || candidateField.unit !== definition.nativeUnit) {
    return { status: "incompatible", deviation: 0 };
  }

  const referenceValue = referenceField.value;
  const candidateValue = candidateField.value;
  if (referenceValue === null || candidateValue === null) {
    return { status: "unknown", deviation: 0 };
  }

  if (definition.dataType === "numeric") {
    if (typeof referenceValue !== "number" || typeof candidateValue !== "number"
      || !Number.isFinite(referenceValue) || !Number.isFinite(candidateValue)) {
      return { status: "incompatible", deviation: 0 };
    }
    const difference = Math.abs(candidateValue - referenceValue);
    const scale = tolerance === undefined
      ? Math.max(Math.abs(referenceValue), Math.abs(candidateValue), 1e-12)
      : tolerance > 0
        ? tolerance
        : Math.max(Math.abs(referenceValue), 1e-12);
    const deviation = difference / scale;
    if (tolerance === undefined) {
      return { status: referenceValue === candidateValue ? "match" : "mismatch", deviation };
    }
    // Inclusive boundary: a difference exactly equal to the tolerance matches.
    return { status: difference <= tolerance ? "match" : "mismatch", deviation };
  }

  if (typeof referenceValue !== "string" || typeof candidateValue !== "string") {
    return { status: "incompatible", deviation: 0 };
  }
  // Categorical matching is exact; tolerances are rejected by the request schema.
  return { status: referenceValue === candidateValue ? "match" : "mismatch", deviation: 0 };
}

function evaluateCandidate(
  reference: Run,
  candidate: Run,
  requiredKeys: readonly ConditionFieldKey[],
  tolerances: ReadonlyMap<NumericFieldKey, number>,
): CandidateEvaluation {
  const matchedKeys: ConditionFieldKey[] = [];
  const mismatchedKeys: ConditionFieldKey[] = [];
  const unknownKeys: ConditionFieldKey[] = [];
  const incompatibleKeys: ConditionFieldKey[] = [];
  let deviation = 0;

  for (const key of requiredKeys) {
    const match = matchField(
      key,
      runField(reference, key),
      runField(candidate, key),
      tolerances.get(key as NumericFieldKey),
    );
    if (match.status === "match") matchedKeys.push(key);
    else if (match.status === "mismatch") {
      mismatchedKeys.push(key);
      if (Number.isFinite(match.deviation)) deviation += match.deviation;
    } else if (match.status === "unknown") unknownKeys.push(key);
    else incompatibleKeys.push(key);
  }

  return { candidate, matchedKeys, mismatchedKeys, unknownKeys, incompatibleKeys, deviation };
}

function isEligible(evaluation: CandidateEvaluation): boolean {
  return evaluation.mismatchedKeys.length === 0
    && evaluation.unknownKeys.length === 0
    && evaluation.incompatibleKeys.length === 0;
}

/** Deterministic nearest-first ordering for ineligible candidates. */
function compareNearest(left: CandidateEvaluation, right: CandidateEvaluation): number {
  const leftFailed = left.mismatchedKeys.length + left.unknownKeys.length + left.incompatibleKeys.length;
  const rightFailed = right.mismatchedKeys.length + right.unknownKeys.length + right.incompatibleKeys.length;
  if (leftFailed !== rightFailed) return leftFailed - rightFailed;
  if (left.unknownKeys.length !== right.unknownKeys.length) {
    return left.unknownKeys.length - right.unknownKeys.length;
  }
  if (left.incompatibleKeys.length !== right.incompatibleKeys.length) {
    return left.incompatibleKeys.length - right.incompatibleKeys.length;
  }
  if (left.deviation < right.deviation) return -1;
  if (left.deviation > right.deviation) return 1;
  if (left.candidate.id < right.candidate.id) return -1;
  if (left.candidate.id > right.candidate.id) return 1;
  return 0;
}

function fieldLabels(keys: readonly FieldKey[]): string {
  if (!keys.length) return "none";
  return keys.map((key) => fieldDefinitionByKey[key].label).join(", ");
}

function describeIneligibility(evaluation: CandidateEvaluation): string {
  return `Not an eligible match under the declared rule (mismatched: ${fieldLabels(evaluation.mismatchedKeys)}; unknown: ${fieldLabels(evaluation.unknownKeys)}; incompatible: ${fieldLabels(evaluation.incompatibleKeys)}).`;
}

function candidateContextRequest(
  reference: Run,
  candidate: Run,
  focusCondition: ConditionFieldKey,
): SelectedRunsContextRequest {
  const focusPresent = [reference, candidate].some((run) => run.fields.some(({ key }) => key === focusCondition));
  const request: SelectedRunsContextRequest = {
    version: upgradeContractVersions.comparisonContextRequest,
    kind: "selected-runs",
    runIds: [reference.id, candidate.id],
  };
  // A focus field absent from both runs cannot be represented in the pair
  // context; omitting it keeps the context contract valid rather than failing.
  if (focusPresent) request.focusCondition = focusCondition;
  return request;
}

function toComparatorCandidate(
  dataset: Dataset,
  reference: Run,
  evaluation: CandidateEvaluation,
  disposition: "eligible" | "nearest",
  matching: MatchingPolicy,
  focusCondition: ConditionFieldKey,
): ComparatorCandidate {
  const eligible = isEligible(evaluation);
  const limitations: string[] = [];
  if (!eligible) limitations.push(describeIneligibility(evaluation));
  limitations.push("Eligibility reflects only the declared matching rule; it does not establish scientific equivalence.");
  if (matching.mode === "tolerance") limitations.push(comparisonContextLimitations.tolerance);
  if (evaluation.unknownKeys.length) limitations.push(comparisonContextLimitations.unknown);

  return {
    runId: evaluation.candidate.id,
    disposition,
    context: buildSelectedRunsContext(
      dataset,
      candidateContextRequest(reference, evaluation.candidate, focusCondition),
    ),
    mismatchedFieldKeys: evaluation.mismatchedKeys,
    unknownFieldKeys: evaluation.unknownKeys,
    incompatibleFieldKeys: evaluation.incompatibleKeys,
    limitations,
  };
}

const focusToleranceIgnoredLimitation =
  "The declared tolerance for the focus condition is not applied as a match rule because the focus condition is excluded from required matching by design.";

const emptyScopeLimitation =
  "Empty candidate scope: after excluding the reference run, no candidate runs remained. This is an empty search result, not an engine failure.";

const eligibleTruncationLimitation =
  "Only the first ten eligible matches are listed; evaluatedCount reports every evaluated candidate.";

const nearestTruncationLimitation =
  "Only the five nearest ineligible candidates are listed; evaluatedCount reports every evaluated candidate.";

/**
 * Search the declared candidate scope for runs matching the reference on every
 * reviewed condition field except the chosen focus condition.
 *
 * - The reference run is removed from the candidate list.
 * - Exact matching is the default. A declared per-field tolerance replaces
 *   exact matching for that numeric field and is inclusive in its native unit.
 * - Unknown values and incompatible units never match.
 * - Eligible and ineligible candidates are returned separately. Ineligible
 *   candidates are ordered nearest-first and are limited to five; when no
 *   candidate is eligible the outcome is `no-eligible-match`, which is
 *   distinct from an engine failure.
 */
export function searchComparators(
  dataset: Dataset,
  request: ComparatorRequest,
): ComparatorSearchResult {
  const parsedRequest = parseComparatorRequest(request);
  assertCorpusRequest(dataset, parsedRequest);
  const reference = resolveRequestedRuns(dataset, [parsedRequest.referenceRunId])[0];
  const matching = effectiveMatchingPolicy(parsedRequest);

  const scopeResolution = resolveRunScope(dataset, parsedRequest.candidateScope);
  if (!scopeResolution.ok) {
    throw new ComparisonEngineError(
      "invalid-corpus",
      scopeResolution.issues.map(({ message }) => message).join("; "),
      scopeResolution.issues,
    );
  }
  const scope = scopeResolution.resolved;
  const candidateRuns = scope.runs.filter(({ id }) => id !== reference.id);
  if (candidateRuns.length > 128) {
    throw new ComparisonEngineError(
      "unsupported-dataset",
      `The candidate scope resolves to ${candidateRuns.length} runs; the comparator result contract supports at most 128.`,
    );
  }

  const tolerances = new Map<NumericFieldKey, number>();
  if (matching.mode === "tolerance") {
    for (const { field, tolerance } of matching.tolerances) tolerances.set(field, tolerance);
  }
  // The focus condition is deliberately excluded; every other reviewed
  // condition is a required match (exact unless a tolerance is declared).
  const requiredKeys = conditionFieldKeys.filter((key) => key !== parsedRequest.focusCondition);
  const evaluations = candidateRuns.map((candidate) => (
    evaluateCandidate(reference, candidate, requiredKeys, tolerances)
  ));

  const eligible = evaluations.filter(isEligible);
  const ineligible = evaluations.filter((evaluation) => !isEligible(evaluation));

  let outcome: ComparatorMatchOutcome;
  const notes: string[] = [];
  if (eligible.length) {
    if (eligible.length > 10) notes.push(eligibleTruncationLimitation);
    outcome = {
      kind: "eligible-match",
      candidates: eligible.slice(0, 10).map((evaluation) => (
        toComparatorCandidate(dataset, reference, evaluation, "eligible", matching, parsedRequest.focusCondition)
      )),
    };
  } else {
    if (!ineligible.length) notes.push(emptyScopeLimitation);
    else if (ineligible.length > 5) notes.push(nearestTruncationLimitation);
    outcome = {
      kind: "no-eligible-match",
      nearestCandidates: [...ineligible].sort(compareNearest).slice(0, 5).map((evaluation) => (
        toComparatorCandidate(dataset, reference, evaluation, "nearest", matching, parsedRequest.focusCondition)
      )),
    };
  }

  const limitations: string[] = [
    comparisonContextLimitations.recordedOnly,
    comparisonContextLimitations.causal,
    comparisonContextLimitations.unknown,
    comparisonContextLimitations.gas,
    comparisonContextLimitations.extinction,
  ];
  if (matching.mode === "tolerance") limitations.push(comparisonContextLimitations.tolerance);
  if (parsedRequest.matching?.mode === "tolerance"
    && parsedRequest.matching.tolerances.some(({ field }) => field === parsedRequest.focusCondition)) {
    limitations.push(focusToleranceIgnoredLimitation);
  }
  limitations.push(...notes);

  const result: ComparatorSearchResult = {
    version: upgradeContractVersions.comparatorSearch,
    kind: "comparator-search",
    datasetVersion: dataset.version,
    comparisonRuleVersion,
    contextRuleVersion: comparisonEngineRuleVersions.comparisonContext,
    request: parsedRequest,
    matching,
    candidateScope: parsedRequest.candidateScope,
    resolvedCandidateRunIds: candidateRuns.map(({ id }) => id),
    activeFilters: scope.activeFilters,
    evaluatedCount: candidateRuns.length,
    outcome,
    limitations: limitations.slice(0, 8),
  };
  return comparatorSearchResultSchema.parse(result);
}
