/**
 * U04.6–U04.7 — Comparison limitation cards and structured export payload.
 *
 * This module turns an already-validated `comparison-context-result-1` result
 * into two browser-safe, pure products:
 *
 * 1. A structured limitation-card presentation for U07 and U06:
 *    - concrete recorded differences with native values, units and deltas;
 *    - missing/unknown and incompatible measurements;
 *    - the exact/tolerance matching rule actually used;
 *    - eligible candidates, nearest ineligible candidates and empty scopes as
 *      distinct states;
 *    - causality, linked-gas-composition and extinction-estimate limits.
 *
 *    Cards copy the authoritative `conditions` / `outcomes` / `gasComposition`
 *    / `evidence` / `limitations` data from the validated result. This module
 *    does not run another comparison, similarity ranking or unit conversion;
 *    it only formats and groups existing fields and messages.
 *
 * 2. A versioned structured JSON export payload for UI/assistant reuse:
 *    - the validated request and result kind;
 *    - dataset, comparison and context rule versions;
 *    - ordered input runs and clear reference/inspected/candidate roles;
 *    - the full condition/outcome fields, composition and evidence;
 *    - displayed candidate coverage, omissions and unknown/mismatched keys;
 *    - the matching policy (exact or inclusive native-unit tolerance);
 *    - all result limitations.
 *
 * The export is deliberately labelled deterministic-comparison,
 * `not-verified`, and `signed: false`. It is not the existing signed evidence
 * brief and does not alter `src/lib/evidence-export.ts`, the evidence API route
 * or receipt signing. The UI owns downloads/DOM and U06 owns provider actions.
 *
 * Import directly: `src/lib/upgrades/comparison-presentation.ts`. `index.ts` is
 * a shared contract file and is not changed by this phase.
 */
import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import { formatEvidenceValue } from "../evidence-format.ts";
import {
  comparisonContextLimitations,
  comparisonContextRequestSchema,
  comparisonContextResultSchema,
  comparisonContextFieldSchema,
  contextEvidenceSchema,
  effectiveMatchingPolicy,
  gasCompositionContextSchema,
  gasCompositionLimitations,
  nativeDeltaSchema,
  validateComparisonContextRequestAgainstDataset,
  type ComparatorCandidate,
  type ComparatorSearchResult,
  type ComparisonContextField,
  type ComparisonContextResult,
  type MatchingPolicy,
  type SelectedRunsContextResult,
} from "./comparison-context.ts";
import {
  conditionFieldKeySchema,
  conditionFieldKeys,
  fieldDefinitionByKey,
  fieldKeySchema,
  gasCompositionFieldKeys,
  numericFieldKeySchema,
  type FieldKey,
} from "./field-catalog.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetVersionSchema,
  nonNegativeFiniteNumberSchema,
  resolveStableFieldReference,
  stableFieldReferenceSchema,
  type CorpusValidationIssue,
  type StableFieldReference,
} from "./provenance.ts";
import {
  activeFilterSchema,
  comparisonRunIdsSchema,
  resolveRunScope,
  type RunScope,
} from "./scope.ts";
import { actionUnavailableCodeSchema } from "./actions.ts";

/** New presentation/export format versions; contract versions are echoed from the result. */
export const comparisonPresentationVersions = {
  presentation: "comparison-presentation-1",
  export: "comparison-export-1",
} as const;

/** Frozen bounds used by the schemas below. */
export const comparisonPresentationLimits = {
  contexts: 10,
  cardsPerContext: 24,
  globalCards: 20,
  runIdsPerCard: 12,
  sourceReferencesPerCard: 16,
  cardText: 500,
} as const;

export const comparisonPresentationErrorCodes = [
  "invalid-dataset",
  "invalid-result",
  "mismatched-result",
  "unsupported-result",
] as const;
export type ComparisonPresentationErrorCode = (typeof comparisonPresentationErrorCodes)[number];

export type ComparisonPresentationErrorDetails = {
  /** Corpus-aware binding issues, when the result does not match the dataset. */
  readonly issues?: readonly CorpusValidationIssue[];
  /** Flattened schema issues, when the result is structurally malformed. */
  readonly parseIssues?: readonly string[];
};

/**
 * Typed failure used before any presentation or export is returned. A
 * mismatched/malformed result never receives an export envelope.
 */
export class ComparisonPresentationError extends Error {
  readonly code: ComparisonPresentationErrorCode;
  readonly details: ComparisonPresentationErrorDetails;

  constructor(
    code: ComparisonPresentationErrorCode,
    message: string,
    details: ComparisonPresentationErrorDetails = {},
  ) {
    super(message);
    this.name = "ComparisonPresentationError";
    this.code = code;
    this.details = details;
  }
}

export function isComparisonPresentationError(value: unknown): value is ComparisonPresentationError {
  return value instanceof ComparisonPresentationError;
}

const nonBlankText = (max: number) => z.string().min(1).max(max)
  .refine((text) => text.trim().length > 0, "Expected non-blank text");

const cardTextSchema = nonBlankText(comparisonPresentationLimits.cardText);

export const comparisonCardKindSchema = z.enum([
  "recorded-difference",
  "missing-measurement",
  "incompatible-measurement",
  "matching-rule",
  "search-outcome",
  "candidate-eligibility",
  "nearest-ineligible",
  "candidate-coverage",
  "empty-candidate-scope",
  "causality",
  "gas-composition",
  "extinction-estimate",
  "unavailable",
]);
export type ComparisonCardKind = z.infer<typeof comparisonCardKindSchema>;

export const comparisonCardSeveritySchema = z.enum(["information", "caution", "not-established"]);
export type ComparisonCardSeverity = z.infer<typeof comparisonCardSeveritySchema>;

/** The applied matching rule, with native units resolved from the catalog. */
export const comparisonMatchRuleSchema = z.strictObject({
  mode: z.enum(["exact", "tolerance"]),
  tolerances: z.array(z.strictObject({
    field: numericFieldKeySchema,
    tolerance: nonNegativeFiniteNumberSchema,
    unit: nonBlankText(64),
    label: nonBlankText(200),
  })).max(8),
}).superRefine((rule, context) => {
  if (rule.mode === "exact" && rule.tolerances.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["tolerances"],
      message: "Exact matching cannot carry numerical tolerances",
    });
  }
  for (const [index, tolerance] of rule.tolerances.entries()) {
    const definition = fieldDefinitionByKey[tolerance.field];
    if (tolerance.unit !== definition.nativeUnit) {
      context.addIssue({
        code: "custom",
        path: ["tolerances", index, "unit"],
        message: "Tolerance unit does not match the reviewed native unit",
      });
    }
    if (tolerance.label !== definition.label) {
      context.addIssue({
        code: "custom",
        path: ["tolerances", index, "label"],
        message: "Tolerance label does not match the reviewed catalog",
      });
    }
  }
});
export type ComparisonMatchRule = z.infer<typeof comparisonMatchRuleSchema>;

export const comparisonLimitationCardSchema = z.strictObject({
  id: nonBlankText(160),
  kind: comparisonCardKindSchema,
  severity: comparisonCardSeveritySchema,
  title: nonBlankText(160),
  text: cardTextSchema,
  fieldKeys: z.array(fieldKeySchema).max(11),
  runIds: z.array(canonicalRunIdSchema).max(comparisonPresentationLimits.runIdsPerCard),
  sourceReferences: z.array(stableFieldReferenceSchema).max(comparisonPresentationLimits.sourceReferencesPerCard),
  deltas: z.array(nativeDeltaSchema).max(3),
  matching: comparisonMatchRuleSchema.optional(),
  disposition: z.enum(["eligible", "nearest"]).optional(),
  contextRunIds: z.array(canonicalRunIdSchema).length(2).optional(),
  reasonCode: nonBlankText(64).optional(),
}).superRefine((card, context) => {
  if (card.kind === "matching-rule" && card.matching === undefined) {
    context.addIssue({ code: "custom", path: ["matching"], message: "A matching-rule card needs the applied rule" });
  }
  if (card.kind !== "matching-rule" && card.matching !== undefined) {
    context.addIssue({ code: "custom", path: ["matching"], message: "Only a matching-rule card carries the applied rule" });
  }
  if (card.kind === "nearest-ineligible" && card.disposition !== "nearest") {
    context.addIssue({ code: "custom", path: ["disposition"], message: "A nearest card needs the nearest disposition" });
  }
  if (card.kind === "candidate-eligibility" && card.disposition !== "eligible") {
    context.addIssue({ code: "custom", path: ["disposition"], message: "An eligibility card needs the eligible disposition" });
  }
  if (card.disposition !== undefined && card.kind !== "nearest-ineligible"
    && card.kind !== "candidate-eligibility") {
    context.addIssue({ code: "custom", path: ["disposition"], message: "Disposition belongs to candidate cards" });
  }
  if (card.contextRunIds !== undefined
    && (card.runIds.length !== card.contextRunIds.length
      || card.runIds.some((runId, index) => runId !== card.contextRunIds![index]))) {
    context.addIssue({ code: "custom", path: ["contextRunIds"], message: "Card run IDs must match the context pair" });
  }
  for (const [index, reference] of card.sourceReferences.entries()) {
    if (!card.runIds.includes(reference.runId)) {
      context.addIssue({
        code: "custom",
        path: ["sourceReferences", index, "runId"],
        message: "Card source reference is outside the card runs",
      });
    }
  }
  for (const [index, delta] of card.deltas.entries()) {
    if (!card.runIds.includes(delta.fromRunId) || !card.runIds.includes(delta.toRunId)) {
      context.addIssue({
        code: "custom",
        path: ["deltas", index],
        message: "Card delta endpoints are outside the card runs",
      });
    }
  }
});
export type ComparisonLimitationCard = z.infer<typeof comparisonLimitationCardSchema>;

export const comparisonContextRoleSchema = z.enum([
  "selected-runs",
  "eligible-candidate",
  "nearest-ineligible-candidate",
]);
export type ComparisonContextRole = z.infer<typeof comparisonContextRoleSchema>;

export const comparisonCandidateMetadataSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  disposition: z.enum(["eligible", "nearest"]),
  mismatchedFieldKeys: z.array(fieldKeySchema).max(12),
  unknownFieldKeys: z.array(fieldKeySchema).max(12),
  incompatibleFieldKeys: z.array(fieldKeySchema).max(12),
  limitations: z.array(cardTextSchema).max(4),
});
export type ComparisonCandidateMetadata = z.infer<typeof comparisonCandidateMetadataSchema>;

export const comparisonRolesSchema = z.strictObject({
  mode: z.enum(["selected-runs", "comparator"]),
  referenceRunId: canonicalRunIdSchema.nullable(),
  /** Selected runs, or the displayed comparator candidates in display order. */
  inspectedRunIds: z.array(canonicalRunIdSchema).max(10),
  focusCondition: conditionFieldKeySchema.nullable(),
});
export type ComparisonRoles = z.infer<typeof comparisonRolesSchema>;

export const comparisonCandidateCoverageSchema = z.strictObject({
  scopeKind: z.enum(["all-reviewed-runs", "filtered-results", "explicit-runs"]),
  activeFilters: z.array(activeFilterSchema).max(16),
  resolvedCandidateRunIds: z.array(canonicalRunIdSchema).max(128),
  evaluatedCount: z.int().nonnegative(),
  displayedCandidateRunIds: z.array(canonicalRunIdSchema).max(10),
  displayedCount: z.int().nonnegative(),
  notDisplayedCandidateRunIds: z.array(canonicalRunIdSchema).max(128),
  truncated: z.boolean(),
  empty: z.boolean(),
});
export type ComparisonCandidateCoverage = z.infer<typeof comparisonCandidateCoverageSchema>;

export const comparisonContextPresentationSchema = z.strictObject({
  runIds: comparisonRunIdsSchema,
  role: comparisonContextRoleSchema,
  disposition: z.enum(["eligible", "nearest"]).nullable(),
  candidate: comparisonCandidateMetadataSchema.nullable(),
  conditions: z.array(comparisonContextFieldSchema).min(1).max(12),
  outcomes: z.array(comparisonContextFieldSchema).min(1).max(12),
  gasComposition: gasCompositionContextSchema,
  evidence: z.array(contextEvidenceSchema).min(1).max(12),
  contextLimitations: z.array(cardTextSchema).min(1).max(8),
  candidateLimitations: z.array(cardTextSchema).max(4),
  cards: z.array(comparisonLimitationCardSchema).min(1).max(comparisonPresentationLimits.cardsPerContext),
}).superRefine((context, refine) => {
  if (context.candidate === null) {
    if (context.disposition !== null) {
      refine.addIssue({ code: "custom", path: ["disposition"], message: "A context without candidate metadata cannot have a disposition" });
    }
  } else {
    if (context.disposition === null) {
      refine.addIssue({ code: "custom", path: ["disposition"], message: "A candidate context needs a disposition" });
    }
    if (context.candidate.disposition !== context.disposition) {
      refine.addIssue({ code: "custom", path: ["candidate", "disposition"], message: "Candidate metadata disposition differs" });
    }
    if (!context.runIds.includes(context.candidate.runId)) {
      refine.addIssue({ code: "custom", path: ["candidate", "runId"], message: "Candidate is absent from the context runs" });
    }
    if (context.candidate.limitations.length !== context.candidateLimitations.length
      || context.candidate.limitations.some((limitation, index) => limitation !== context.candidateLimitations[index])) {
      refine.addIssue({ code: "custom", path: ["candidateLimitations"], message: "Candidate limitations differ from the validated candidate" });
    }
  }
  if (context.role === "selected-runs") {
    if (context.disposition !== null || context.candidate !== null) {
      refine.addIssue({ code: "custom", path: ["role"], message: "A selected-runs context has no candidate disposition" });
    }
  } else if (context.candidate === null) {
    refine.addIssue({ code: "custom", path: ["candidate"], message: "A comparator context needs candidate metadata" });
  }
  if (context.role === "eligible-candidate" && context.disposition !== "eligible") {
    refine.addIssue({ code: "custom", path: ["disposition"], message: "Eligible context role needs the eligible disposition" });
  }
  if (context.role === "nearest-ineligible-candidate" && context.disposition !== "nearest") {
    refine.addIssue({ code: "custom", path: ["disposition"], message: "Nearest context role needs the nearest disposition" });
  }
  if (context.candidate !== null && context.role !== "selected-runs" && context.runIds[1] !== context.candidate.runId) {
    refine.addIssue({ code: "custom", path: ["runIds"], message: "Comparator context must be [reference, candidate]" });
  }

  for (const [group, fields] of [["conditions", context.conditions], ["outcomes", context.outcomes]] as const) {
    for (const [fieldIndex, field] of fields.entries()) {
      if (field.cells.length !== context.runIds.length
        || field.cells.some(({ runId }, cellIndex) => runId !== context.runIds[cellIndex])) {
        refine.addIssue({
          code: "custom",
          path: [group, fieldIndex, "cells"],
          message: "Presentation cells must follow the ordered run list",
        });
      }
    }
  }
  if (context.gasComposition.values.length !== context.runIds.length
    || context.gasComposition.values.some(({ runId }, index) => runId !== context.runIds[index])) {
    refine.addIssue({ code: "custom", path: ["gasComposition", "values"], message: "Gas rows must follow the ordered run list" });
  }
  if (new Set(context.cards.map(({ id }) => id)).size !== context.cards.length) {
    refine.addIssue({ code: "custom", path: ["cards"], message: "Card IDs must be unique within a context" });
  }
});
export type ComparisonContextPresentation = z.infer<typeof comparisonContextPresentationSchema>;

export const comparisonSearchStateSchema = z.enum(["not-applicable", "eligible", "no-eligible", "empty"]);
export type ComparisonSearchState = z.infer<typeof comparisonSearchStateSchema>;

export const comparisonPresentationSchema = z.strictObject({
  kind: z.literal("comparison-presentation"),
  presentationVersion: z.literal(comparisonPresentationVersions.presentation),
  status: z.literal("available"),
  resultKind: z.enum(["selected-runs-context", "comparator-search"]),
  datasetVersion: datasetVersionSchema,
  comparisonRuleVersion: nonBlankText(64),
  contextRuleVersion: z.literal("comparison-context-1"),
  request: comparisonContextRequestSchema,
  roles: comparisonRolesSchema,
  matching: comparisonMatchRuleSchema.nullable(),
  requiredMatchFieldKeys: z.array(conditionFieldKeySchema).max(12),
  searchState: comparisonSearchStateSchema,
  coverage: comparisonCandidateCoverageSchema.nullable(),
  globalCards: z.array(comparisonLimitationCardSchema).max(comparisonPresentationLimits.globalCards),
  contexts: z.array(comparisonContextPresentationSchema).max(comparisonPresentationLimits.contexts),
  limitations: z.array(cardTextSchema).min(1).max(8),
}).superRefine((presentation, refine) => {
  const allCardIds = [
    ...presentation.globalCards.map(({ id }) => id),
    ...presentation.contexts.flatMap(({ cards }) => cards.map(({ id }) => id)),
  ];
  if (new Set(allCardIds).size !== allCardIds.length) {
    refine.addIssue({ code: "custom", path: ["globalCards"], message: "Card IDs must be unique across the presentation" });
  }

  if (presentation.resultKind === "selected-runs-context") {
    if (presentation.request.kind !== "selected-runs") {
      refine.addIssue({ code: "custom", path: ["request", "kind"], message: "Selected presentation needs a selected-runs request" });
    }
    if (presentation.roles.mode !== "selected-runs") {
      refine.addIssue({ code: "custom", path: ["roles", "mode"], message: "Selected presentation needs selected-run roles" });
    }
    if (presentation.roles.referenceRunId !== null) {
      refine.addIssue({ code: "custom", path: ["roles", "referenceRunId"], message: "Selected runs have no comparator reference" });
    }
    if (presentation.matching !== null) {
      refine.addIssue({ code: "custom", path: ["matching"], message: "Selected runs carry no comparator matching rule" });
    }
    if (presentation.coverage !== null) {
      refine.addIssue({ code: "custom", path: ["coverage"], message: "Selected runs carry no candidate coverage" });
    }
    if (presentation.searchState !== "not-applicable") {
      refine.addIssue({ code: "custom", path: ["searchState"], message: "Selected runs have no comparator search state" });
    }
    if (presentation.requiredMatchFieldKeys.length) {
      refine.addIssue({ code: "custom", path: ["requiredMatchFieldKeys"], message: "Selected runs have no required comparator fields" });
    }
    if (presentation.contexts.length !== 1) {
      refine.addIssue({ code: "custom", path: ["contexts"], message: "A selected-run presentation has exactly one context" });
    }
    const [context] = presentation.contexts;
    if (context) {
      if (context.role !== "selected-runs") {
        refine.addIssue({ code: "custom", path: ["contexts", 0, "role"], message: "Selected context role differs" });
      }
      if (presentation.request.kind === "selected-runs") {
        if (!sameStringOrder(context.runIds, presentation.request.runIds)) {
          refine.addIssue({ code: "custom", path: ["contexts", 0, "runIds"], message: "Context runs do not follow the request" });
        }
        if (!sameStringOrder(presentation.roles.inspectedRunIds, presentation.request.runIds)) {
          refine.addIssue({ code: "custom", path: ["roles", "inspectedRunIds"], message: "Inspected runs do not follow the request" });
        }
        if (presentation.roles.focusCondition !== (presentation.request.focusCondition ?? null)) {
          refine.addIssue({ code: "custom", path: ["roles", "focusCondition"], message: "Focus condition differs from the request" });
        }
      }
      if (context.candidate !== null || context.disposition !== null) {
        refine.addIssue({ code: "custom", path: ["contexts", 0], message: "Selected context cannot carry candidate data" });
      }
    }
    return;
  }

  if (presentation.request.kind !== "comparator") {
    refine.addIssue({ code: "custom", path: ["request", "kind"], message: "Comparator presentation needs a comparator request" });
    return;
  }
  const request = presentation.request;
  if (presentation.roles.mode !== "comparator") {
    refine.addIssue({ code: "custom", path: ["roles", "mode"], message: "Comparator presentation needs comparator roles" });
  }
  if (presentation.roles.referenceRunId !== request.referenceRunId) {
    refine.addIssue({ code: "custom", path: ["roles", "referenceRunId"], message: "Reference role differs from the request" });
  }
  if (presentation.roles.focusCondition !== request.focusCondition) {
    refine.addIssue({ code: "custom", path: ["roles", "focusCondition"], message: "Focus role differs from the request" });
  }
  if (presentation.matching === null) {
    refine.addIssue({ code: "custom", path: ["matching"], message: "Comparator presentation needs the applied matching rule" });
  } else {
    const effective = effectiveMatchingPolicy(request);
    if (presentation.matching.mode !== effective.mode) {
      refine.addIssue({ code: "custom", path: ["matching", "mode"], message: "Applied matching mode differs from the request" });
    } else if (effective.mode === "tolerance" && presentation.matching.mode === "tolerance"
      && !sameTolerances(presentation.matching.tolerances, effective.tolerances)) {
      refine.addIssue({ code: "custom", path: ["matching", "tolerances"], message: "Applied tolerances differ from the request" });
    }
  }
  const expectedRequired = conditionFieldKeys.filter((key) => key !== request.focusCondition);
  if (!sameStringOrder(presentation.requiredMatchFieldKeys, expectedRequired)) {
    refine.addIssue({
      code: "custom",
      path: ["requiredMatchFieldKeys"],
      message: "Required fields must be every reviewed condition except the focus",
    });
  }
  if (presentation.coverage === null) {
    refine.addIssue({ code: "custom", path: ["coverage"], message: "Comparator presentation needs candidate coverage" });
    return;
  }
  const coverage = presentation.coverage;
  if (coverage.evaluatedCount !== coverage.resolvedCandidateRunIds.length) {
    refine.addIssue({ code: "custom", path: ["coverage", "evaluatedCount"], message: "Evaluated count differs from resolved candidates" });
  }
  if (coverage.displayedCount !== coverage.displayedCandidateRunIds.length) {
    refine.addIssue({ code: "custom", path: ["coverage", "displayedCount"], message: "Displayed count differs from displayed candidates" });
  }
  if (coverage.truncated !== (coverage.notDisplayedCandidateRunIds.length > 0)) {
    refine.addIssue({ code: "custom", path: ["coverage", "truncated"], message: "Truncation flag differs from omitted candidates" });
  }
  if (coverage.empty !== (coverage.evaluatedCount === 0)) {
    refine.addIssue({ code: "custom", path: ["coverage", "empty"], message: "Empty flag differs from the evaluated count" });
  }
  const displayedSet = new Set(coverage.displayedCandidateRunIds);
  const expectedNotDisplayed = coverage.resolvedCandidateRunIds.filter((runId) => !displayedSet.has(runId));
  if (!sameStringOrder(coverage.notDisplayedCandidateRunIds, expectedNotDisplayed)) {
    refine.addIssue({
      code: "custom",
      path: ["coverage", "notDisplayedCandidateRunIds"],
      message: "Omitted candidates must be resolved candidates not displayed",
    });
  }
  for (const runId of coverage.displayedCandidateRunIds) {
    if (!coverage.resolvedCandidateRunIds.includes(runId)) {
      refine.addIssue({
        code: "custom",
        path: ["coverage", "displayedCandidateRunIds"],
        message: "Displayed candidates must belong to the resolved candidates",
      });
      break;
    }
  }
  if (new Set(coverage.displayedCandidateRunIds).size !== coverage.displayedCandidateRunIds.length) {
    refine.addIssue({
      code: "custom",
      path: ["coverage", "displayedCandidateRunIds"],
      message: "Displayed candidates must be distinct",
    });
  }
  if (!sameStringOrder(presentation.roles.inspectedRunIds, coverage.displayedCandidateRunIds)) {
    refine.addIssue({ code: "custom", path: ["roles", "inspectedRunIds"], message: "Inspected candidates differ from displayed candidates" });
  }
  if (presentation.contexts.length !== coverage.displayedCount) {
    refine.addIssue({ code: "custom", path: ["contexts"], message: "Context count differs from displayed candidate coverage" });
  }
  if (!sameStringOrder(
    coverage.displayedCandidateRunIds,
    presentation.contexts.map(({ runIds }) => runIds[1]),
  )) {
    refine.addIssue({
      code: "custom",
      path: ["contexts"],
      message: "Context order must follow the displayed candidates",
    });
  }
  if (presentation.searchState === "eligible" && coverage.displayedCount === 0) {
    refine.addIssue({ code: "custom", path: ["searchState"], message: "Eligible search state needs a displayed candidate" });
  }
  if (presentation.searchState === "empty" && (!coverage.empty || presentation.contexts.length !== 0)) {
    refine.addIssue({ code: "custom", path: ["searchState"], message: "Empty search state needs an empty scope and no contexts" });
  }
  if (presentation.searchState === "no-eligible" && coverage.empty) {
    refine.addIssue({ code: "custom", path: ["searchState"], message: "No-eligible state is not an empty scope" });
  }
  for (const [index, context] of presentation.contexts.entries()) {
    if (context.role === "selected-runs" || context.disposition === null) {
      refine.addIssue({ code: "custom", path: ["contexts", index, "role"], message: "Comparator contexts need candidate roles" });
      continue;
    }
    if (!sameStringOrder(context.runIds, [request.referenceRunId, context.runIds[1]])) {
      refine.addIssue({ code: "custom", path: ["contexts", index, "runIds"], message: "Comparator context must start with the reference" });
    }
    if (presentation.searchState === "eligible" && context.disposition !== "eligible") {
      refine.addIssue({ code: "custom", path: ["contexts", index, "disposition"], message: "Eligible search displays only eligible candidates" });
    }
    if (presentation.searchState !== "eligible" && context.disposition !== "nearest") {
      refine.addIssue({ code: "custom", path: ["contexts", index, "disposition"], message: "No-eligible search displays only nearest candidates" });
    }
  }
});
export type ComparisonAvailablePresentation = z.infer<typeof comparisonPresentationSchema>;

export const comparisonUnavailablePresentationSchema = z.strictObject({
  kind: z.literal("comparison-presentation"),
  presentationVersion: z.literal(comparisonPresentationVersions.presentation),
  status: z.literal("unavailable"),
  code: actionUnavailableCodeSchema,
  message: cardTextSchema,
  cards: z.array(comparisonLimitationCardSchema).min(1).max(4),
}).superRefine((presentation, refine) => {
  if (presentation.cards.some(({ kind }) => kind !== "unavailable")) {
    refine.addIssue({ code: "custom", path: ["cards"], message: "An unavailable presentation carries only unavailable cards" });
  }
});
export type ComparisonUnavailablePresentation = z.infer<typeof comparisonUnavailablePresentationSchema>;

export const comparisonPresentationUnionSchema = z.union([
  comparisonPresentationSchema,
  comparisonUnavailablePresentationSchema,
]);
export type ComparisonPresentation = z.infer<typeof comparisonPresentationUnionSchema>;

/**
 * Explicit marker for the structured comparison export. It is deterministic
 * comparison data, not the existing signed evidence brief.
 */
export const comparisonExportSignatureNote =
  "This is a deterministic comparison presentation export. It is not the existing signed evidence brief: it is not signed, not a receipt, and does not verify authorship or scientific correctness. The existing evidence-export route and signing are unchanged.";

export const comparisonExportPayloadSchema = z.strictObject({
  format: z.literal("fire-evidence-comparison-export"),
  formatVersion: z.literal(comparisonPresentationVersions.export),
  authority: z.literal("deterministic-comparison"),
  verification: z.literal("not-verified"),
  signed: z.literal(false),
  signatureNote: z.literal(comparisonExportSignatureNote),
  datasetVersion: datasetVersionSchema,
  comparisonRuleVersion: nonBlankText(64),
  contextRuleVersion: z.literal("comparison-context-1"),
  resultKind: z.enum(["selected-runs-context", "comparator-search"]),
  request: comparisonContextRequestSchema,
  presentation: comparisonPresentationSchema,
}).superRefine((payload, refine) => {
  const presentation = payload.presentation;
  if (presentation.datasetVersion !== payload.datasetVersion) {
    refine.addIssue({ code: "custom", path: ["datasetVersion"], message: "Export and presentation dataset versions differ" });
  }
  if (presentation.comparisonRuleVersion !== payload.comparisonRuleVersion) {
    refine.addIssue({ code: "custom", path: ["comparisonRuleVersion"], message: "Export and presentation comparison rule versions differ" });
  }
  if (presentation.resultKind !== payload.resultKind) {
    refine.addIssue({ code: "custom", path: ["resultKind"], message: "Export and presentation result kinds differ" });
  }
  if (JSON.stringify(presentation.request) !== JSON.stringify(payload.request)) {
    refine.addIssue({ code: "custom", path: ["request"], message: "Export and presentation requests differ" });
  }
});
export type ComparisonExportPayload = z.infer<typeof comparisonExportPayloadSchema>;

function describeParseIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map(({ path, message }) => {
    const location = path.length ? path.map(String).join(".") : "(root)";
    return `${location}: ${message}`;
  });
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function shortIssueMessage(message: string): string {
  return clip(message, 280);
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTolerances(
  left: readonly { field: string; tolerance: number }[],
  right: readonly { field: string; tolerance: number }[],
): boolean {
  return left.length === right.length
    && left.every(({ field, tolerance }, index) => (
      right[index]?.field === field && right[index]?.tolerance === tolerance
    ));
}

function sameRunScope(left: RunScope, right: RunScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDatasetShape(dataset: Dataset): void {
  const candidate = dataset as unknown as {
    version?: unknown;
    sources?: unknown;
    runs?: unknown;
  } | null | undefined;
  if (!candidate
    || typeof candidate !== "object"
    || typeof candidate.version !== "string"
    || candidate.version.trim().length === 0
    || !Array.isArray(candidate.sources)
    || !Array.isArray(candidate.runs)) {
    throw new ComparisonPresentationError(
      "invalid-dataset",
      "A parsed dataset with a non-empty version, sources and runs is required. Parse the corpus before presenting a comparison.",
    );
  }
}

function parseComparisonResult(result: unknown): ComparisonContextResult {
  const parsed = comparisonContextResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new ComparisonPresentationError(
      "invalid-result",
      "The comparison result is malformed and cannot be presented as evidence.",
      { parseIssues: describeParseIssues(parsed.error) },
    );
  }
  return parsed.data;
}

function unresolvedReferenceCode(
  status: "dataset-version-mismatch" | "unknown-run" | "unknown-field" | "source-mismatch" | "unknown-source",
): CorpusValidationIssue["code"] {
  switch (status) {
    case "dataset-version-mismatch": return "version-mismatch";
    case "unknown-run": return "unknown-run";
    case "unknown-field": return "unknown-field";
    case "source-mismatch": return "source-mismatch";
    case "unknown-source": return "unknown-source";
  }
}

function contextBindingIssues(
  dataset: Dataset,
  context: SelectedRunsContextResult,
  path: string,
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  if (context.datasetVersion !== dataset.version) {
    issues.push(corpusIssue(
      `${path}.datasetVersion`,
      "version-mismatch",
      shortIssueMessage(`Comparison context version ${context.datasetVersion} does not match ${dataset.version}`),
    ));
  }
  issues.push(...validateComparisonContextRequestAgainstDataset(dataset, context.request, `${path}.request`));
  if (!sameStringOrder(context.request.runIds, context.runIds)) {
    issues.push(corpusIssue(
      `${path}.runIds`,
      "binding-mismatch",
      "Comparison context runs do not follow the request order and length.",
    ));
  }

  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  for (const [index, runId] of context.runIds.entries()) {
    if (!knownRunIds.has(runId)) {
      issues.push(corpusIssue(`${path}.runIds.${index}`, "unknown-run", shortIssueMessage(`Unknown run ID: ${runId}`)));
    }
  }

  const groups = [["conditions", context.conditions], ["outcomes", context.outcomes]] as const;
  for (const [group, fields] of groups) {
    for (const [fieldIndex, field] of fields.entries()) {
      for (const [cellIndex, cell] of field.cells.entries()) {
        const cellPath = `${path}.${group}.${fieldIndex}.cells.${cellIndex}`;
        if (cell.reference === null) {
          if (cell.value !== null || cell.original !== null) {
            issues.push(corpusIssue(
              cellPath,
              "binding-mismatch",
              "A recorded comparison cell needs a stable source reference.",
            ));
          }
          continue;
        }
        if (cell.reference.runId !== cell.runId) {
          issues.push(corpusIssue(cellPath, "binding-mismatch", "The cell reference uses another run."));
        }
        if (cell.reference.fieldKey !== field.key) {
          issues.push(corpusIssue(cellPath, "binding-mismatch", "The cell reference uses another field."));
        }
        const resolution = resolveStableFieldReference(dataset, cell.reference);
        if (resolution.status !== "resolved") {
          issues.push(corpusIssue(
            cellPath,
            unresolvedReferenceCode(resolution.status),
            shortIssueMessage(`Source reference did not resolve: ${cell.runId}/${field.key}`),
          ));
          continue;
        }
        if (resolution.field.value !== cell.value) {
          issues.push(corpusIssue(cellPath, "invalid-value", "The cell value does not match the recorded source value."));
        }
        if (resolution.field.original !== cell.original) {
          issues.push(corpusIssue(cellPath, "invalid-value", "The cell original text does not match the recorded source text."));
        }
      }
      for (const [deltaIndex, delta] of field.deltas.entries()) {
        const from = field.cells.find(({ runId }) => runId === delta.fromRunId);
        const to = field.cells.find(({ runId }) => runId === delta.toRunId);
        if (!from || !to) {
          issues.push(corpusIssue(
            `${path}.${group}.${fieldIndex}.deltas.${deltaIndex}`,
            "binding-mismatch",
            "A native delta endpoint is absent from the field cells.",
          ));
          continue;
        }
        if (typeof from.value !== "number" || typeof to.value !== "number") {
          issues.push(corpusIssue(
            `${path}.${group}.${fieldIndex}.deltas.${deltaIndex}`,
            "invalid-value",
            "A native delta needs two numeric cells.",
          ));
          continue;
        }
        if (delta.delta !== to.value - from.value) {
          issues.push(corpusIssue(
            `${path}.${group}.${fieldIndex}.deltas.${deltaIndex}.delta`,
            "invalid-value",
            "A native delta does not equal the later cell minus the earlier cell.",
          ));
        }
      }
    }
  }

  const gasFieldMap = new Map(
    context.conditions
      .filter(({ key }) => gasCompositionFieldKeys.includes(key as (typeof gasCompositionFieldKeys)[number]))
      .map((field) => [field.key, field]),
  );
  for (const [rowIndex, row] of context.gasComposition.values.entries()) {
    for (const key of gasCompositionFieldKeys) {
      const field = gasFieldMap.get(key);
      const cell = field?.cells.find(({ runId }) => runId === row.runId);
      if (cell && cell.value !== row.values[key]) {
        issues.push(corpusIssue(
          `${path}.gasComposition.values.${rowIndex}.${key}`,
          "invalid-value",
          "The gas-composition value does not match the recorded condition cell.",
        ));
      }
    }
  }
  for (const [differenceIndex, difference] of context.gasComposition.differences.entries()) {
    const from = context.gasComposition.values.find(({ runId }) => runId === difference.fromRunId);
    const to = context.gasComposition.values.find(({ runId }) => runId === difference.toRunId);
    if (!from || !to) {
      issues.push(corpusIssue(
        `${path}.gasComposition.differences.${differenceIndex}`,
        "binding-mismatch",
        "A composition difference endpoint is absent from the gas values.",
      ));
      continue;
    }
    for (const [valueIndex, value] of difference.values.entries()) {
      const fromValue = from.values[value.key];
      const toValue = to.values[value.key];
      if (fromValue === null || toValue === null) {
        issues.push(corpusIssue(
          `${path}.gasComposition.differences.${differenceIndex}.values.${valueIndex}`,
          "invalid-value",
          "A composition difference needs both recorded gas values.",
        ));
        continue;
      }
      if (value.delta !== toValue - fromValue) {
        issues.push(corpusIssue(
          `${path}.gasComposition.differences.${differenceIndex}.values.${valueIndex}.delta`,
          "invalid-value",
          "A composition difference does not equal the later gas value minus the earlier value.",
        ));
      }
    }
  }

  for (const [evidenceIndex, evidence] of context.evidence.entries()) {
    for (const [referenceIndex, reference] of evidence.sourceReferences.entries()) {
      const resolution = resolveStableFieldReference(dataset, reference);
      if (resolution.status !== "resolved") {
        issues.push(corpusIssue(
          `${path}.evidence.${evidenceIndex}.sourceReferences.${referenceIndex}`,
          unresolvedReferenceCode(resolution.status),
          shortIssueMessage(`Evidence source reference did not resolve: ${reference.runId}/${reference.fieldKey}`),
        ));
      }
    }
  }
  return issues;
}

function comparisonResultBindingIssues(
  dataset: Dataset,
  result: ComparisonContextResult,
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  if (result.datasetVersion !== dataset.version) {
    issues.push(corpusIssue(
      "result.datasetVersion",
      "version-mismatch",
      shortIssueMessage(`Comparison result version ${result.datasetVersion} does not match ${dataset.version}`),
    ));
  }
  if (result.kind === "selected-runs-context") {
    issues.push(...contextBindingIssues(dataset, result, "result"));
    return issues;
  }

  issues.push(...validateComparisonContextRequestAgainstDataset(dataset, result.request, "result.request"));
  if (!sameRunScope(result.candidateScope, result.request.candidateScope)) {
    issues.push(corpusIssue(
      "result.candidateScope",
      "binding-mismatch",
      "Comparator candidate scope does not match the request.",
    ));
  }
  const scopeResolution = resolveRunScope(dataset, result.request.candidateScope);
  if (!scopeResolution.ok) {
    issues.push(...scopeResolution.issues);
  } else {
    const expectedCandidateIds = scopeResolution.resolved.runIds
      .filter((runId) => runId !== result.request.referenceRunId);
    if (!sameStringOrder(result.resolvedCandidateRunIds, expectedCandidateIds)) {
      issues.push(corpusIssue(
        "result.resolvedCandidateRunIds",
        "binding-mismatch",
        "Resolved candidates must be the requested scope after excluding the reference.",
      ));
    }
  }

  const candidates = result.outcome.kind === "eligible-match"
    ? result.outcome.candidates
    : result.outcome.nearestCandidates;
  const candidateGroup = result.outcome.kind === "eligible-match" ? "candidates" : "nearestCandidates";
  for (const [index, candidate] of candidates.entries()) {
    const candidatePath = `result.outcome.${candidateGroup}.${index}`;
    if (!result.resolvedCandidateRunIds.includes(candidate.runId)) {
      issues.push(corpusIssue(
        `${candidatePath}.runId`,
        "binding-mismatch",
        "A displayed candidate is absent from the resolved candidate scope.",
      ));
    }
    if (candidate.context.datasetVersion !== dataset.version) {
      issues.push(corpusIssue(
        `${candidatePath}.context.datasetVersion`,
        "version-mismatch",
        "A candidate context uses another dataset version.",
      ));
    }
    if (candidate.context.runIds.length !== 2
      || candidate.context.runIds[0] !== result.request.referenceRunId
      || candidate.context.runIds[1] !== candidate.runId) {
      issues.push(corpusIssue(
        `${candidatePath}.context.runIds`,
        "binding-mismatch",
        "A candidate context must be [reference, candidate].",
      ));
    }
    issues.push(...contextBindingIssues(dataset, candidate.context, `${candidatePath}.context`));
  }
  return issues;
}

/**
 * Corpus-aware binding check used by the builders. A valid result that does not
 * match the supplied dataset (version, runs, scope, source value, computed
 * delta or gas row) produces issues instead of a presentation.
 */
export function validateComparisonPresentationInput(
  dataset: Dataset,
  result: unknown,
): CorpusValidationIssue[] {
  assertDatasetShape(dataset);
  const parsed = comparisonContextResultSchema.safeParse(result);
  if (!parsed.success) {
    return [corpusIssue(
      "result",
      "invalid-value",
      shortIssueMessage(`Malformed comparison result: ${describeParseIssues(parsed.error).join("; ")}`),
    )];
  }
  return comparisonResultBindingIssues(dataset, parsed.data);
}

function preparationForResult(
  dataset: Dataset,
  result: unknown,
): ComparisonContextResult {
  assertDatasetShape(dataset);
  const parsed = parseComparisonResult(result);
  const issues = comparisonResultBindingIssues(dataset, parsed);
  if (issues.length) {
    throw new ComparisonPresentationError(
      "mismatched-result",
      "The comparison result does not match the active dataset or its own request; it cannot be labelled as comparison evidence.",
      { issues },
    );
  }
  return parsed;
}

function formatCell(cell: ComparisonContextField["cells"][number], unit: string | null): string {
  const value = formatEvidenceValue(cell.value, { original: cell.original });
  return `${cell.runId} ${value}${unit === null ? "" : ` ${unit}`}`;
}

function recordedDifferenceText(field: ComparisonContextField): string {
  const values = field.cells.map((cell) => formatCell(cell, field.unit)).join("; ");
  if (field.unit === null) {
    return clip(`Recorded values: ${values}. ${field.reason}`, comparisonPresentationLimits.cardText);
  }
  const deltas = field.deltas
    .map(({ fromRunId, toRunId, delta, unit }) => (
      `${toRunId} minus ${fromRunId} = ${formatEvidenceValue(delta, { signed: true })} ${unit}`
    ))
    .join("; ");
  return clip(
    `Recorded values: ${values}.${deltas ? ` Native deltas: ${deltas}.` : ""}`,
    comparisonPresentationLimits.cardText,
  );
}

function missingMeasurementText(field: ComparisonContextField): string {
  const known = field.cells
    .filter(({ value }) => value !== null)
    .map((cell) => formatCell(cell, field.unit))
    .join("; ");
  return clip(
    `${known ? `Known values: ${known}. ` : ""}${field.reason}`,
    comparisonPresentationLimits.cardText,
  );
}

function fieldReferences(field: ComparisonContextField): StableFieldReference[] {
  return field.cells
    .map(({ reference }) => reference)
    .filter((reference): reference is StableFieldReference => reference !== null)
    .slice(0, comparisonPresentationLimits.sourceReferencesPerCard);
}

function fieldReferencesForKeys(
  context: ComparisonContextPresentation | SelectedRunsContextResult,
  keys: readonly FieldKey[],
): StableFieldReference[] {
  const fields = [...context.conditions, ...context.outcomes].filter(({ key }) => keys.includes(key));
  const references: StableFieldReference[] = [];
  for (const field of fields) {
    for (const reference of fieldReferences(field)) {
      references.push(reference);
      if (references.length >= comparisonPresentationLimits.sourceReferencesPerCard) return references;
    }
  }
  return references;
}

function cardPrefixRole(role: ComparisonContextRole, candidateRunId: string | null): string {
  if (role === "selected-runs") return "selected";
  return `candidate:${candidateRunId ?? "unknown"}`;
}

function finishCard(card: ComparisonLimitationCard): ComparisonLimitationCard {
  return comparisonLimitationCardSchema.parse(card);
}

function buildFieldCard(
  context: SelectedRunsContextResult,
  field: ComparisonContextField,
  prefix: string,
): ComparisonLimitationCard | null {
  if (field.status === "same") return null;
  const references = fieldReferences(field);
  const base = {
    fieldKeys: [field.key],
    runIds: [...context.runIds],
    sourceReferences: references,
  };
  if (field.status === "different") {
    return finishCard({
      ...base,
      id: `${prefix}:field:${field.key}:different`,
      kind: "recorded-difference",
      severity: "information",
      title: `Recorded difference: ${field.label}`,
      text: recordedDifferenceText(field),
      deltas: field.deltas.map((delta) => ({ ...delta })),
    });
  }
  if (field.status === "unknown") {
    return finishCard({
      ...base,
      id: `${prefix}:field:${field.key}:unknown`,
      kind: "missing-measurement",
      severity: "caution",
      title: `Unknown measurement: ${field.label}`,
      text: missingMeasurementText(field),
      deltas: [],
    });
  }
  return finishCard({
    ...base,
    id: `${prefix}:field:${field.key}:incompatible`,
    kind: "incompatible-measurement",
    severity: "caution",
    title: `Incompatible measurement: ${field.label}`,
    text: field.reason,
    deltas: [],
  });
}

function buildGasCompositionCard(
  context: SelectedRunsContextResult,
  prefix: string,
): ComparisonLimitationCard {
  return finishCard({
    id: `${prefix}:gas-composition`,
    kind: "gas-composition",
    severity: "not-established",
    title: "Gas composition is linked",
    text: context.gasComposition.limitation,
    fieldKeys: [...gasCompositionFieldKeys],
    runIds: [...context.runIds],
    sourceReferences: fieldReferencesForKeys(context, gasCompositionFieldKeys),
    deltas: [],
  });
}

function buildIncompleteGasCard(
  context: SelectedRunsContextResult,
  prefix: string,
): ComparisonLimitationCard {
  const incompleteRunIds = context.gasComposition.values
    .filter(({ values }) => gasCompositionFieldKeys.some((key) => values[key] === null))
    .map(({ runId }) => runId);
  const incomplete = new Set(incompleteRunIds);
  const references = fieldReferencesForKeys(context, gasCompositionFieldKeys)
    .filter(({ runId }) => incomplete.has(runId));
  return finishCard({
    id: `${prefix}:gas-composition:incomplete`,
    kind: "missing-measurement",
    severity: "caution",
    title: "Incomplete gas composition",
    text: gasCompositionLimitations.incomplete,
    fieldKeys: [...gasCompositionFieldKeys],
    runIds: incompleteRunIds,
    sourceReferences: references,
    deltas: [],
  });
}

function buildExtinctionCard(
  context: SelectedRunsContextResult,
  prefix: string,
): ComparisonLimitationCard | null {
  const field = [...context.conditions, ...context.outcomes]
    .find(({ key }) => key === "extinction_diameter");
  if (!field) return null;
  return finishCard({
    id: `${prefix}:extinction-estimate`,
    kind: "extinction-estimate",
    severity: "not-established",
    title: "Visible-extinction diameters may be estimated",
    text: comparisonContextLimitations.extinction,
    fieldKeys: [field.key],
    runIds: [...context.runIds],
    sourceReferences: fieldReferences(field),
    deltas: [],
  });
}

function buildCausalityCard(
  context: SelectedRunsContextResult,
  prefix: string,
): ComparisonLimitationCard {
  return finishCard({
    id: `${prefix}:causality`,
    kind: "causality",
    severity: "not-established",
    title: "Causality is not established",
    text: comparisonContextLimitations.causal,
    fieldKeys: [],
    runIds: [...context.runIds],
    sourceReferences: [],
    deltas: [],
  });
}

function buildContextPresentation(
  context: SelectedRunsContextResult,
  options: {
    role: ComparisonContextRole;
    disposition: "eligible" | "nearest" | null;
    candidate: ComparisonCandidateMetadata | null;
    candidateLimitations: string[];
  },
): ComparisonContextPresentation {
  const prefix = cardPrefixRole(options.role, options.candidate?.runId ?? null);
  const cards: ComparisonLimitationCard[] = [];
  for (const field of [...context.conditions, ...context.outcomes]) {
    const card = buildFieldCard(context, field, prefix);
    if (card) cards.push(card);
  }
  cards.push(buildGasCompositionCard(context, prefix));
  if (!context.gasComposition.complete) cards.push(buildIncompleteGasCard(context, prefix));
  const extinction = buildExtinctionCard(context, prefix);
  if (extinction) cards.push(extinction);
  cards.push(buildCausalityCard(context, prefix));

  return comparisonContextPresentationSchema.parse({
    runIds: [...context.runIds],
    role: options.role,
    disposition: options.disposition,
    candidate: options.candidate,
    conditions: context.conditions,
    outcomes: context.outcomes,
    gasComposition: context.gasComposition,
    evidence: context.evidence,
    contextLimitations: [...context.limitations],
    candidateLimitations: [...options.candidateLimitations],
    cards,
  });
}

function candidateMetadata(candidate: ComparatorCandidate): ComparisonCandidateMetadata {
  return {
    runId: candidate.runId,
    disposition: candidate.disposition,
    mismatchedFieldKeys: [...candidate.mismatchedFieldKeys],
    unknownFieldKeys: [...candidate.unknownFieldKeys],
    incompatibleFieldKeys: [...candidate.incompatibleFieldKeys],
    limitations: [...candidate.limitations],
  };
}

function buildMatchRule(matching: MatchingPolicy): ComparisonMatchRule {
  if (matching.mode === "exact") return { mode: "exact", tolerances: [] };
  return {
    mode: "tolerance",
    tolerances: matching.tolerances.map(({ field, tolerance }) => {
      const definition = fieldDefinitionByKey[field];
      if (definition.nativeUnit === null) {
        throw new ComparisonPresentationError(
          "unsupported-result",
          `Numeric tolerance field ${field} has no reviewed native unit.`,
        );
      }
      return {
        field,
        tolerance,
        unit: definition.nativeUnit,
        label: definition.label,
      };
    }),
  };
}

function matchingRuleText(rule: ComparisonMatchRule): string {
  if (rule.mode === "exact") {
    return clip(`Exact matching is the default and no numeric tolerance was declared. ${comparisonContextLimitations.unknown}`, comparisonPresentationLimits.cardText);
  }
  const tolerances = rule.tolerances
    .map(({ label, tolerance, unit }) => `${label} ±${formatEvidenceValue(tolerance)} ${unit}`)
    .join("; ");
  return clip(
    `${comparisonContextLimitations.tolerance} The boundary is inclusive in each native unit: ${tolerances}.`,
    comparisonPresentationLimits.cardText,
  );
}

function buildMatchingRuleCard(rule: ComparisonMatchRule): ComparisonLimitationCard {
  return finishCard({
    id: "search:matching",
    kind: "matching-rule",
    severity: "information",
    title: rule.mode === "exact" ? "Matching rule: exact" : "Matching rule: inclusive tolerance",
    text: matchingRuleText(rule),
    fieldKeys: rule.tolerances.map(({ field }) => field),
    runIds: [],
    sourceReferences: [],
    deltas: [],
    matching: rule,
  });
}

function buildSearchOutcomeCard(
  result: ComparatorSearchResult,
  matchRule: ComparisonMatchRule,
): ComparisonLimitationCard {
  if (result.outcome.kind === "eligible-match") {
    const runIds = result.outcome.candidates.map(({ runId }) => runId);
    return finishCard({
      id: "search:outcome",
      kind: "search-outcome",
      severity: "information",
      title: "Eligible matches found",
      text: clip(
        `${runIds.length} candidate${runIds.length === 1 ? "" : "s"} satisfied the ${matchRule.mode} matching rule under the required conditions. Eligibility is a search result, not a scientific equivalence claim.`,
        comparisonPresentationLimits.cardText,
      ),
      fieldKeys: [],
      runIds,
      sourceReferences: [],
      deltas: [],
    });
  }
  const runIds = result.outcome.nearestCandidates.map(({ runId }) => runId);
  return finishCard({
    id: "search:outcome",
    kind: "search-outcome",
    severity: "caution",
    title: "No eligible match",
    text: clip(
      `No candidate satisfied the ${matchRule.mode} matching rule. The nearest ineligible candidates are shown for context only; they are not eligible matches and the rule was not relaxed.`,
      comparisonPresentationLimits.cardText,
    ),
    fieldKeys: [],
    runIds,
    sourceReferences: [],
    deltas: [],
  });
}

function buildNearestCandidateCard(candidate: ComparatorCandidate): ComparisonLimitationCard {
  const keys = [
    ...candidate.mismatchedFieldKeys,
    ...candidate.unknownFieldKeys,
    ...candidate.incompatibleFieldKeys,
  ];
  return finishCard({
    id: `search:nearest:${candidate.runId}`,
    kind: "nearest-ineligible",
    severity: "caution",
    title: `Nearest ineligible candidate: ${candidate.runId}`,
    text: clip(
      candidate.limitations[0] ?? "This candidate did not satisfy every required condition match.",
      comparisonPresentationLimits.cardText,
    ),
    fieldKeys: keys,
    runIds: [...candidate.context.runIds],
    sourceReferences: fieldReferencesForKeys(candidate.context, keys),
    deltas: [],
    disposition: "nearest",
    contextRunIds: [...candidate.context.runIds],
  });
}

function buildEmptyScopeCard(result: ComparatorSearchResult): ComparisonLimitationCard {
  const limitation = result.limitations.find((text) => /^Empty candidate scope/i.test(text));
  return finishCard({
    id: "search:empty",
    kind: "empty-candidate-scope",
    severity: "caution",
    title: "No candidate runs in scope",
    text: clip(
      limitation ?? "No candidate runs were available after excluding the reference run. This is an empty search result, not an engine failure.",
      comparisonPresentationLimits.cardText,
    ),
    fieldKeys: [],
    runIds: [],
    sourceReferences: [],
    deltas: [],
  });
}

function buildCoverageCard(
  result: ComparatorSearchResult,
  coverage: ComparisonCandidateCoverage,
): ComparisonLimitationCard {
  const truncation = result.limitations.find((text) => (
    /^Only the first ten eligible matches/i.test(text)
    || /^Only the five nearest ineligible candidates/i.test(text)
  ));
  return finishCard({
    id: "search:coverage",
    kind: "candidate-coverage",
    severity: "caution",
    title: "Displayed candidate coverage",
    text: clip(
      `Displayed ${coverage.displayedCount} of ${coverage.evaluatedCount} evaluated candidates. ${truncation ?? "Candidates outside the displayed subset are not shown; their eligibility is not stated by this result."}`,
      comparisonPresentationLimits.cardText,
    ),
    fieldKeys: [],
    runIds: coverage.notDisplayedCandidateRunIds.slice(0, comparisonPresentationLimits.runIdsPerCard),
    sourceReferences: [],
    deltas: [],
  });
}

function buildCoverage(
  result: ComparatorSearchResult,
  displayedCandidateRunIds: readonly string[],
): ComparisonCandidateCoverage {
  const resolvedCandidateRunIds = [...result.resolvedCandidateRunIds];
  const displayed = new Set(displayedCandidateRunIds);
  const notDisplayedCandidateRunIds = resolvedCandidateRunIds.filter((runId) => !displayed.has(runId));
  return {
    scopeKind: result.candidateScope.kind,
    activeFilters: result.activeFilters.map(({ key, value }) => ({ key, value })),
    resolvedCandidateRunIds,
    evaluatedCount: result.evaluatedCount,
    displayedCandidateRunIds: [...displayedCandidateRunIds],
    displayedCount: displayedCandidateRunIds.length,
    notDisplayedCandidateRunIds,
    truncated: notDisplayedCandidateRunIds.length > 0,
    empty: resolvedCandidateRunIds.length === 0,
  };
}

function buildSelectedRunsPresentation(
  result: SelectedRunsContextResult,
): ComparisonAvailablePresentation {
  const context = buildContextPresentation(result, {
    role: "selected-runs",
    disposition: null,
    candidate: null,
    candidateLimitations: [],
  });
  return comparisonPresentationSchema.parse({
    kind: "comparison-presentation",
    presentationVersion: comparisonPresentationVersions.presentation,
    status: "available",
    resultKind: "selected-runs-context",
    datasetVersion: result.datasetVersion,
    comparisonRuleVersion: result.comparisonRuleVersion,
    contextRuleVersion: result.contextRuleVersion,
    request: result.request,
    roles: {
      mode: "selected-runs",
      referenceRunId: null,
      inspectedRunIds: [...result.runIds],
      focusCondition: result.request.focusCondition ?? null,
    },
    matching: null,
    requiredMatchFieldKeys: [],
    searchState: "not-applicable",
    coverage: null,
    globalCards: [],
    contexts: [context],
    limitations: [...result.limitations],
  });
}

function buildComparatorPresentation(
  result: ComparatorSearchResult,
): ComparisonAvailablePresentation {
  const matchRule = buildMatchRule(result.matching);
  const displayed = result.outcome.kind === "eligible-match"
    ? result.outcome.candidates
    : result.outcome.nearestCandidates;
  const contexts = displayed.map((candidate) => buildContextPresentation(candidate.context, {
    role: candidate.disposition === "eligible" ? "eligible-candidate" : "nearest-ineligible-candidate",
    disposition: candidate.disposition,
    candidate: candidateMetadata(candidate),
    candidateLimitations: [...candidate.limitations],
  }));
  const displayedCandidateRunIds = displayed.map(({ runId }) => runId);
  const coverage = buildCoverage(result, displayedCandidateRunIds);
  const searchState: ComparisonSearchState = result.outcome.kind === "eligible-match"
    ? "eligible"
    : coverage.empty
      ? "empty"
      : "no-eligible";
  const requiredMatchFieldKeys = conditionFieldKeys
    .filter((key) => key !== result.request.focusCondition);

  const globalCards: ComparisonLimitationCard[] = [buildMatchingRuleCard(matchRule)];
  if (result.outcome.kind === "eligible-match") {
    globalCards.push(buildSearchOutcomeCard(result, matchRule));
  } else if (coverage.empty) {
    globalCards.push(buildEmptyScopeCard(result));
  } else {
    globalCards.push(buildSearchOutcomeCard(result, matchRule));
    for (const candidate of result.outcome.nearestCandidates) {
      globalCards.push(buildNearestCandidateCard(candidate));
    }
  }
  if (coverage.truncated) globalCards.push(buildCoverageCard(result, coverage));

  return comparisonPresentationSchema.parse({
    kind: "comparison-presentation",
    presentationVersion: comparisonPresentationVersions.presentation,
    status: "available",
    resultKind: "comparator-search",
    datasetVersion: result.datasetVersion,
    comparisonRuleVersion: result.comparisonRuleVersion,
    contextRuleVersion: result.contextRuleVersion,
    request: result.request,
    roles: {
      mode: "comparator",
      referenceRunId: result.request.referenceRunId,
      inspectedRunIds: displayedCandidateRunIds,
      focusCondition: result.request.focusCondition,
    },
    matching: matchRule,
    requiredMatchFieldKeys,
    searchState,
    coverage,
    globalCards,
    contexts,
    limitations: [...result.limitations],
  });
}

/**
 * Derive the complete presentation for one validated selected-runs context or
 * comparator-search result. Throws `ComparisonPresentationError` for a
 * malformed result or a result that does not bind to the supplied dataset.
 */
export function buildComparisonPresentation(
  dataset: Dataset,
  result: ComparisonContextResult,
): ComparisonAvailablePresentation {
  const parsed = preparationForResult(dataset, result);
  return parsed.kind === "selected-runs-context"
    ? buildSelectedRunsPresentation(parsed)
    : buildComparatorPresentation(parsed);
}

/**
 * Flat limitation-card list for callers that render one list: global search
 * cards first, then each context's field/composition/causality cards in order.
 */
export function buildComparisonLimitationCards(
  dataset: Dataset,
  result: ComparisonContextResult,
): ComparisonLimitationCard[] {
  const presentation = buildComparisonPresentation(dataset, result);
  return [
    ...presentation.globalCards,
    ...presentation.contexts.flatMap(({ cards }) => cards),
  ];
}

/**
 * Build the explicit unsigned structured JSON payload. The presentation is
 * validated again by `comparisonExportPayloadSchema`; a malformed or
 * mismatched result is rejected before this function returns.
 */
export function buildComparisonExportPayload(
  dataset: Dataset,
  result: ComparisonContextResult,
): ComparisonExportPayload {
  const presentation = buildComparisonPresentation(dataset, result);
  return comparisonExportPayloadSchema.parse({
    format: "fire-evidence-comparison-export",
    formatVersion: comparisonPresentationVersions.export,
    authority: "deterministic-comparison",
    verification: "not-verified",
    signed: false,
    signatureNote: comparisonExportSignatureNote,
    datasetVersion: presentation.datasetVersion,
    comparisonRuleVersion: presentation.comparisonRuleVersion,
    contextRuleVersion: presentation.contextRuleVersion,
    resultKind: presentation.resultKind,
    request: presentation.request,
    presentation,
  });
}

/** Serialize a validated comparison export payload as structured, indented JSON. */
export function comparisonExportJson(payload: ComparisonExportPayload): string {
  return `${JSON.stringify(comparisonExportPayloadSchema.parse(payload), null, 2)}\n`;
}

export type ComparisonUnavailableInput = {
  code: z.infer<typeof actionUnavailableCodeSchema>;
  message?: string;
};

const unavailableDefaultMessage =
  "The comparison result is unavailable. No comparison evidence, eligibility or limitation data is presented.";

/**
 * Explicit unavailable presentation for U06. It contains no context, coverage,
 * source references or export payload, so an unavailable engine state can never
 * be mistaken for an empty or failed search.
 */
export function buildComparisonUnavailablePresentation(
  input: ComparisonUnavailableInput,
): ComparisonUnavailablePresentation {
  const message = clip(input.message?.trim() ? input.message : unavailableDefaultMessage, comparisonPresentationLimits.cardText);
  const card = finishCard({
    id: `unavailable:${input.code}`,
    kind: "unavailable",
    severity: "caution",
    title: "Comparison result unavailable",
    text: message,
    fieldKeys: [],
    runIds: [],
    sourceReferences: [],
    deltas: [],
    reasonCode: input.code,
  });
  return comparisonUnavailablePresentationSchema.parse({
    kind: "comparison-presentation",
    presentationVersion: comparisonPresentationVersions.presentation,
    status: "unavailable",
    code: input.code,
    message,
    cards: [card],
  });
}
