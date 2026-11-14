import { z } from "zod";
import type { ComparisonResult, Dataset } from "../evidence.ts";
import {
  conditionFieldKeySchema,
  fieldDefinitionByKey,
  fieldKeySchema,
  gasCompositionFieldKeySchema,
  numericFieldKeySchema,
  type ConditionFieldKey,
  type GasCompositionFieldKey,
} from "./field-catalog.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetVersionSchema,
  finiteNumberSchema,
  nonNegativeFiniteNumberSchema,
  stableFieldReferenceSchema,
  type CorpusValidationIssue,
} from "./provenance.ts";
import {
  activeFilterSchema,
  comparisonRunIdsSchema,
  runScopeSchema,
  validateRunScopeAgainstDataset,
} from "./scope.ts";
import { upgradeContractVersions } from "./versions.ts";

const limitationSchema = z.string().min(1).max(500);

export const matchingToleranceSchema = z.strictObject({
  field: numericFieldKeySchema,
  tolerance: nonNegativeFiniteNumberSchema,
});
export type MatchingTolerance = z.infer<typeof matchingToleranceSchema>;

export const matchingPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("exact") }),
  z.strictObject({
    mode: z.literal("tolerance"),
    tolerances: z.array(matchingToleranceSchema).min(1).max(8)
      .refine(
        (tolerances) => new Set(tolerances.map(({ field }) => field)).size === tolerances.length,
        "Declare at most one tolerance per field",
      ),
  }),
]);
export type MatchingPolicy = z.infer<typeof matchingPolicySchema>;

export function createExactMatchingPolicy(): MatchingPolicy {
  return { mode: "exact" };
}

export const selectedRunsContextRequestSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.comparisonContextRequest),
  kind: z.literal("selected-runs"),
  runIds: comparisonRunIdsSchema,
  focusCondition: conditionFieldKeySchema.optional(),
});
export type SelectedRunsContextRequest = z.infer<typeof selectedRunsContextRequestSchema>;

export const comparatorRequestSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.comparisonContextRequest),
  kind: z.literal("comparator"),
  referenceRunId: canonicalRunIdSchema,
  focusCondition: conditionFieldKeySchema,
  candidateScope: runScopeSchema,
  /** Omit for exact matching. Tolerances are an explicit search rule, not equivalence. */
  matching: matchingPolicySchema.optional(),
});
export type ComparatorRequest = z.infer<typeof comparatorRequestSchema>;

/** Requests omit `matching` for the default exact rule. */
export function effectiveMatchingPolicy(request: Pick<ComparatorRequest, "matching">): MatchingPolicy {
  return request.matching ?? createExactMatchingPolicy();
}

export const comparisonContextRequestSchema = z.discriminatedUnion("kind", [
  selectedRunsContextRequestSchema,
  comparatorRequestSchema,
]);
export type ComparisonContextRequest = z.infer<typeof comparisonContextRequestSchema>;

export const contextFieldStatusSchema = z.enum(["same", "different", "unknown", "incompatible"]);
export type ContextFieldStatus = z.infer<typeof contextFieldStatusSchema>;

/** The context contract keeps the existing ComparisonResult status vocabulary. */
export type ExistingComparisonRowStatus = ComparisonResult["rows"][number]["status"];

export function contextStatusFromComparisonRow(
  status: ExistingComparisonRowStatus,
): ContextFieldStatus {
  return status;
}

export const contextCellSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  value: z.union([z.number().finite(), z.string().min(1), z.null()]),
  original: z.string().nullable(),
  reference: stableFieldReferenceSchema.nullable(),
});
export type ContextCell = z.infer<typeof contextCellSchema>;

export const nativeDeltaSchema = z.strictObject({
  fromRunId: canonicalRunIdSchema,
  toRunId: canonicalRunIdSchema,
  delta: finiteNumberSchema,
  unit: z.string().min(1).max(64),
  provenanceClass: z.literal("deterministic-derived"),
  ruleVersion: z.literal("native-delta-1"),
});
export type NativeDelta = z.infer<typeof nativeDeltaSchema>;

export const comparisonContextFieldSchema = z.strictObject({
  key: fieldKeySchema,
  label: z.string().min(1).max(200),
  kind: z.enum(["condition", "outcome"]),
  status: contextFieldStatusSchema,
  unit: z.string().min(1).max(64).nullable(),
  cells: z.array(contextCellSchema).min(2).max(3),
  deltas: z.array(nativeDeltaSchema).max(3),
  reason: z.string().min(1).max(500),
}).superRefine((field, context) => {
  const definition = fieldDefinitionByKey[field.key];
  if (field.label !== definition.label) {
    context.addIssue({ code: "custom", path: ["label"], message: "Field label does not match the reviewed catalog" });
  }
  if (field.kind !== definition.kind) {
    context.addIssue({ code: "custom", path: ["kind"], message: "Field kind does not match the reviewed catalog" });
  }
  if (field.unit !== definition.nativeUnit) {
    context.addIssue({ code: "custom", path: ["unit"], message: "Field unit does not match the reviewed native unit" });
  }
  if (new Set(field.cells.map(({ runId }) => runId)).size !== field.cells.length) {
    context.addIssue({ code: "custom", path: ["cells"], message: "Cells must use distinct run IDs" });
  }

  const values = field.cells.map(({ value }) => value);
  const unknown = values.some((value) => value === null);
  if (field.status === "unknown" && !unknown) {
    context.addIssue({ code: "custom", path: ["status"], message: "Unknown status needs at least one unknown value" });
  }
  if ((field.status === "same" || field.status === "different") && unknown) {
    context.addIssue({ code: "custom", path: ["status"], message: "A known comparison cannot contain an unknown value" });
  }
  if (field.status === "same") {
    if (new Set(values).size !== 1) {
      context.addIssue({ code: "custom", path: ["status"], message: "Same status requires matching recorded values" });
    }
  }
  if (field.status === "different") {
    if (new Set(values).size < 2) {
      context.addIssue({ code: "custom", path: ["status"], message: "Different status requires differing recorded values" });
    }
  }
  if (field.status === "incompatible" && field.deltas.length) {
    context.addIssue({ code: "custom", path: ["deltas"], message: "Incompatible fields cannot carry native deltas" });
  }

  const runIds = new Set(field.cells.map(({ runId }) => runId));
  for (const [index, delta] of field.deltas.entries()) {
    if (!runIds.has(delta.fromRunId) || !runIds.has(delta.toRunId) || delta.fromRunId === delta.toRunId) {
      context.addIssue({ code: "custom", path: ["deltas", index], message: "Delta endpoints must be distinct cells" });
    }
    if (field.unit === null || delta.unit !== field.unit) {
      context.addIssue({ code: "custom", path: ["deltas", index, "unit"], message: "Delta must use the field's native unit" });
    }
  }
});
export type ComparisonContextField = z.infer<typeof comparisonContextFieldSchema>;

export const gasCompositionContextSchema = z.strictObject({
  fieldKeys: z.tuple([
    z.literal("oxygen"),
    z.literal("nitrogen"),
    z.literal("carbon_dioxide"),
    z.literal("helium"),
  ]),
  complete: z.boolean(),
  values: z.array(z.strictObject({
    runId: canonicalRunIdSchema,
    values: z.strictObject({
      oxygen: z.number().finite().nullable(),
      nitrogen: z.number().finite().nullable(),
      carbon_dioxide: z.number().finite().nullable(),
      helium: z.number().finite().nullable(),
    }),
  })).min(2).max(3),
  differences: z.array(z.strictObject({
    fromRunId: canonicalRunIdSchema,
    toRunId: canonicalRunIdSchema,
    values: z.array(z.strictObject({
      key: gasCompositionFieldKeySchema,
      delta: finiteNumberSchema,
      unit: z.literal("mole fraction"),
    })).min(4).max(4)
      .refine((values) => new Set(values.map(({ key }) => key)).size === values.length, "Use each gas field once"),
  })).max(3),
  limitation: z.literal(
    "Gas fractions are linked. Inspect the complete recorded composition; a difference in oxygen alone does not establish an isolated oxygen effect.",
  ),
}).superRefine((composition, context) => {
  if (new Set(composition.values.map(({ runId }) => runId)).size !== composition.values.length) {
    context.addIssue({ code: "custom", path: ["values"], message: "Composition rows must use distinct run IDs" });
  }
  const complete = composition.values.every(({ values }) => (
    values.oxygen !== null && values.nitrogen !== null
    && values.carbon_dioxide !== null && values.helium !== null
  ));
  if (composition.complete !== complete) {
    context.addIssue({
      code: "custom",
      path: ["complete"],
      message: "Complete composition must match whether all four gas values are known",
    });
  }
  const runIds = new Set(composition.values.map(({ runId }) => runId));
  for (const [index, difference] of composition.differences.entries()) {
    if (!runIds.has(difference.fromRunId) || !runIds.has(difference.toRunId)
      || difference.fromRunId === difference.toRunId) {
      context.addIssue({
        code: "custom",
        path: ["differences", index],
        message: "Composition differences need distinct resolved runs",
      });
    }
  }
});
export type GasCompositionContext = z.infer<typeof gasCompositionContextSchema>;

export const gasCompositionLimitations = {
  complete: "All four initial ambient gas fractions are reported for every displayed run.",
  incomplete: "At least one gas fraction is unknown for a displayed run; the complete composition cannot be reconstructed.",
  linked: "Gas fractions are linked. Oxygen differences are shown together with nitrogen, carbon dioxide and helium differences; no isolated oxygen effect is established.",
} as const;

export const contextEvidenceCategorySchema = z.enum([
  "recorded-observation",
  "computed-comparison",
  "not-established",
]);
export type ContextEvidenceCategory = z.infer<typeof contextEvidenceCategorySchema>;

export const contextEvidenceCategoryLabels = {
  "recorded-observation": "Recorded observation",
  "computed-comparison": "Computed comparison",
  "not-established": "Not established by these records",
} as const satisfies Record<ContextEvidenceCategory, string>;

export const contextEvidenceSchema = z.strictObject({
  category: contextEvidenceCategorySchema,
  text: z.string().min(1).max(500),
  fieldKeys: z.array(fieldKeySchema).max(11),
  sourceReferences: z.array(stableFieldReferenceSchema).max(16),
  /** Only deterministic calculations carry a rule version. */
  ruleVersion: z.string().min(1).max(64).optional(),
}).superRefine((evidence, context) => {
  if (evidence.category === "computed-comparison" && evidence.ruleVersion === undefined) {
    context.addIssue({ code: "custom", path: ["ruleVersion"], message: "Computed comparisons need a rule version" });
  }
  if (evidence.category !== "computed-comparison" && evidence.ruleVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["ruleVersion"], message: "Only computed comparisons carry a rule version" });
  }
});
export type ContextEvidence = z.infer<typeof contextEvidenceSchema>;

export const comparisonContextLimitations = {
  recordedOnly: "A comparison describes differences in recorded fields within this curated FLEX subset.",
  causal: "Recorded condition differences cannot establish a causal conclusion. Unrecorded conditions may also affect outcomes.",
  tolerance: "A matching tolerance is a search rule chosen by the user, not a scientifically validated equivalence threshold.",
  unknown: "An unknown value never counts as a match.",
  gas: gasCompositionLimitations.linked,
  extinction: "Some visible-extinction diameters were estimated from burning history; the selected source does not identify individual estimates.",
} as const;

const selectedRunsContextResultBase = {
  version: z.literal(upgradeContractVersions.comparisonContextResult),
  kind: z.literal("selected-runs-context"),
  datasetVersion: datasetVersionSchema,
  comparisonRuleVersion: z.string().min(1).max(64),
  contextRuleVersion: z.literal("comparison-context-1"),
  request: selectedRunsContextRequestSchema,
  runIds: comparisonRunIdsSchema,
  conditions: z.array(comparisonContextFieldSchema).min(1).max(12),
  outcomes: z.array(comparisonContextFieldSchema).min(1).max(12),
  gasComposition: gasCompositionContextSchema,
  evidence: z.array(contextEvidenceSchema).min(1).max(12),
  limitations: z.array(limitationSchema).min(1).max(8),
};

export const selectedRunsContextResultSchema = z.strictObject(selectedRunsContextResultBase)
  .superRefine((result, context) => {
    if (result.request.runIds.length !== result.runIds.length
      || result.request.runIds.some((runId, index) => runId !== result.runIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["request", "runIds"],
        message: "Request and result run order or length differ",
      });
    }
    if (result.request.focusCondition !== undefined
      && !result.conditions.some(({ key }) => key === result.request.focusCondition)) {
      context.addIssue({
        code: "custom",
        path: ["request", "focusCondition"],
        message: "Focus condition is absent from the resolved conditions",
      });
    }

    const keys = new Set<string>();
    for (const [group, fields] of [["conditions", result.conditions], ["outcomes", result.outcomes]] as const) {
      for (const [index, field] of fields.entries()) {
        if (keys.has(field.key)) {
          context.addIssue({ code: "custom", path: [group, index, "key"], message: "Field appears more than once" });
        }
        keys.add(field.key);
        const expectedKind = group === "conditions" ? "condition" : "outcome";
        if (field.kind !== expectedKind) {
          context.addIssue({
            code: "custom",
            path: [group, index, "kind"],
            message: "Field is in the wrong condition/outcome group",
          });
        }
        if (field.cells.length !== result.runIds.length
          || field.cells.some(({ runId }, cellIndex) => runId !== result.runIds[cellIndex])) {
          context.addIssue({
            code: "custom",
            path: [group, index, "cells"],
            message: "Cells must follow the ordered selected runs",
          });
        }
      }
    }

    if (result.gasComposition.values.length !== result.runIds.length
      || result.gasComposition.values.some(({ runId }, index) => runId !== result.runIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["gasComposition", "values"],
        message: "Gas composition rows must follow the ordered selected runs",
      });
    }
    for (const field of [...result.conditions, ...result.outcomes]) {
      for (const delta of field.deltas) {
        if (!result.runIds.includes(delta.fromRunId) || !result.runIds.includes(delta.toRunId)) {
          context.addIssue({
            code: "custom",
            path: ["deltas"],
            message: "Delta endpoints must be selected runs",
          });
        }
      }
    }
  });
export type SelectedRunsContextResult = z.infer<typeof selectedRunsContextResultSchema>;

export const comparatorCandidateSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  disposition: z.enum(["eligible", "nearest"]),
  context: selectedRunsContextResultSchema,
  mismatchedFieldKeys: z.array(fieldKeySchema).max(12),
  unknownFieldKeys: z.array(fieldKeySchema).max(12),
  incompatibleFieldKeys: z.array(fieldKeySchema).max(12),
  limitations: z.array(limitationSchema).max(4),
}).superRefine((candidate, context) => {
  if (!candidate.context.runIds.includes(candidate.runId)) {
    context.addIssue({ code: "custom", path: ["runId"], message: "Candidate is absent from its context" });
  }
  if (candidate.context.runIds.length !== 2) {
    context.addIssue({ code: "custom", path: ["context", "runIds"], message: "A comparator candidate context needs two runs" });
  }
});
export type ComparatorCandidate = z.infer<typeof comparatorCandidateSchema>;

export const comparatorMatchOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("eligible-match"),
    candidates: z.array(comparatorCandidateSchema).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("no-eligible-match"),
    nearestCandidates: z.array(comparatorCandidateSchema).max(5),
  }),
]);
export type ComparatorMatchOutcome = z.infer<typeof comparatorMatchOutcomeSchema>;

export const comparatorSearchResultSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.comparatorSearch),
  kind: z.literal("comparator-search"),
  datasetVersion: datasetVersionSchema,
  comparisonRuleVersion: z.string().min(1).max(64),
  contextRuleVersion: z.literal("comparison-context-1"),
  request: comparatorRequestSchema,
  matching: matchingPolicySchema,
  candidateScope: runScopeSchema,
  resolvedCandidateRunIds: z.array(canonicalRunIdSchema).max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct candidate run IDs"),
  activeFilters: z.array(activeFilterSchema).max(16),
  evaluatedCount: z.int().nonnegative(),
  outcome: comparatorMatchOutcomeSchema,
  limitations: z.array(limitationSchema).min(1).max(8),
}).superRefine((result, context) => {
  if (result.candidateScope.kind !== result.request.candidateScope.kind) {
    context.addIssue({ code: "custom", path: ["candidateScope"], message: "Candidate scope does not match the request" });
  }
  if (result.evaluatedCount !== result.resolvedCandidateRunIds.length) {
    context.addIssue({ code: "custom", path: ["evaluatedCount"], message: "Evaluated count does not match resolved candidates" });
  }
  if (!sameMatchingPolicy(result.matching, effectiveMatchingPolicy(result.request))) {
    context.addIssue({ code: "custom", path: ["matching"], message: "Result matching policy does not match the request" });
  }
  const candidates = result.outcome.kind === "eligible-match"
    ? result.outcome.candidates : result.outcome.nearestCandidates;
  const candidateIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (candidateIds.has(candidate.runId)) {
      context.addIssue({ code: "custom", path: ["outcome", index, "runId"], message: "Duplicate comparator candidate" });
    }
    candidateIds.add(candidate.runId);
    if (!result.request.referenceRunId || candidate.context.runIds[0] !== result.request.referenceRunId
      || candidate.context.runIds[1] !== candidate.runId) {
      context.addIssue({
        code: "custom",
        path: ["outcome", index, "context", "runIds"],
        message: "Candidate context must be [reference, candidate]",
      });
    }
  }
  for (const candidate of candidates) {
    const expected = result.outcome.kind === "eligible-match" ? "eligible" : "nearest";
    if (candidate.disposition !== expected) {
      context.addIssue({ code: "custom", path: ["outcome"], message: `Unexpected ${candidate.disposition} candidate` });
    }
  }
});
export type ComparatorSearchResult = z.infer<typeof comparatorSearchResultSchema>;

export const comparisonContextResultSchema = z.union([
  selectedRunsContextResultSchema,
  comparatorSearchResultSchema,
]);
export type ComparisonContextResult = z.infer<typeof comparisonContextResultSchema>;

function sameMatchingPolicy(left: MatchingPolicy, right: MatchingPolicy): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "exact" || right.mode === "exact") return true;
  return left.tolerances.length === right.tolerances.length
    && left.tolerances.every(({ field, tolerance }, index) => (
      right.tolerances[index]?.field === field && right.tolerances[index]?.tolerance === tolerance
    ));
}

export type ComparisonContextValidation = {
  request: ComparisonContextRequest;
  matching: MatchingPolicy;
  issues: CorpusValidationIssue[];
};

/**
 * Corpus-aware checks are separate from schema parsing. Schema conformance does
 * not establish that a run belongs to the active corpus or that a focus field
 * is present in it.
 */
export function validateComparisonContextRequestAgainstDataset(
  dataset: Dataset,
  request: ComparisonContextRequest,
  path = "context",
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  const knownFieldKeys = new Set(dataset.runs.flatMap((run) => run.fields.map(({ key }) => key)));

  if (request.kind === "selected-runs") {
    for (const [index, runId] of request.runIds.entries()) {
      if (!knownRunIds.has(runId)) {
        issues.push(corpusIssue(`${path}.runIds.${index}`, "unknown-run", `Unknown run ID: ${runId}`));
      }
    }
  } else {
    if (!knownRunIds.has(request.referenceRunId)) {
      issues.push(corpusIssue(`${path}.referenceRunId`, "unknown-run", `Unknown reference run: ${request.referenceRunId}`));
    }
    issues.push(...validateRunScopeAgainstDataset(dataset, request.candidateScope, `${path}.candidateScope`));
  }

  if (request.kind === "comparator") {
    if (!knownFieldKeys.has(request.focusCondition)) {
      issues.push(corpusIssue(`${path}.focusCondition`, "unknown-field", "Focus field is absent from the dataset"));
    }
  } else if (request.focusCondition !== undefined && !knownFieldKeys.has(request.focusCondition)) {
    issues.push(corpusIssue(`${path}.focusCondition`, "unknown-field", "Focus field is absent from the dataset"));
  }

  if (request.kind === "comparator" && request.matching?.mode === "tolerance") {
    for (const [index, tolerance] of request.matching.tolerances.entries()) {
      if (!knownFieldKeys.has(tolerance.field)) {
        issues.push(corpusIssue(
          `${path}.matching.tolerances.${index}.field`,
          "unknown-field",
          `Tolerance field is absent from the dataset: ${tolerance.field}`,
        ));
      }
    }
  }
  return issues;
}

export function validateComparisonContextRequest(
  dataset: Dataset,
  request: ComparisonContextRequest,
  path = "context",
): ComparisonContextValidation {
  const parsed = comparisonContextRequestSchema.parse(request);
  return {
    request: parsed,
    matching: parsed.kind === "comparator" ? effectiveMatchingPolicy(parsed) : createExactMatchingPolicy(),
    issues: validateComparisonContextRequestAgainstDataset(dataset, parsed, path),
  };
}

export type FocusCondition = ConditionFieldKey;
export type GasCompositionField = GasCompositionFieldKey;
export const exactMatchingPolicy = createExactMatchingPolicy();
