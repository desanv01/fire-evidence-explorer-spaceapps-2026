import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import {
  actionUnavailableCodeSchema,
  actionIssueSummarySchema,
  assistantActionCatalog,
  assistantActionContextSchema,
  assistantActionOutcomeSchema,
  assistantActionRequestSchema,
  checkActionContext,
  requiresUserApproval,
  validateActionAgainstDataset,
  validateNotebookStepAgainstDataset,
  type ActionContextCheck,
  type ActionInvalidCode,
  type ActionKind,
  type AssistantActionContext,
  type AssistantActionOutcome,
  type AssistantActionRequest,
} from "./actions.ts";
import {
  comparatorSearchResultSchema,
  effectiveMatchingPolicy,
  selectedRunsContextResultSchema,
  type ComparatorRequest,
  type ComparatorSearchResult,
  type MatchingPolicy,
  type SelectedRunsContextRequest,
  type SelectedRunsContextResult,
} from "./comparison-context.ts";
import {
  evidenceAnswerSnapshotSchema,
  notebookStepSchema,
  type EvidenceAnswerNotebookStep,
  type EvidenceAnswerSnapshot,
  type NotebookStep,
} from "./notebook.ts";
import {
  plotResultSchema,
  validatePlotResultAgainstDataset,
  type PlotResult,
  type PlotSpec,
} from "./plot.ts";
import { resolveRunScope, type RunScope } from "./scope.ts";
import {
  resolveStableFieldReference,
  type CorpusValidationIssue,
  type StableFieldReference,
} from "./provenance.ts";
import type { FieldKey } from "./field-catalog.ts";
import type { RunSearchRequest } from "../evidence.ts";

/**
 * U06-A action registry and dispatcher.
 *
 * This module is deliberately browser-safe and deterministic:
 * - It never evaluates model text, fetches a provider, accepts a URL/command,
 *   reads a signing key or verifies a receipt signature.
 * - It parses untrusted action input with the frozen U01 union before looking
 *   up one of four statically typed handlers. There is no dynamic tool lookup
 *   from user/provider text.
 * - The caller supplies the authoritative dataset, the trusted active context
 *   and (for notebook mutations) a trusted local approval. The real plot,
 *   comparison and notebook engines are injected by U06-B after delivery.
 */

const maxActionIssues = 20;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const timestampSchema = z.iso.datetime({ offset: true });

/** Success outcomes are fixed per allowlisted operation; never chosen by the caller. */
export const assistantActionSuccessOutcome = {
  create_plot: "plot-result",
  explain_comparison_context: "comparison-context",
  find_comparators: "comparator-search",
  prepare_notebook_step: "notebook-step",
} as const satisfies Record<ActionKind, AssistantActionOutcome["kind"]>;

export type AssistantActionSuccessOutcomeKind = (typeof assistantActionSuccessOutcome)[ActionKind];

/** Closed, readonly metadata for the four allowlisted operations. */
export const assistantActionRegistry = Object.freeze({
  create_plot: Object.freeze({
    effect: assistantActionCatalog.create_plot.effect,
    requiresUserApproval: assistantActionCatalog.create_plot.requiresUserApproval,
    successOutcome: assistantActionSuccessOutcome.create_plot,
  }),
  explain_comparison_context: Object.freeze({
    effect: assistantActionCatalog.explain_comparison_context.effect,
    requiresUserApproval: assistantActionCatalog.explain_comparison_context.requiresUserApproval,
    successOutcome: assistantActionSuccessOutcome.explain_comparison_context,
  }),
  find_comparators: Object.freeze({
    effect: assistantActionCatalog.find_comparators.effect,
    requiresUserApproval: assistantActionCatalog.find_comparators.requiresUserApproval,
    successOutcome: assistantActionSuccessOutcome.find_comparators,
  }),
  prepare_notebook_step: Object.freeze({
    effect: assistantActionCatalog.prepare_notebook_step.effect,
    requiresUserApproval: assistantActionCatalog.prepare_notebook_step.requiresUserApproval,
    successOutcome: assistantActionSuccessOutcome.prepare_notebook_step,
  }),
} satisfies Record<ActionKind, {
  effect: "read-only" | "state-changing";
  requiresUserApproval: boolean;
  successOutcome: AssistantActionOutcome["kind"];
}>);

export const assistantActionKinds: readonly ActionKind[] = Object.freeze([
  "create_plot",
  "explain_comparison_context",
  "find_comparators",
  "prepare_notebook_step",
]);

/* ------------------------------------------------------------------------- */
/* Injected engines                                                          */
/* ------------------------------------------------------------------------- */

export type AssistantActionHandlerResultMap = {
  create_plot: PlotResult;
  explain_comparison_context: SelectedRunsContextResult;
  find_comparators: ComparatorSearchResult;
  prepare_notebook_step: NotebookStep;
};

export type AssistantActionHandlerInput<K extends ActionKind> = {
  /** The exact parsed manual-operation payload; no provider text is re-parsed here. */
  request: Extract<AssistantActionRequest, { kind: K }>;
  /** Authoritative corpus snapshot for this dispatch. */
  dataset: Dataset;
  /** Reserved for U06-B cancellation; this phase does not start provider work. */
  signal?: AbortSignal;
};

export type AssistantActionHandler<K extends ActionKind> = (
  input: AssistantActionHandlerInput<K>,
) => AssistantActionHandlerResultMap[K] | Promise<AssistantActionHandlerResultMap[K]>;

/**
 * Explicitly typed handler set. Each engine is optional so a not-yet-delivered
 * engine produces a structured `unavailable` outcome instead of a crash.
 */
export type AssistantActionHandlers = {
  readonly [K in ActionKind]?: AssistantActionHandler<K>;
};

export type AssistantActionUnavailableCode = z.infer<typeof actionUnavailableCodeSchema>;

/** A handler can signal a typed availability failure without throwing prose. */
export class AssistantActionUnavailableError extends Error {
  readonly code: AssistantActionUnavailableCode;

  constructor(code: AssistantActionUnavailableCode, message = "The action handler is unavailable.") {
    super(message);
    this.name = "AssistantActionUnavailableError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- */
/* Trusted local approval                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Approval is a local confirmation of one exact request and its bound context.
 * The schema documents the shape; the non-serializable brand below is what the
 * dispatcher actually accepts, so JSON copied from model text cannot pose as a
 * local approval.
 */
export const assistantActionApprovalSchema = z.strictObject({
  actionId: identifierSchema,
  request: assistantActionRequestSchema,
  approvedAt: timestampSchema,
  approvalSource: z.literal("local-user-confirmation"),
});
export type AssistantActionApproval = z.infer<typeof assistantActionApprovalSchema>;

const localApprovalBrand: unique symbol = Symbol("fire-evidence-local-action-approval");

export type LocalAssistantActionApproval = AssistantActionApproval & {
  readonly [localApprovalBrand]: true;
};

/**
 * Create an in-memory approval object from a local user confirmation. The
 * symbol brand is intentionally not serializable; a provider-supplied object
 * shaped like an approval must not pass the dispatcher's gate.
 */
export function createLocalAssistantActionApproval(
  request: AssistantActionRequest,
  approvedAt: string = new Date().toISOString(),
): LocalAssistantActionApproval {
  const parsedRequest = assistantActionRequestSchema.parse(request);
  const approval = assistantActionApprovalSchema.parse({
    actionId: parsedRequest.actionId,
    request: parsedRequest,
    approvedAt,
    approvalSource: "local-user-confirmation",
  });
  return Object.freeze({
    ...approval,
    [localApprovalBrand]: true as const,
  }) as LocalAssistantActionApproval;
}

export function isLocalAssistantActionApproval(value: unknown): value is LocalAssistantActionApproval {
  return typeof value === "object" && value !== null
    && (value as { [localApprovalBrand]?: unknown })[localApprovalBrand] === true;
}

export type AssistantActionApprovalCheck =
  | { readonly ok: true; readonly approval: LocalAssistantActionApproval | null }
  | { readonly ok: false; readonly code: ActionInvalidCode; readonly issues: z.infer<typeof actionIssueSummarySchema>[] };

/**
 * A read-only action needs no approval. A state-changing action needs a
 * trusted local approval for this exact action id, request payload and bound
 * context.
 */
export function checkAssistantActionApproval(
  approval: unknown,
  request: AssistantActionRequest,
  activeContext: AssistantActionContext,
): AssistantActionApprovalCheck {
  if (!requiresUserApproval(request.kind)) return { ok: true, approval: null };

  if (!isLocalAssistantActionApproval(approval)) {
    return {
      ok: false,
      code: "invalid-action",
      issues: [actionIssue(
        "approval",
        "This state-changing action requires an explicit local user approval for the exact request and context.",
      )],
    };
  }
  const parsed = assistantActionApprovalSchema.safeParse(approval);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid-action",
      issues: [actionIssue("approval", "The local approval object is malformed.")],
    };
  }
  const approved = parsed.data;
  if (approved.actionId !== request.actionId || !sameAssistantActionRequest(approved.request, request)) {
    return {
      ok: false,
      code: "invalid-action",
      issues: [actionIssue(
        "approval",
        "The local approval does not match this action request and bound context.",
      )],
    };
  }
  const approvalContext = checkAssistantActionContext(approved.request.context, activeContext);
  if (approvalContext.status === "stale") {
    return {
      ok: false,
      code: "invalid-action",
      issues: [actionIssue(
        "approval",
        "The local approval was bound to an earlier turn, corpus or selection.",
      )],
    };
  }
  return { ok: true, approval: approval as LocalAssistantActionApproval };
}

/* ------------------------------------------------------------------------- */
/* Trusted answer snapshot                                                   */
/* ------------------------------------------------------------------------- */

/**
 * An evidence-answer notebook step is accepted only when it is byte-for-byte
 * equal (JSON semantics) to a trusted snapshot produced from the existing
 * validated answer flow. A receipt-shaped string by itself is never evidence:
 * `receiptVerification` stays `not-verified`, and no signing or signature
 * verification is added here.
 */
export type TrustedAnswerSnapshotCheck =
  | { readonly ok: true; readonly snapshot: EvidenceAnswerSnapshot }
  | { readonly ok: false; readonly issues: z.infer<typeof actionIssueSummarySchema>[] };

export function checkTrustedAnswerSnapshot(
  step: EvidenceAnswerNotebookStep,
  trustedAnswerSnapshot: unknown,
  activeDatasetSha256?: string | null,
): TrustedAnswerSnapshotCheck {
  const parsed = evidenceAnswerSnapshotSchema.safeParse(trustedAnswerSnapshot);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [actionIssue(
        "trustedAnswerSnapshot",
        "A trusted current validated-answer snapshot is required for an evidence-answer notebook step.",
      )],
    };
  }
  const issues: z.infer<typeof actionIssueSummarySchema>[] = [];
  if (canonicalJson(parsed.data) !== canonicalJson(step.answer)) {
    issues.push(actionIssue(
      "trustedAnswerSnapshot",
      "The notebook answer does not match the trusted current validated-answer snapshot.",
    ));
  }
  if (activeDatasetSha256 !== undefined && activeDatasetSha256 !== null
    && step.answer.datasetSha256 !== activeDatasetSha256) {
    issues.push(actionIssue(
      "trustedAnswerSnapshot.datasetSha256",
      "The trusted answer snapshot is not bound to the active dataset hash.",
    ));
  }
  return issues.length ? { ok: false, issues } : { ok: true, snapshot: parsed.data };
}

/* ------------------------------------------------------------------------- */
/* Context binding helpers                                                   */
/* ------------------------------------------------------------------------- */

/** Build a context only from trusted caller state; never from model output. */
export function createAssistantActionContext(input: {
  workspaceId: string;
  turnId: string;
  datasetVersion: string;
  selectedRunIds: readonly string[];
  selectionRevision: number;
}): AssistantActionContext {
  return assistantActionContextSchema.parse({
    workspaceId: input.workspaceId,
    turnId: input.turnId,
    datasetVersion: input.datasetVersion,
    selectedRunIds: [...input.selectedRunIds],
    selectionRevision: input.selectionRevision,
  });
}

/** Compare a proposed context with the authoritative context immediately before dispatch. */
export function checkAssistantActionContext(
  requestContext: AssistantActionContext,
  activeContext: AssistantActionContext,
): ActionContextCheck {
  return checkActionContext(requestContext, activeContext);
}

/** True when the two contexts bind the same workspace, turn, corpus and ordered selection. */
export function sameAssistantActionContext(left: AssistantActionContext, right: AssistantActionContext): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** True when two parsed requests have the same payload and bound context. */
export function sameAssistantActionRequest(left: AssistantActionRequest, right: AssistantActionRequest): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/* ------------------------------------------------------------------------- */
/* Parsing and corpus validation                                             */
/* ------------------------------------------------------------------------- */

export type AssistantActionParseResult =
  | { readonly ok: true; readonly request: AssistantActionRequest }
  | { readonly ok: false; readonly outcome: Extract<AssistantActionOutcome, { kind: "invalid" }> };

/**
 * Parse untrusted action JSON into the frozen allowlisted union. Unknown
 * operation names, unknown fields and invalid selector shapes fail here, before
 * any handler lookup.
 */
export function parseAssistantActionRequest(input: unknown): AssistantActionParseResult {
  const parsed = assistantActionRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, outcome: invalidOutcome("invalid-action", zodIssues(parsed.error, "action")) };
}

/**
 * Corpus-aware request validation wrapper. Uses the supplied U01 validator and
 * reports membership/reference problems as typed invalid outcomes.
 */
export function validateAssistantActionRequestAgainstDataset(
  dataset: Dataset,
  request: AssistantActionRequest,
): CorpusValidationIssue[] {
  return validateActionAgainstDataset(dataset, request);
}

/* ------------------------------------------------------------------------- */
/* Handler result validation                                                 */
/* ------------------------------------------------------------------------- */

export type AssistantActionResultValidationInput = {
  request: AssistantActionRequest;
  dataset: Dataset;
  result: unknown;
  /** Required for an evidence-answer notebook step. */
  trustedAnswerSnapshot?: unknown;
  /** Optional hash binding for a trusted evidence-answer snapshot. */
  activeDatasetSha256?: string | null;
};

/**
 * Validate a handler result before it is returned: schema shape, corpus
 * membership, stable source references and binding to the proposed manual
 * payload. This is pure and does not verify notebook receipt signatures.
 */
export function validateAssistantActionResult(
  input: AssistantActionResultValidationInput,
): AssistantActionOutcome {
  const { request, dataset, result } = input;
  switch (request.kind) {
    case "create_plot": {
      const parsed = plotResultSchema.safeParse(result);
      if (!parsed.success) return invalidOutcome("invalid-plot", zodIssues(parsed.error, "result"));
      const issues = [
        ...corpusIssuesToActionIssues(validatePlotResultAgainstDataset(dataset, parsed.data, "result")),
        ...plotResultBindingIssues(dataset, request.plot, parsed.data, "result"),
      ];
      return issues.length
        ? invalidOutcome("invalid-plot", issues)
        : assistantActionOutcomeSchema.parse({ kind: "plot-result", result: parsed.data }) as AssistantActionOutcome;
    }
    case "explain_comparison_context": {
      const parsed = selectedRunsContextResultSchema.safeParse(result);
      if (!parsed.success) return invalidOutcome("invalid-context", zodIssues(parsed.error, "result"));
      const issues = comparisonResultBindingIssues(dataset, request.request, parsed.data, "result");
      return issues.length
        ? invalidOutcome("invalid-context", issues)
        : assistantActionOutcomeSchema.parse({ kind: "comparison-context", result: parsed.data }) as AssistantActionOutcome;
    }
    case "find_comparators": {
      const parsed = comparatorSearchResultSchema.safeParse(result);
      if (!parsed.success) return invalidOutcome("invalid-context", zodIssues(parsed.error, "result"));
      const issues = comparatorResultBindingIssues(dataset, request.request, parsed.data, "result");
      return issues.length
        ? invalidOutcome("invalid-context", issues)
        : assistantActionOutcomeSchema.parse({ kind: "comparator-search", result: parsed.data }) as AssistantActionOutcome;
    }
    case "prepare_notebook_step": {
      const parsed = notebookStepSchema.safeParse(result);
      if (!parsed.success) return invalidOutcome("invalid-context", zodIssues(parsed.error, "result"));
      const issues: z.infer<typeof actionIssueSummarySchema>[] = [];
      if (canonicalJson(parsed.data) !== canonicalJson(request.step)) {
        issues.push(actionIssue(
          "result",
          "The prepared notebook step differs from the proposed immutable step payload.",
        ));
      }
      issues.push(...corpusIssuesToActionIssues(validateNotebookStepAgainstDataset(dataset, parsed.data, "result")));
      issues.push(...notebookStepBindingIssues(dataset, parsed.data, "result"));
      if (parsed.data.stepType === "evidence-answer") {
        const trusted = checkTrustedAnswerSnapshot(
          parsed.data,
          input.trustedAnswerSnapshot,
          input.activeDatasetSha256,
        );
        if (!trusted.ok) issues.push(...trusted.issues);
      }
      return issues.length
        ? invalidOutcome("invalid-context", issues)
        : assistantActionOutcomeSchema.parse({ kind: "notebook-step", step: parsed.data }) as AssistantActionOutcome;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Dispatcher                                                                */
/* ------------------------------------------------------------------------- */

export type AssistantActionDispatchInput = {
  /** Untrusted action JSON (model/provider/user). Parsed and allowlisted here. */
  action: unknown;
  /** Authoritative corpus, or null when the corpus is unavailable. */
  dataset: Dataset | null;
  /** Trusted active workspace/turn/corpus/ordered-selection context. */
  activeContext: AssistantActionContext;
  /** Trusted in-memory local approval; required only for state-changing actions. */
  approval?: unknown;
  /** Trusted current validated-answer snapshot; required for evidence-answer steps. */
  trustedAnswerSnapshot?: unknown;
  /** Optional active dataset hash used to bind a trusted answer snapshot. */
  activeDatasetSha256?: string | null;
  handlers: AssistantActionHandlers;
  signal?: AbortSignal;
};

export type AssistantActionDispatchResult = {
  /** Parsed request, or null when input parsing failed. */
  readonly request: AssistantActionRequest | null;
  readonly outcome: AssistantActionOutcome;
  /** True only when one injected handler actually ran. */
  readonly handlerInvoked: boolean;
};

/**
 * Dispatch one action. Handler lookup is a closed switch over the parsed
 * discriminant. The authoritative context is checked again immediately before
 * a handler can run; stale or rejected actions never invoke a handler.
 */
export async function dispatchAssistantAction(
  input: AssistantActionDispatchInput,
): Promise<AssistantActionDispatchResult> {
  const parsed = parseAssistantActionRequest(input.action);
  if (!parsed.ok) {
    return { request: null, outcome: parsed.outcome, handlerInvoked: false };
  }
  const request = parsed.request;

  // Stale proposals are rejected against the current authoritative context
  // before they are validated against the current corpus or approved.
  const contextCheck = checkAssistantActionContext(request.context, input.activeContext);
  if (contextCheck.status === "stale") {
    return { request, outcome: staleOutcome(contextCheck.reasons), handlerInvoked: false };
  }

  if (input.dataset === null || input.dataset === undefined) {
    return {
      request,
      outcome: unavailableOutcome("service-unavailable", "The active corpus is unavailable."),
      handlerInvoked: false,
    };
  }
  const dataset = input.dataset;

  const requestIssues = validateAssistantActionRequestAgainstDataset(dataset, request);
  if (requestIssues.length) {
    return { request, outcome: invalidForCorpusIssues(requestIssues), handlerInvoked: false };
  }

  const approvalCheck = checkAssistantActionApproval(input.approval, request, input.activeContext);
  if (!approvalCheck.ok) {
    return {
      request,
      outcome: invalidOutcome(approvalCheck.code, approvalCheck.issues),
      handlerInvoked: false,
    };
  }

  if (request.kind === "prepare_notebook_step" && request.step.stepType === "evidence-answer") {
    const trusted = checkTrustedAnswerSnapshot(
      request.step,
      input.trustedAnswerSnapshot,
      input.activeDatasetSha256,
    );
    if (!trusted.ok) {
      return {
        request,
        outcome: invalidOutcome("invalid-context", trusted.issues),
        handlerInvoked: false,
      };
    }
  }

  // Re-check immediately before dispatch. No await occurs between this check
  // and the handler call.
  const dispatchCheck = checkAssistantActionContext(request.context, input.activeContext);
  if (dispatchCheck.status === "stale") {
    return { request, outcome: staleOutcome(dispatchCheck.reasons), handlerInvoked: false };
  }

  switch (request.kind) {
    case "create_plot": {
      const handler = input.handlers.create_plot;
      if (!handler) return { request, outcome: unavailableOutcome("service-unavailable", "The plot engine is unavailable."), handlerInvoked: false };
      let result: PlotResult;
      try {
        result = await handler({ request, dataset, signal: input.signal });
      } catch (error) {
        return { request, outcome: handlerFailureOutcome(error), handlerInvoked: true };
      }
      return {
        request,
        outcome: validateAssistantActionResult({
          request,
          dataset,
          result,
          activeDatasetSha256: input.activeDatasetSha256,
        }),
        handlerInvoked: true,
      };
    }
    case "explain_comparison_context": {
      const handler = input.handlers.explain_comparison_context;
      if (!handler) return { request, outcome: unavailableOutcome("service-unavailable", "The comparison context engine is unavailable."), handlerInvoked: false };
      let result: SelectedRunsContextResult;
      try {
        result = await handler({ request, dataset, signal: input.signal });
      } catch (error) {
        return { request, outcome: handlerFailureOutcome(error), handlerInvoked: true };
      }
      return {
        request,
        outcome: validateAssistantActionResult({
          request,
          dataset,
          result,
          activeDatasetSha256: input.activeDatasetSha256,
        }),
        handlerInvoked: true,
      };
    }
    case "find_comparators": {
      const handler = input.handlers.find_comparators;
      if (!handler) return { request, outcome: unavailableOutcome("service-unavailable", "The comparator engine is unavailable."), handlerInvoked: false };
      let result: ComparatorSearchResult;
      try {
        result = await handler({ request, dataset, signal: input.signal });
      } catch (error) {
        return { request, outcome: handlerFailureOutcome(error), handlerInvoked: true };
      }
      return {
        request,
        outcome: validateAssistantActionResult({
          request,
          dataset,
          result,
          activeDatasetSha256: input.activeDatasetSha256,
        }),
        handlerInvoked: true,
      };
    }
    case "prepare_notebook_step": {
      const handler = input.handlers.prepare_notebook_step;
      if (!handler) return { request, outcome: unavailableOutcome("service-unavailable", "The notebook engine is unavailable."), handlerInvoked: false };
      let result: NotebookStep;
      try {
        result = await handler({ request, dataset, signal: input.signal });
      } catch (error) {
        return { request, outcome: handlerFailureOutcome(error), handlerInvoked: true };
      }
      return {
        request,
        outcome: validateAssistantActionResult({
          request,
          dataset,
          result,
          trustedAnswerSnapshot: input.trustedAnswerSnapshot,
          activeDatasetSha256: input.activeDatasetSha256,
        }),
        handlerInvoked: true,
      };
    }
  }
}

/** Bind the injected engines once; U06-B can call the returned function per action. */
export function createAssistantActionDispatcher(handlers: AssistantActionHandlers) {
  return (input: Omit<AssistantActionDispatchInput, "handlers">) => dispatchAssistantAction({ ...input, handlers });
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

type ActionIssue = z.infer<typeof actionIssueSummarySchema>;
type InvalidActionOutcome = Extract<AssistantActionOutcome, { kind: "invalid" }>;
type UnavailableActionOutcome = Extract<AssistantActionOutcome, { kind: "unavailable" }>;
type StaleActionOutcome = Extract<AssistantActionOutcome, { kind: "stale-context" }>;

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function actionIssue(path: string, message: string): ActionIssue {
  return {
    path: boundedText(path || "action", 200),
    message: boundedText(message || "Invalid action", 300),
  };
}

function zodIssues(error: z.ZodError, prefix: string): ActionIssue[] {
  const issues = error.issues.slice(0, maxActionIssues).map(({ path, message }) => actionIssue(
    [prefix, ...path.map((part) => String(part))].filter(Boolean).join("."),
    message,
  ));
  return issues.length ? issues : [actionIssue(prefix, "The action did not match the accepted schema.")];
}

function corpusIssuesToActionIssues(issues: readonly CorpusValidationIssue[]): ActionIssue[] {
  return issues.slice(0, maxActionIssues).map(({ path, message }) => actionIssue(path, message));
}

function invalidOutcome(code: ActionInvalidCode, issues: ActionIssue[]): InvalidActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "invalid",
    code,
    issues: (issues.length ? issues : [actionIssue("action", "The action is invalid.")]).slice(0, maxActionIssues),
  }) as InvalidActionOutcome;
}

function staleOutcome(reasons: StaleActionOutcome["reasons"]): StaleActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "stale-context",
    reasons: reasons.length ? reasons : ["selection"],
  }) as StaleActionOutcome;
}

function unavailableOutcome(
  code: AssistantActionUnavailableCode,
  message: string,
): UnavailableActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "unavailable",
    code,
    message: boundedText(message, 300),
  }) as UnavailableActionOutcome;
}

function handlerFailureOutcome(error: unknown): UnavailableActionOutcome {
  if (error instanceof AssistantActionUnavailableError) {
    return unavailableOutcome(error.code, error.message);
  }
  // Do not echo provider/exception prose into the UI contract.
  return unavailableOutcome("service-unavailable", "The action handler could not complete the request.");
}

function invalidForCorpusIssues(issues: CorpusValidationIssue[]): InvalidActionOutcome {
  return invalidOutcome(actionCodeForCorpusIssue(issues[0]), corpusIssuesToActionIssues(issues));
}

function actionCodeForCorpusIssue(issue: CorpusValidationIssue | undefined): ActionInvalidCode {
  switch (issue?.code) {
    case "unknown-run":
      return "unknown-run";
    case "unknown-field":
    case "unknown-filter-field":
      return "unknown-field";
    case "unknown-source":
      return "unknown-source";
    case "version-mismatch":
    case "source-mismatch":
    case "binding-mismatch":
    case "duplicate-run":
    case "invalid-filter-type":
    case "invalid-value":
      return "invalid-context";
    default:
      return "invalid-action";
  }
}

/** JSON-semantics equality that ignores object key insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRunSearch(left: RunSearchRequest | null, right: RunSearchRequest | null): boolean {
  if (left === null || right === null) return left === right;
  const leftFilters = left.filters ?? [];
  const rightFilters = right.filters ?? [];
  return left.query === right.query
    && left.investigation === right.investigation
    && leftFilters.length === rightFilters.length
    && leftFilters.every(({ key, value }, index) => (
      key === rightFilters[index]?.key && value === rightFilters[index]?.value
    ));
}

function sameRunScope(left: RunScope, right: RunScope): boolean {
  if (left.kind === "explicit-runs") {
    return right.kind === "explicit-runs" && sameStringOrder(left.runIds, right.runIds);
  }
  if (left.kind === "filtered-results") {
    return right.kind === "filtered-results" && sameRunSearch(left.search, right.search);
  }
  return right.kind === "all-reviewed-runs";
}

function sameMatchingPolicy(left: MatchingPolicy, right: MatchingPolicy): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "exact" || right.mode === "exact") return true;
  return left.tolerances.length === right.tolerances.length
    && left.tolerances.every(({ field, tolerance }, index) => (
      right.tolerances[index]?.field === field && right.tolerances[index]?.tolerance === tolerance
    ));
}

/** An omitted comparator matching policy means exact matching, so compare effective rules. */
function sameComparatorRequest(left: ComparatorRequest, right: ComparatorRequest): boolean {
  return left.version === right.version
    && left.referenceRunId === right.referenceRunId
    && left.focusCondition === right.focusCondition
    && sameRunScope(left.candidateScope, right.candidateScope)
    && sameMatchingPolicy(effectiveMatchingPolicy(left), effectiveMatchingPolicy(right));
}

function sameSelectedRunsRequest(
  left: SelectedRunsContextRequest,
  right: SelectedRunsContextRequest,
): boolean {
  return left.version === right.version
    && sameStringOrder(left.runIds, right.runIds)
    && (left.focusCondition ?? null) === (right.focusCondition ?? null);
}

function recordedField(dataset: Dataset, runId: string, fieldKey: FieldKey) {
  return dataset.runs.find(({ id }) => id === runId)?.fields.find(({ key }) => key === fieldKey) ?? null;
}

function unresolvedReferenceMessage(reference: StableFieldReference, status: string): string {
  return `Source reference did not resolve (${status}) for ${reference.runId}/${reference.fieldKey}.`;
}

/* ----------------------------- plot results ------------------------------ */

function plotResultBindingIssues(
  dataset: Dataset,
  spec: PlotSpec,
  result: PlotResult,
  path: string,
): ActionIssue[] {
  const issues: ActionIssue[] = [];
  if (result.datasetVersion !== dataset.version) {
    issues.push(actionIssue(`${path}.datasetVersion`, "Plot result dataset version does not match the active corpus."));
  }
  if (result.kind !== spec.kind) {
    issues.push(actionIssue(`${path}.kind`, "Plot result kind does not match the requested plot spec."));
  }
  if (result.grouping !== spec.grouping) {
    issues.push(actionIssue(`${path}.grouping`, "Plot result grouping does not match the requested plot spec."));
  }
  const axesMatch = spec.kind === "scatter"
    ? result.axes.kind === "scatter"
      && result.axes.x === spec.axes.x.field
      && result.axes.y === spec.axes.y.field
    : result.axes.kind === "point-comparison"
      && result.axes.y === spec.axes.y.field;
  if (!axesMatch) {
    issues.push(actionIssue(`${path}.axes`, "Plot result axes do not match the requested plot spec."));
  }
  if (result.scope.kind !== spec.scope.kind) {
    issues.push(actionIssue(`${path}.scope.kind`, "Plot result scope does not match the requested plot scope."));
  }

  // The supplied scope resolver is authoritative for the ordered scope rows.
  const scopeResolution = resolveRunScope(dataset, spec.scope);
  if (!scopeResolution.ok) {
    issues.push(...corpusIssuesToActionIssues(scopeResolution.issues));
  } else if (!sameStringOrder(result.resolvedRunIds, scopeResolution.resolved.runIds)) {
    issues.push(actionIssue(
      `${path}.resolvedRunIds`,
      "Plot result resolved runs do not match the requested scope in order.",
    ));
  }
  if (spec.scope.kind === "filtered-results" && !sameRunSearch(result.scope.search, spec.scope.search)) {
    issues.push(actionIssue(`${path}.scope.search`, "Plot result filter context does not match the requested filter."));
  }

  const expectedAxisFields: readonly FieldKey[] = spec.kind === "scatter"
    ? [spec.axes.x.field, spec.axes.y.field]
    : [spec.axes.y.field];
  for (const [index, point] of result.points.entries()) {
    const pointPath = `${path}.points.${index}`;
    const referenceFields = point.sourceReferences.map(({ fieldKey }) => fieldKey);
    if (new Set(referenceFields).size !== referenceFields.length) {
      issues.push(actionIssue(`${pointPath}.sourceReferences`, "Plot point source references are not distinct."));
    }
    for (const fieldKey of expectedAxisFields) {
      const reference = point.sourceReferences.find((candidate) => candidate.fieldKey === fieldKey);
      if (!reference) {
        issues.push(actionIssue(
          `${pointPath}.sourceReferences`,
          `Plot point is missing the ${fieldKey} source reference.`,
        ));
        continue;
      }
      if (reference.runId !== point.runId) {
        issues.push(actionIssue(`${pointPath}.sourceReferences`, "Plot point source reference uses another run."));
      }
      const resolution = resolveStableFieldReference(dataset, reference);
      if (resolution.status !== "resolved") {
        issues.push(actionIssue(`${pointPath}.sourceReferences`, unresolvedReferenceMessage(reference, resolution.status)));
        continue;
      }
      const expectedValue = spec.kind === "scatter" && fieldKey === spec.axes.x.field
        ? point.x
        : point.y;
      if (resolution.field.value !== expectedValue) {
        issues.push(actionIssue(
          `${pointPath}.${spec.kind === "scatter" && fieldKey === spec.axes.x.field ? "x" : "y"}`,
          `Plot coordinate does not match the recorded ${fieldKey} value.`,
        ));
      }
    }
    if (result.grouping === "fuel") {
      const fuel = recordedField(dataset, point.runId, "fuel");
      if (!fuel || fuel.value !== point.group) {
        issues.push(actionIssue(`${pointPath}.group`, "Plot fuel group does not match the recorded fuel value."));
      }
    }
  }
  return issues;
}

/* ------------------------- comparison results ---------------------------- */

function comparisonResultBindingIssues(
  dataset: Dataset,
  request: SelectedRunsContextRequest,
  result: SelectedRunsContextResult,
  path: string,
): ActionIssue[] {
  const issues: ActionIssue[] = [];
  if (result.datasetVersion !== dataset.version) {
    issues.push(actionIssue(`${path}.datasetVersion`, "Comparison result dataset version does not match the active corpus."));
  }
  if (!sameSelectedRunsRequest(result.request, request)) {
    issues.push(actionIssue(`${path}.request`, "Comparison result request does not match the proposed request."));
  }
  if (!sameStringOrder(result.runIds, request.runIds)) {
    issues.push(actionIssue(`${path}.runIds`, "Comparison result runs do not follow the requested order."));
  }
  issues.push(...comparisonContextReferenceIssues(dataset, result, path));
  return issues;
}

function comparisonContextReferenceIssues(
  dataset: Dataset,
  result: SelectedRunsContextResult,
  path: string,
): ActionIssue[] {
  const issues: ActionIssue[] = [];
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  for (const runId of result.runIds) {
    if (!knownRunIds.has(runId)) {
      issues.push(actionIssue(`${path}.runIds`, `Unknown run ID in comparison result: ${runId}`));
    }
  }
  const groups = [["conditions", result.conditions], ["outcomes", result.outcomes]] as const;
  for (const [group, fields] of groups) {
    for (const [fieldIndex, field] of fields.entries()) {
      for (const [cellIndex, cell] of field.cells.entries()) {
        const cellPath = `${path}.${group}.${fieldIndex}.cells.${cellIndex}`;
        if (cell.reference === null) {
          if (cell.value !== null || cell.original !== null) {
            issues.push(actionIssue(cellPath, "A recorded comparison cell needs a stable source reference."));
          }
          continue;
        }
        if (cell.reference.runId !== cell.runId) {
          issues.push(actionIssue(cellPath, "Comparison cell reference uses another run."));
        }
        if (cell.reference.fieldKey !== field.key) {
          issues.push(actionIssue(cellPath, "Comparison cell reference uses another field."));
        }
        const resolution = resolveStableFieldReference(dataset, cell.reference);
        if (resolution.status !== "resolved") {
          issues.push(actionIssue(cellPath, unresolvedReferenceMessage(cell.reference, resolution.status)));
          continue;
        }
        if (resolution.field.value !== cell.value) {
          issues.push(actionIssue(cellPath, "Comparison cell value does not match the recorded source value."));
        }
        if (resolution.field.original !== cell.original) {
          issues.push(actionIssue(cellPath, "Comparison cell original text does not match the recorded source text."));
        }
      }
    }
  }
  for (const [evidenceIndex, evidence] of result.evidence.entries()) {
    for (const [referenceIndex, reference] of evidence.sourceReferences.entries()) {
      const resolution = resolveStableFieldReference(dataset, reference);
      if (resolution.status !== "resolved") {
        issues.push(actionIssue(
          `${path}.evidence.${evidenceIndex}.sourceReferences.${referenceIndex}`,
          unresolvedReferenceMessage(reference, resolution.status),
        ));
      }
    }
  }
  return issues;
}

function comparatorResultBindingIssues(
  dataset: Dataset,
  request: ComparatorRequest,
  result: ComparatorSearchResult,
  path: string,
): ActionIssue[] {
  const issues: ActionIssue[] = [];
  if (result.datasetVersion !== dataset.version) {
    issues.push(actionIssue(`${path}.datasetVersion`, "Comparator result dataset version does not match the active corpus."));
  }
  if (!sameComparatorRequest(result.request, request)) {
    issues.push(actionIssue(`${path}.request`, "Comparator result request does not match the proposed request."));
  }
  if (!sameRunScope(result.candidateScope, request.candidateScope)) {
    issues.push(actionIssue(`${path}.candidateScope`, "Comparator result candidate scope does not match the request."));
  }

  const scopeResolution = resolveRunScope(dataset, request.candidateScope);
  if (!scopeResolution.ok) {
    issues.push(...corpusIssuesToActionIssues(scopeResolution.issues));
  } else {
    const scopeRunIds = scopeResolution.resolved.runIds;
    const candidateRunIds = result.resolvedCandidateRunIds;
    let cursor = 0;
    const isOrderedSubset = candidateRunIds.every((runId) => {
      const found = scopeRunIds.indexOf(runId, cursor);
      if (found < 0) return false;
      cursor = found + 1;
      return true;
    });
    if (!isOrderedSubset) {
      issues.push(actionIssue(
        `${path}.resolvedCandidateRunIds`,
        "Comparator candidates are not an ordered subset of the requested candidate scope.",
      ));
    }
    if (new Set(candidateRunIds).size !== candidateRunIds.length) {
      issues.push(actionIssue(`${path}.resolvedCandidateRunIds`, "Comparator candidates are not distinct."));
    }
  }

  if (result.candidateScope.kind !== result.request.candidateScope.kind) {
    issues.push(actionIssue(`${path}.candidateScope`, "Comparator result scope kind does not match the request."));
  }

  const candidates = result.outcome.kind === "eligible-match"
    ? result.outcome.candidates
    : result.outcome.nearestCandidates;
  const candidateGroup = result.outcome.kind === "eligible-match" ? "candidates" : "nearestCandidates";
  for (const [index, candidate] of candidates.entries()) {
    const candidatePath = `${path}.outcome.${candidateGroup}.${index}`;
    if (candidate.context.datasetVersion !== dataset.version) {
      issues.push(actionIssue(`${candidatePath}.context.datasetVersion`, "Comparator candidate context uses another dataset version."));
    }
    if (!result.resolvedCandidateRunIds.includes(candidate.runId)) {
      issues.push(actionIssue(`${candidatePath}.runId`, "Comparator candidate is absent from the resolved scope."));
    }
    issues.push(...comparisonContextReferenceIssues(dataset, candidate.context, `${candidatePath}.context`));
  }
  return issues;
}

/* ---------------------------- notebook steps ------------------------------ */

function notebookStepBindingIssues(dataset: Dataset, step: NotebookStep, path: string): ActionIssue[] {
  const issues: ActionIssue[] = [];
  if (step.stepType === "plot") {
    issues.push(...plotResultBindingIssues(dataset, step.plotSpec, step.plotResult, `${path}.plotResult`));
  }
  if (step.stepType === "comparison") {
    issues.push(...comparisonResultBindingIssues(dataset, step.request, step.context, `${path}.context`));
  }
  if (step.stepType === "evidence-answer") {
    for (const [citationId, citation] of Object.entries(step.answer.citations)) {
      for (const [index, source] of citation.sources.entries()) {
        const reference: StableFieldReference = {
          datasetVersion: step.answer.datasetVersion,
          runId: source.runId,
          fieldKey: citation.fieldKey,
          sourceId: source.sourceId,
        };
        const resolution = resolveStableFieldReference(dataset, reference);
        if (resolution.status !== "resolved") {
          issues.push(actionIssue(
            `${path}.answer.citations.${citationId}.sources.${index}`,
            unresolvedReferenceMessage(reference, resolution.status),
          ));
          continue;
        }
        if (resolution.field.locator !== source.locator) {
          issues.push(actionIssue(
            `${path}.answer.citations.${citationId}.sources.${index}.locator`,
            "Citation source locator does not match the recorded source locator.",
          ));
        }
      }
    }
  }
  return issues;
}
