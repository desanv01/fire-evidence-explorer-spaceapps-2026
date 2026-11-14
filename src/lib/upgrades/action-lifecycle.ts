import type { Dataset } from "../evidence.ts";
import {
  actionEffect,
  assistantActionOutcomeSchema,
  assistantActionRecordSchema,
  requiresUserApproval,
  type ActionFailure,
  type ActionInvalidCode,
  type ActionKind,
  type AssistantActionContext,
  type AssistantActionOutcome,
  type AssistantActionRecord,
  type AssistantActionRequest,
  type StaleActionContextReason,
} from "./actions.ts";
import {
  buildAssistantActionCard,
  type AssistantActionCard,
} from "./action-cards.ts";
import {
  checkAssistantActionApproval,
  checkAssistantActionContext,
  dispatchAssistantAction,
  parseAssistantActionRequest,
  sameAssistantActionRequest,
  type AssistantActionHandlers,
  type LocalAssistantActionApproval,
} from "./action-registry.ts";
import { buildSelectedRunsContext, searchComparators } from "./comparison-engine.ts";
import { buildPlotResult } from "./plot-engine.ts";

/**
 * U06.5–U06.7 action lifecycle.
 *
 * - Uses the canonical `AssistantActionRecord` and `AssistantActionOutcome`
 *   contracts; no competing action schema.
 * - Engine handlers are wired to the delivered plot, comparison and notebook
 *   engines. `prepare_notebook_step` only validates/returns the proposed step;
 *   saving it remains a separate explicit notebook decision.
 * - The authoritative workspace/turn/corpus/selection is re-read before dispatch
 *   and again after every async completion. A stale or cancelled action never
 *   applies a late outcome.
 * - Confirmation is idempotent per lifecycle: rapid duplicate calls share one
 *   dispatch, and a terminal action is returned from cache without invoking a
 *   handler or applying the notebook step again.
 */

export type InvalidActionOutcome = Extract<AssistantActionOutcome, { kind: "invalid" }>;
export type StaleActionOutcome = Extract<AssistantActionOutcome, { kind: "stale-context" }>;
export type UnavailableActionOutcome = Extract<AssistantActionOutcome, { kind: "unavailable" }>;

export type AssistantActionExecutionStatus = "executed" | "cancelled" | "failed" | "rejected";

export type AssistantActionExecutionResult = {
  readonly status: AssistantActionExecutionStatus;
  readonly record: AssistantActionRecord;
  readonly card: AssistantActionCard;
  /** Executed outcome or a transient rejection outcome; null for failed/cancelled. */
  readonly outcome: AssistantActionOutcome | null;
  readonly handlerInvoked: boolean;
  /** True only when this call produced the terminal record/outcome. */
  readonly applied: boolean;
  /** True when this call returned an existing in-flight or terminal result. */
  readonly replayed: boolean;
};

export type AssistantActionProposalResult =
  | {
    readonly ok: true;
    readonly record: AssistantActionRecord;
    readonly card: AssistantActionCard;
    readonly replayed: boolean;
  }
  | {
    readonly ok: false;
    readonly outcome: InvalidActionOutcome;
    readonly card: AssistantActionCard | null;
  };

export type AssistantActionExecutionOptions = {
  readonly signal?: AbortSignal;
  /** Trusted current validated-answer snapshot for an evidence-answer step. */
  readonly trustedAnswerSnapshot?: unknown;
  readonly activeDatasetSha256?: string | null;
};

export type AssistantActionLifecycleOptions = {
  /** Authoritative corpus at execution time; returning null yields unavailable. */
  readonly getDataset: () => Dataset | null;
  /** Trusted authoritative workspace/turn/corpus/ordered-selection state. */
  readonly readActiveContext: () => AssistantActionContext;
  /** Defaults to the delivered plot/comparison/notebook engine adapters. */
  readonly handlers?: AssistantActionHandlers;
  /** Trusted local clock; defaults to the current ISO time. */
  readonly now?: () => string;
  /** Optional local persistence/card-observer hook. It must not call a provider. */
  readonly onRecord?: (record: AssistantActionRecord, card: AssistantActionCard) => void;
};

export type AssistantActionLifecycle = {
  propose(request: unknown): AssistantActionProposalResult;
  confirm(
    actionId: string,
    approval?: unknown,
    options?: AssistantActionExecutionOptions,
  ): Promise<AssistantActionExecutionResult>;
  execute(
    actionId: string,
    options?: AssistantActionExecutionOptions,
  ): Promise<AssistantActionExecutionResult>;
  cancel(actionId: string, reason?: string): AssistantActionExecutionResult;
  getRecord(actionId: string): AssistantActionRecord | null;
  getCard(actionId: string): AssistantActionCard | null;
  listCards(): readonly AssistantActionCard[];
};

type Entry = {
  request: AssistantActionRequest;
  record: AssistantActionRecord;
  card: AssistantActionCard;
  approval: LocalAssistantActionApproval | null;
  controller: AbortController;
  cancelRequested: boolean;
  cancelReason: string | null;
  terminal: boolean;
  inflight: Promise<AssistantActionExecutionResult> | null;
  handlerInvoked: boolean;
};

type RecordTransitionOptions = {
  attemptOutcome?: AssistantActionOutcome;
  notice?: string;
};

/**
 * Typed adapters over the delivered engines. The notebook adapter does not
 * append/save anything; the validated step is returned for the separate
 * notebook save flow.
 */
export function createEngineActionHandlers(): AssistantActionHandlers {
  return {
    create_plot: ({ request, dataset, signal }) => {
      throwIfAborted(signal);
      const result = buildPlotResult(dataset, request.plot);
      throwIfAborted(signal);
      return result;
    },
    explain_comparison_context: ({ request, dataset, signal }) => {
      throwIfAborted(signal);
      const result = buildSelectedRunsContext(dataset, request.request);
      throwIfAborted(signal);
      return result;
    },
    find_comparators: ({ request, dataset, signal }) => {
      throwIfAborted(signal);
      const result = searchComparators(dataset, request.request);
      throwIfAborted(signal);
      return result;
    },
    prepare_notebook_step: ({ request, signal }) => {
      throwIfAborted(signal);
      // Request and returned-step validation (including the trusted answer
      // snapshot check) happen in the registry dispatcher before/after this.
      return request.step;
    },
  };
}

/** Locally generated action ID; never accepted from provider text. */
export function createAssistantActionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2);
  return `action-${random}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

export function createAssistantActionLifecycle(
  options: AssistantActionLifecycleOptions,
): AssistantActionLifecycle {
  const entries = new Map<string, Entry>();
  const handlers = options.handlers ?? createEngineActionHandlers();
  const now = options.now ?? (() => new Date().toISOString());

  function transition(entry: Entry, record: AssistantActionRecord, cardOptions: RecordTransitionOptions = {}): void {
    const parsed = assistantActionRecordSchema.parse(record);
    entry.record = parsed;
    entry.card = buildAssistantActionCard(parsed, cardOptions);
    entry.terminal = parsed.status === "executed" || parsed.status === "failed" || parsed.status === "cancelled";
    try {
      options.onRecord?.(parsed, entry.card);
    } catch {
      // A local observer must not corrupt the canonical lifecycle state.
    }
  }

  function resultFor(
    entry: Entry,
    values: {
      status: AssistantActionExecutionStatus;
      applied: boolean;
      replayed: boolean;
      outcome?: AssistantActionOutcome | null;
      handlerInvoked?: boolean;
    },
  ): AssistantActionExecutionResult {
    return {
      status: values.status,
      record: entry.record,
      card: entry.card,
      outcome: values.outcome ?? (entry.record.status === "executed" ? entry.record.outcome : null),
      handlerInvoked: values.handlerInvoked ?? entry.handlerInvoked,
      applied: values.applied,
      replayed: values.replayed,
    };
  }

  function requireEntry(actionId: string): Entry {
    const entry = entries.get(actionId);
    if (!entry) throw new RangeError(`Unknown assistant action: ${actionId}`);
    return entry;
  }

  function proposal(request: unknown): AssistantActionProposalResult {
    const parsed = parseAssistantActionRequest(request);
    if (!parsed.ok) return { ok: false, outcome: parsed.outcome, card: null };
    const action = parsed.request;
    const existing = entries.get(action.actionId);
    if (existing) {
      if (sameAssistantActionRequest(existing.request, action)) {
        return { ok: true, record: existing.record, card: existing.card, replayed: true };
      }
      return {
        ok: false,
        outcome: invalidOutcome("invalid-action", [{
          path: "actionId",
          message: "Another action lifecycle entry already uses this action ID.",
        }]),
        card: existing.card,
      };
    }

    const record = assistantActionRecordSchema.parse({
      status: "proposed",
      request: action,
      effect: actionEffect(action.kind),
    });
    const entry: Entry = {
      request: action,
      record,
      card: buildAssistantActionCard(record),
      approval: null,
      controller: new AbortController(),
      cancelRequested: false,
      cancelReason: null,
      terminal: false,
      inflight: null,
      handlerInvoked: false,
    };
    entries.set(action.actionId, entry);
    try {
      options.onRecord?.(record, entry.card);
    } catch {
      // See transition().
    }
    return { ok: true, record, card: entry.card, replayed: false };
  }

  function rejectApproval(entry: Entry, issues: { path: string; message: string }[], notice: string): AssistantActionExecutionResult {
    const outcome = invalidOutcome("invalid-action", issues);
    const card = buildAssistantActionCard(entry.record, { attemptOutcome: outcome, notice });
    return {
      status: "rejected",
      record: entry.record,
      card,
      outcome,
      handlerInvoked: false,
      applied: false,
      replayed: false,
    };
  }

  function approve(
    entry: Entry,
    approval: unknown,
  ): AssistantActionExecutionResult | null {
    if (!requiresUserApproval(entry.request.kind)) return null;
    if (entry.record.status === "approved") return null;
    if (entry.record.status !== "proposed") return null;

    const check = checkAssistantActionApproval(approval, entry.request, entry.request.context);
    if (!check.ok) {
      return rejectApproval(
        entry,
        check.issues,
        "Approval did not match this exact action request and context, so nothing was executed.",
      );
    }
    if (!check.approval) {
      return rejectApproval(entry, [{
        path: "approval",
        message: "A local approval is required for this state-changing action.",
      }], "This action requires a local approval before it can run.");
    }
    entry.approval = check.approval;
    transition(entry, assistantActionRecordSchema.parse({
      status: "approved",
      request: entry.request,
      effect: actionEffect(entry.request.kind),
      approvedAt: check.approval.approvedAt,
    }), { notice: "Approved. Ready to run." });
    return null;
  }

  async function runExecution(
    entry: Entry,
    execution: AssistantActionExecutionOptions,
  ): Promise<AssistantActionExecutionResult> {
    try {
      if (entry.terminal) {
        return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
      }
      const signal = execution.signal
        ? AbortSignal.any([entry.controller.signal, execution.signal])
        : entry.controller.signal;
      if (signal.aborted) {
        return applyCancelled(entry, entry.cancelReason ?? "The action was cancelled.");
      }

      const activeContext = options.readActiveContext();
      const before = checkAssistantActionContext(entry.request.context, activeContext);
      if (before.status === "stale") {
        return applyExecuted(entry, staleOutcome(before.reasons), false);
      }

      const dataset = options.getDataset();
      const dispatched = await dispatchAssistantAction({
        action: entry.request,
        dataset,
        activeContext,
        approval: entry.approval,
        trustedAnswerSnapshot: execution.trustedAnswerSnapshot,
        activeDatasetSha256: execution.activeDatasetSha256,
        handlers,
        signal,
      });
      entry.handlerInvoked = dispatched.handlerInvoked;

      // A cancellation may have applied while the handler was running.
      if (entry.terminal) {
        return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
      }
      if (signal.aborted || entry.cancelRequested) {
        return applyCancelled(entry, entry.cancelReason ?? "The action was cancelled.");
      }

      const latestContext = options.readActiveContext();
      const after = checkAssistantActionContext(entry.request.context, latestContext);
      if (after.status === "stale") {
        return applyExecuted(entry, staleOutcome(after.reasons), dispatched.handlerInvoked);
      }
      return applyExecuted(entry, dispatched.outcome, dispatched.handlerInvoked);
    } catch {
      return applyFailed(entry);
    }
  }

  function applyExecuted(
    entry: Entry,
    outcome: AssistantActionOutcome,
    handlerInvoked: boolean,
  ): AssistantActionExecutionResult {
    if (entry.terminal) {
      return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
    }
    if (requiresUserApproval(entry.request.kind) && !entry.approval) {
      return rejectApproval(entry, [{
        path: "approval",
        message: "The state-changing action was not approved.",
      }], "This action requires a local approval before it can run.");
    }
    entry.handlerInvoked = handlerInvoked;
    transition(entry, assistantActionRecordSchema.parse({
      status: "executed",
      request: entry.request,
      effect: actionEffect(entry.request.kind),
      approvedAt: requiresUserApproval(entry.request.kind) ? entry.approval?.approvedAt ?? null : null,
      executedAt: now(),
      outcome,
    }));
    return resultFor(entry, { status: "executed", applied: true, replayed: false, outcome, handlerInvoked });
  }

  function applyCancelled(entry: Entry, reason: string): AssistantActionExecutionResult {
    if (entry.terminal) {
      return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
    }
    entry.cancelRequested = true;
    entry.cancelReason = reason;
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    transition(entry, assistantActionRecordSchema.parse({
      status: "cancelled",
      request: entry.request,
      effect: actionEffect(entry.request.kind),
      cancelledAt: now(),
      reason: boundedText(reason, 300),
    }));
    return resultFor(entry, { status: "cancelled", applied: true, replayed: false, outcome: null });
  }

  function applyFailed(entry: Entry): AssistantActionExecutionResult {
    if (entry.terminal) {
      return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
    }
    const error: ActionFailure = {
      code: "execution-failed",
      message: "The action could not complete. The manual deterministic tools remain available.",
    };
    transition(entry, assistantActionRecordSchema.parse({
      status: "failed",
      request: entry.request,
      effect: actionEffect(entry.request.kind),
      failedAt: now(),
      error,
    }));
    return resultFor(entry, { status: "failed", applied: true, replayed: false, outcome: null, handlerInvoked: entry.handlerInvoked });
  }

  function startExecution(
    actionId: string,
    execution: AssistantActionExecutionOptions,
  ): Promise<AssistantActionExecutionResult> {
    const entry = requireEntry(actionId);
    if (entry.terminal) {
      return Promise.resolve(resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true }));
    }
    if (entry.inflight) {
      return entry.inflight.then((result) => ({
        ...result,
        applied: false,
        replayed: true,
      }));
    }
    if (requiresUserApproval(entry.request.kind) && entry.record.status !== "approved") {
      return Promise.resolve(rejectApproval(entry, [{
        path: "approval",
        message: "This state-changing action requires local approval before execution.",
      }], "This action requires a local approval before it can run."));
    }

    const promise = runExecution(entry, execution);
    entry.inflight = promise;
    void promise.then(
      () => {
        if (entry.inflight === promise) entry.inflight = null;
      },
      () => {
        if (entry.inflight === promise) entry.inflight = null;
      },
    );
    return promise;
  }

  async function confirm(
    actionId: string,
    approval?: unknown,
    execution: AssistantActionExecutionOptions = {},
  ): Promise<AssistantActionExecutionResult> {
    const entry = requireEntry(actionId);
    if (entry.terminal) {
      return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
    }
    if (entry.inflight) {
      return entry.inflight.then((result) => ({ ...result, applied: false, replayed: true }));
    }
    const rejected = approve(entry, approval);
    if (rejected) return rejected;
    return startExecution(actionId, execution);
  }

  function execute(
    actionId: string,
    execution: AssistantActionExecutionOptions = {},
  ): Promise<AssistantActionExecutionResult> {
    return startExecution(actionId, execution);
  }

  function cancel(actionId: string, reason = "The action was cancelled."): AssistantActionExecutionResult {
    const entry = requireEntry(actionId);
    if (entry.terminal) {
      return resultFor(entry, { status: statusOf(entry.record), applied: false, replayed: true });
    }
    return applyCancelled(entry, reason);
  }

  return {
    propose: proposal,
    confirm,
    execute,
    cancel,
    getRecord: (actionId) => entries.get(actionId)?.record ?? null,
    getCard: (actionId) => entries.get(actionId)?.card ?? null,
    listCards: () => [...entries.values()].map(({ card }) => card),
  };
}

function statusOf(record: AssistantActionRecord): AssistantActionExecutionStatus {
  switch (record.status) {
    case "executed":
      return "executed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "proposed":
    case "approved":
      return "rejected";
  }
}

function staleOutcome(reasons: readonly StaleActionContextReason[]): StaleActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "stale-context",
    reasons: [...reasons],
  }) as StaleActionOutcome;
}

function invalidOutcome(code: ActionInvalidCode, issues: { path: string; message: string }[]): InvalidActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "invalid",
    code,
    issues: (issues.length ? issues : [{ path: "action", message: "The action is invalid." }])
      .slice(0, 20)
      .map(({ path, message }) => ({ path: boundedText(path || "action", 200), message: boundedText(message, 300) })),
  }) as InvalidActionOutcome;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("The action was cancelled.");
  error.name = "AbortError";
  throw error;
}
