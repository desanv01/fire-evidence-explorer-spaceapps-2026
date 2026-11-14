import {
  assistantActionCatalog,
  requiresUserApproval,
  type ActionFailure,
  type ActionKind,
  type AssistantActionContext,
  type AssistantActionEffect,
  type AssistantActionOutcome,
  type AssistantActionRecord,
  type AssistantActionRequest,
} from "./actions.ts";
import type {
  ComparatorCandidate,
  ComparatorSearchResult,
  ContextEvidence,
  MatchingPolicy,
  SelectedRunsContextResult,
} from "./comparison-context.ts";
import { fieldDefinitionByKey, isFieldKey, type FieldKey } from "./field-catalog.ts";
import type { EvidenceAnswerNotebookStep, NotebookStep } from "./notebook.ts";
import type { PlotResult, PlotSpec } from "./plot.ts";
import { stableFieldReferenceKey, type StableFieldReference } from "./provenance.ts";

/**
 * U06.4 typed action-card data.
 *
 * Cards are a presentation projection of the canonical `AssistantActionRecord`
 * and `AssistantActionOutcome` contracts. They do not add a second action
 * lifecycle or outcome schema and they never call a provider: building or
 * opening a card is a pure, local operation.
 */

export type AssistantActionCardPhase = AssistantActionRecord["status"];

export type AssistantActionCardState =
  | { readonly phase: "proposed" }
  | { readonly phase: "approved"; readonly approvedAt: string }
  | { readonly phase: "executed"; readonly executedAt: string; readonly outcome: AssistantActionOutcome }
  | { readonly phase: "failed"; readonly failedAt: string; readonly error: ActionFailure }
  | { readonly phase: "cancelled"; readonly cancelledAt: string; readonly reason: string | null };

export type AssistantActionCardEvidence = {
  readonly text: string;
  readonly category: ContextEvidence["category"] | null;
  readonly status: "reported" | "derived" | "unknown" | null;
  readonly numbers: readonly { readonly label: string; readonly value: number; readonly unit: string }[];
  readonly fieldKeys: readonly string[];
  readonly sourceReferences: readonly StableFieldReference[];
  /** Candidate attribution for comparator evidence; null for a shared context. */
  readonly runId: string | null;
  readonly ruleVersion: string | null;
};

export type AssistantPlotCardContent = {
  readonly kind: "plot";
  /** True only for the valid zero-row scope; all-omitted non-empty scopes are not empty. */
  readonly empty: boolean;
  readonly result: PlotResult;
  readonly pointCount: number;
  readonly omittedCount: number;
  readonly sourceReferences: readonly StableFieldReference[];
  readonly limitations: readonly string[];
};

export type AssistantComparisonCardContent = {
  readonly kind: "comparison-context";
  readonly result: SelectedRunsContextResult;
  readonly evidence: readonly AssistantActionCardEvidence[];
  readonly sourceReferences: readonly StableFieldReference[];
  readonly limitations: readonly string[];
};

export type AssistantComparatorCardContent = {
  readonly kind: "comparator-search";
  readonly result: ComparatorSearchResult;
  readonly matching: MatchingPolicy;
  readonly candidates: readonly {
    readonly runId: string;
    readonly disposition: ComparatorCandidate["disposition"];
    readonly mismatchedFieldKeys: readonly string[];
    readonly unknownFieldKeys: readonly string[];
    readonly incompatibleFieldKeys: readonly string[];
    readonly limitations: readonly string[];
    readonly sourceReferences: readonly StableFieldReference[];
  }[];
  readonly evidence: readonly AssistantActionCardEvidence[];
  readonly sourceReferences: readonly StableFieldReference[];
  readonly limitations: readonly string[];
};

export type AssistantNotebookCardContent = {
  readonly kind: "notebook-step";
  readonly step: NotebookStep;
  readonly evidence: readonly AssistantActionCardEvidence[];
  readonly sourceReferences: readonly StableFieldReference[];
  readonly limitations: readonly string[];
};

export type AssistantActionCardContent =
  | AssistantPlotCardContent
  | AssistantComparisonCardContent
  | AssistantComparatorCardContent
  | AssistantNotebookCardContent;

export type AssistantActionCardRequestPayload =
  | { readonly kind: "create_plot"; readonly plot: PlotSpec }
  | { readonly kind: "explain_comparison_context"; readonly request: Extract<AssistantActionRequest, { kind: "explain_comparison_context" }>["request"] }
  | { readonly kind: "find_comparators"; readonly request: Extract<AssistantActionRequest, { kind: "find_comparators" }>["request"] }
  | { readonly kind: "prepare_notebook_step"; readonly step: NotebookStep };

export type AssistantActionCard = {
  readonly actionId: string;
  readonly kind: ActionKind;
  readonly effect: AssistantActionEffect;
  readonly requiresUserApproval: boolean;
  readonly request: AssistantActionRequest;
  readonly context: AssistantActionContext;
  readonly payload: AssistantActionCardRequestPayload;
  /** Canonical action record; its status is the card phase. */
  readonly record: AssistantActionRecord;
  readonly phase: AssistantActionCardPhase;
  readonly state: AssistantActionCardState;
  /** Executed outcome, or a transient attempt outcome supplied by the lifecycle. */
  readonly outcome: AssistantActionOutcome | null;
  readonly title: string;
  readonly summary: string;
  readonly notice: string | null;
  readonly content: AssistantActionCardContent | null;
  readonly evidence: readonly AssistantActionCardEvidence[];
  readonly limitations: readonly string[];
  readonly sourceReferences: readonly StableFieldReference[];
  readonly empty: boolean | null;
  readonly error: ActionFailure | null;
  readonly canApprove: boolean;
  readonly canExecute: boolean;
  readonly canCancel: boolean;
};

export type BuildAssistantActionCardOptions = {
  /**
   * A transient attempt outcome for rejected confirmation (for example a
   * missing approval). The canonical record is not changed by this option.
   */
  readonly attemptOutcome?: AssistantActionOutcome;
  readonly notice?: string;
};

/**
 * Project one canonical action record into an immutable card. This is pure and
 * performs zero provider calls.
 */
export function buildAssistantActionCard(
  record: AssistantActionRecord,
  options: BuildAssistantActionCardOptions = {},
): AssistantActionCard {
  const state = cardState(record);
  const outcome = record.status === "executed" ? record.outcome : options.attemptOutcome ?? null;
  const content = contentFor(record.request, outcome);
  const evidence = content ? contentEvidence(content) : [];
  const limitations = content ? content.limitations : [];
  const sourceReferences = content ? content.sourceReferences : [];
  const kind = record.request.kind;
  const requiresApproval = requiresUserApproval(kind);
  return {
    actionId: record.request.actionId,
    kind,
    effect: record.effect,
    requiresUserApproval: requiresApproval,
    request: record.request,
    context: record.request.context,
    payload: requestPayload(record.request),
    record,
    phase: record.status,
    state,
    outcome,
    title: actionCardTitle(kind),
    summary: actionCardSummary(record.request, content),
    notice: options.notice ?? actionCardNotice(record, outcome),
    content,
    evidence,
    limitations,
    sourceReferences,
    empty: content?.kind === "plot" ? content.empty : null,
    error: record.status === "failed" ? record.error : null,
    canApprove: record.status === "proposed" && requiresApproval,
    canExecute: (record.status === "proposed" && !requiresApproval) || record.status === "approved",
    canCancel: record.status === "proposed" || record.status === "approved",
  };
}

export function actionCardTitle(kind: ActionKind): string {
  switch (kind) {
    case "create_plot":
      return "Plot";
    case "explain_comparison_context":
      return "Comparison context";
    case "find_comparators":
      return "Comparator search";
    case "prepare_notebook_step":
      return "Notebook step";
  }
}

export function actionCardSummary(
  request: AssistantActionRequest,
  content: AssistantActionCardContent | null,
): string {
  switch (request.kind) {
    case "create_plot":
      return plotSummary(request.plot, content?.kind === "plot" ? content : null);
    case "explain_comparison_context":
      return comparisonSummary(request.request.runIds, content?.kind === "comparison-context" ? content : null);
    case "find_comparators": {
      const comparator = content?.kind === "comparator-search" ? content : null;
      const rule = request.request.matching?.mode === "tolerance"
        ? `Tolerance matching on ${request.request.matching.tolerances.length} field${request.request.matching.tolerances.length === 1 ? "" : "s"}`
        : "Exact matching";
      if (!comparator) {
        return `${rule} · reference ${request.request.referenceRunId} · focus ${fieldLabel(request.request.focusCondition)}`;
      }
      const candidates = comparator.result.outcome.kind === "eligible-match"
        ? `${comparator.result.outcome.candidates.length} eligible`
        : `${comparator.result.outcome.nearestCandidates.length} nearest (no eligible match)`;
      return `${rule} · ${comparator.result.evaluatedCount} evaluated · ${candidates}`;
    }
    case "prepare_notebook_step":
      return `${notebookStepLabel(request.step)} · ${request.step.title}`;
  }
}

export function actionCardNotice(
  record: AssistantActionRecord,
  outcome: AssistantActionOutcome | null,
): string | null {
  if (record.status === "failed") return record.error.message;
  if (record.status === "cancelled") return record.reason ?? "The action was cancelled.";
  if (record.status === "proposed") {
    return requiresUserApproval(record.request.kind)
      ? "Review this state-changing action before it can run."
      : "Ready to run. This action makes no AI request.";
  }
  if (record.status === "approved") return "Approved. Ready to run.";
  if (!outcome) return null;
  switch (outcome.kind) {
    case "unavailable":
      return outcome.message ?? "This action is currently unavailable. The manual tools remain available.";
    case "invalid":
      return `This action was not applied. ${outcome.issues[0]?.message ?? "The request is invalid."}`;
    case "stale-context":
      return "This action no longer matches the current workspace, turn, corpus or selection, so it was not applied.";
    default:
      return null;
  }
}

function cardState(record: AssistantActionRecord): AssistantActionCardState {
  switch (record.status) {
    case "proposed":
      return { phase: "proposed" };
    case "approved":
      return { phase: "approved", approvedAt: record.approvedAt };
    case "executed":
      return { phase: "executed", executedAt: record.executedAt, outcome: record.outcome };
    case "failed":
      return { phase: "failed", failedAt: record.failedAt, error: record.error };
    case "cancelled":
      return { phase: "cancelled", cancelledAt: record.cancelledAt, reason: record.reason ?? null };
  }
}

function requestPayload(request: AssistantActionRequest): AssistantActionCardRequestPayload {
  switch (request.kind) {
    case "create_plot":
      return { kind: "create_plot", plot: request.plot };
    case "explain_comparison_context":
      return { kind: "explain_comparison_context", request: request.request };
    case "find_comparators":
      return { kind: "find_comparators", request: request.request };
    case "prepare_notebook_step":
      return { kind: "prepare_notebook_step", step: request.step };
  }
}

function contentFor(
  request: AssistantActionRequest,
  outcome: AssistantActionOutcome | null,
): AssistantActionCardContent | null {
  if (!outcome) return null;
  switch (request.kind) {
    case "create_plot":
      return outcome.kind === "plot-result" ? plotContent(outcome.result) : null;
    case "explain_comparison_context":
      return outcome.kind === "comparison-context" ? comparisonContent(outcome.result) : null;
    case "find_comparators":
      return outcome.kind === "comparator-search" ? comparatorContent(outcome.result) : null;
    case "prepare_notebook_step":
      return outcome.kind === "notebook-step" ? notebookContent(outcome.step) : null;
  }
}

function contentEvidence(content: AssistantActionCardContent): readonly AssistantActionCardEvidence[] {
  return "evidence" in content ? content.evidence : [];
}

function plotContent(result: PlotResult): AssistantPlotCardContent {
  return {
    kind: "plot",
    empty: result.resolvedRunIds.length === 0,
    result,
    pointCount: result.points.length,
    omittedCount: result.omitted.length,
    sourceReferences: uniqueReferences(result.points.flatMap(({ sourceReferences }) => sourceReferences)),
    limitations: [...result.limitations],
  };
}

function comparisonContent(result: SelectedRunsContextResult): AssistantComparisonCardContent {
  return {
    kind: "comparison-context",
    result,
    evidence: result.evidence.map((evidence) => contextEvidence(evidence, null)),
    sourceReferences: uniqueReferences([
      ...result.conditions.flatMap(({ cells }) => cells.flatMap(({ reference }) => reference ? [reference] : [])),
      ...result.outcomes.flatMap(({ cells }) => cells.flatMap(({ reference }) => reference ? [reference] : [])),
      ...result.evidence.flatMap(({ sourceReferences }) => sourceReferences),
    ]),
    limitations: [...result.limitations],
  };
}

function comparatorContent(result: ComparatorSearchResult): AssistantComparatorCardContent {
  const candidates = result.outcome.kind === "eligible-match"
    ? result.outcome.candidates
    : result.outcome.nearestCandidates;
  const evidence = candidates.flatMap((candidate) => (
    comparisonContent(candidate.context).evidence.map((item) => ({ ...item, runId: candidate.runId }))
  ));
  return {
    kind: "comparator-search",
    result,
    matching: result.matching,
    candidates: candidates.map((candidate) => ({
      runId: candidate.runId,
      disposition: candidate.disposition,
      mismatchedFieldKeys: [...candidate.mismatchedFieldKeys],
      unknownFieldKeys: [...candidate.unknownFieldKeys],
      incompatibleFieldKeys: [...candidate.incompatibleFieldKeys],
      limitations: [...candidate.limitations],
      sourceReferences: comparisonContent(candidate.context).sourceReferences,
    })),
    evidence,
    sourceReferences: uniqueReferences(candidates.flatMap((candidate) => (
      comparisonContent(candidate.context).sourceReferences
    ))),
    limitations: uniqueStrings([
      ...result.limitations,
      ...candidates.flatMap(({ limitations }) => limitations),
    ]),
  };
}

function notebookContent(step: NotebookStep): AssistantNotebookCardContent {
  const evidence = step.stepType === "comparison"
    ? step.context.evidence.map((item) => contextEvidence(item, null))
    : step.stepType === "evidence-answer"
      ? answerEvidence(step)
      : [];
  return {
    kind: "notebook-step",
    step,
    evidence,
    sourceReferences: uniqueReferences([
      ...step.sourceReferences,
      ...evidence.flatMap(({ sourceReferences }) => sourceReferences),
    ]),
    limitations: [...step.limitations],
  };
}

function answerEvidence(step: EvidenceAnswerNotebookStep): AssistantActionCardEvidence[] {
  return step.answer.packet.evidence.map((item) => {
    const citation = step.answer.citations[item.id];
    return {
      text: item.text,
      category: null,
      status: item.status,
      numbers: (item.numbers ?? []).map(({ label, value, unit }) => ({ label, value, unit })),
      fieldKeys: citation ? [citation.fieldKey] : [],
      sourceReferences: citation
        ? citation.sources.map(({ runId, sourceId }) => ({
          datasetVersion: step.answer.datasetVersion,
          runId,
          fieldKey: citation.fieldKey,
          sourceId,
        }))
        : [],
      runId: null,
      ruleVersion: null,
    };
  });
}

function contextEvidence(evidence: ContextEvidence, runId: string | null): AssistantActionCardEvidence {
  return {
    text: evidence.text,
    category: evidence.category,
    status: null,
    numbers: [],
    fieldKeys: [...evidence.fieldKeys],
    sourceReferences: [...evidence.sourceReferences],
    runId,
    ruleVersion: evidence.ruleVersion ?? null,
  };
}

function plotSummary(spec: PlotSpec, content: AssistantPlotCardContent | null): string {
  const axes = spec.kind === "scatter"
    ? `${fieldLabel(spec.axes.x.field)} vs ${fieldLabel(spec.axes.y.field)}`
    : fieldLabel(spec.axes.y.field);
  if (!content) {
    return `${axes} · ${scopeLabel(spec.scope)}`;
  }
  if (content.empty) return `${axes} · no runs matched the requested scope`;
  if (content.pointCount === 0) {
    return `${axes} · no plotted points · ${content.omittedCount} omitted`;
  }
  return `${axes} · ${content.pointCount} plotted${content.omittedCount ? ` · ${content.omittedCount} omitted` : ""}`;
}

function comparisonSummary(
  runIds: readonly string[],
  content: AssistantComparisonCardContent | null,
): string {
  if (!content) return runIds.join(" vs ");
  return `${content.result.runIds.join(" vs ")} · ${content.result.conditions.length} conditions · ${content.result.outcomes.length} outcomes`;
}

function scopeLabel(scope: PlotSpec["scope"]): string {
  switch (scope.kind) {
    case "all-reviewed-runs":
      return "all reviewed runs";
    case "filtered-results":
      return "filtered results";
    case "explicit-runs":
      return `${scope.runIds.length} selected run${scope.runIds.length === 1 ? "" : "s"}`;
  }
}

function notebookStepLabel(step: NotebookStep): string {
  switch (step.stepType) {
    case "plot":
      return "Plot step";
    case "comparison":
      return "Comparison step";
    case "evidence-answer":
      return "Validated answer step (trusted snapshot review)";
  }
}

function fieldLabel(key: string): string {
  return isFieldKey(key) ? fieldDefinitionByKey[key as FieldKey].label : key;
}

function uniqueReferences(references: readonly StableFieldReference[]): StableFieldReference[] {
  const unique = new Map<string, StableFieldReference>();
  for (const reference of references) unique.set(stableFieldReferenceKey(reference), reference);
  return [...unique.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The closed catalog remains the single authority for action effects. */
export const assistantActionCardEffects = {
  create_plot: assistantActionCatalog.create_plot.effect,
  explain_comparison_context: assistantActionCatalog.explain_comparison_context.effect,
  find_comparators: assistantActionCatalog.find_comparators.effect,
  prepare_notebook_step: assistantActionCatalog.prepare_notebook_step.effect,
} as const satisfies Record<ActionKind, AssistantActionEffect>;
