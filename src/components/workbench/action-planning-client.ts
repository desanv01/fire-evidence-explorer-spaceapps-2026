/**
 * U09.2/U09.3 — browser wrapper for the opt-in action planner.
 *
 * This module is browser-safe: it imports only the shared action/provenance
 * contracts and the local action registry. It never imports the server planner,
 * the provider adapter, signing code or `node:*`.
 *
 * The wrapper validates the typed response and binds it back to the exact
 * request (local action ID, context and corpus identity). The workbench then
 * performs the final current-workspace/corpus/selection recheck through
 * `acceptPlannedAssistantAction` before registering the proposal with the
 * existing action lifecycle. No provider/snapshot/notebook data is accepted
 * from the response.
 */
import { z } from "zod";
import type { Dataset } from "../../lib/evidence.ts";
import {
  assistantActionContextSchema,
  assistantActionOutcomeSchema,
  assistantActionRequestSchema,
  type AssistantActionContext,
  type AssistantActionOutcome,
  type AssistantActionRequest,
} from "../../lib/upgrades/actions.ts";
import {
  checkAssistantActionContext,
  sameAssistantActionContext,
  validateAssistantActionRequestAgainstDataset,
} from "../../lib/upgrades/action-registry.ts";
import type { AssistantActionCard } from "../../lib/upgrades/action-cards.ts";
import type { AssistantActionLifecycle } from "../../lib/upgrades/action-lifecycle.ts";
import { datasetHashSchema, datasetVersionSchema } from "../../lib/upgrades/provenance.ts";
import type {
  AssistantActionPlanRequest,
  AssistantActionPlanResponse,
} from "../../lib/upgrades/action-planning-api.ts";

const endpoint = "/api/assistant-action";
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/** Client-side mirror of the server request contract. */
const planRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  actionId: identifierSchema,
  context: assistantActionContextSchema,
  datasetVersion: datasetVersionSchema,
  datasetSha256: datasetHashSchema,
});
export type AssistantActionPlanInput = z.infer<typeof planRequestSchema> & AssistantActionPlanRequest;

const planIdentity = {
  datasetVersion: datasetVersionSchema,
  datasetSha256: datasetHashSchema,
};

/**
 * Client-side mirror of the server response contract. The integration test
 * parses a real route response with this schema, so drift fails a check.
 */
const planResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("proposed"),
    ...planIdentity,
    request: assistantActionRequestSchema,
  }),
  z.strictObject({
    status: z.literal("invalid"),
    ...planIdentity,
    outcome: assistantActionOutcomeSchema,
  }),
  z.strictObject({
    status: z.literal("stale"),
    ...planIdentity,
    outcome: assistantActionOutcomeSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    ...planIdentity,
    outcome: assistantActionOutcomeSchema,
  }),
  z.strictObject({ status: z.literal("cancelled"), ...planIdentity }),
]).superRefine((response, context) => {
  if (response.status === "proposed") {
    if (response.request.context.datasetVersion !== response.datasetVersion) {
      context.addIssue({
        code: "custom",
        path: ["request", "context", "datasetVersion"],
        message: "The proposed action is not bound to the response corpus identity",
      });
    }
    return;
  }
  if (response.status === "cancelled") return;
  const expected = response.status === "invalid"
    ? "invalid"
    : response.status === "stale" ? "stale-context" : "unavailable";
  if (response.outcome.kind !== expected) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "kind"],
      message: `The ${response.status} response carries an unexpected outcome`,
    });
  }
});

const errorMessages = {
  "invalid-request": "The AI planning request is invalid.",
  "expected-json": "The AI planning request must be JSON.",
  "body-too-large": "The AI planning request is too large.",
  "invalid-json": "The AI planning server could not read the request.",
  "invalid-response": "The AI planning service returned an invalid response.",
  "network-error": "The AI planning service could not be reached.",
  "request-failed": "The AI planning request failed.",
  "internal-error": "The AI planning service could not complete the request.",
} as const;
export type AssistantActionPlanningErrorCode = keyof typeof errorMessages;

export class AssistantActionPlanningError extends Error {
  readonly code: AssistantActionPlanningErrorCode;
  readonly status: number | undefined;

  constructor(code: AssistantActionPlanningErrorCode, status?: number) {
    super(errorMessages[code]);
    this.name = "AssistantActionPlanningError";
    this.code = code;
    this.status = status;
  }
}

function contentType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * Send one explicit planning request. This function performs no retry: one
 * caller invocation produces at most one HTTP request, which produces at most
 * one provider attempt through the existing server reservation.
 */
export async function requestAssistantActionPlan(
  input: AssistantActionPlanInput,
  options: { signal?: AbortSignal } = {},
): Promise<AssistantActionPlanResponse> {
  const parsedInput = planRequestSchema.safeParse(input);
  if (!parsedInput.success) throw new AssistantActionPlanningError("invalid-request");
  const body = parsedInput.data;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch (error) {
    if (aborted(error, options.signal)) throw error;
    throw new AssistantActionPlanningError("network-error");
  }

  if (!response.ok) {
    let code: AssistantActionPlanningErrorCode = "request-failed";
    if (contentType(response) === "application/json") {
      try {
        const value: unknown = await response.json();
        if (value !== null && typeof value === "object" && "error" in value
          && typeof value.error === "string" && Object.hasOwn(errorMessages, value.error)) {
          code = value.error as AssistantActionPlanningErrorCode;
        }
      } catch (error) {
        if (aborted(error, options.signal)) throw error;
      }
    }
    throw new AssistantActionPlanningError(code, response.status);
  }

  if (contentType(response) !== "application/json") {
    throw new AssistantActionPlanningError("invalid-response", response.status);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (aborted(error, options.signal)) throw error;
    throw new AssistantActionPlanningError("invalid-response", response.status);
  }
  const parsed = planResponseSchema.safeParse(value);
  if (!parsed.success) throw new AssistantActionPlanningError("invalid-response", response.status);
  const result = parsed.data;

  if (result.datasetVersion !== body.datasetVersion || result.datasetSha256 !== body.datasetSha256) {
    throw new AssistantActionPlanningError("invalid-response", response.status);
  }
  if (result.status === "proposed") {
    if (result.request.actionId !== body.actionId
      || !sameAssistantActionContext(result.request.context, body.context)
      || result.request.kind === "prepare_notebook_step") {
      throw new AssistantActionPlanningError("invalid-response", response.status);
    }
  }
  return result;
}

export type PlannedAssistantAction = Extract<AssistantActionPlanResponse, { status: "proposed" }>;

export type PlannedActionAcceptance =
  | { readonly ok: true; readonly card: AssistantActionCard; readonly request: AssistantActionRequest }
  | {
    readonly ok: false;
    readonly reason: "corpus" | "stale" | "invalid";
    readonly message: string;
  };

/**
 * Final local recheck before a planned proposal reaches the lifecycle. The
 * caller passes the authoritative current dataset/identity and active context;
 * no state is changed when any binding no longer matches. Registering is a
 * read-only `propose` call (no engine dispatch, no notebook append, no save).
 */
export function acceptPlannedAssistantAction(input: {
  plan: PlannedAssistantAction;
  /** The exact context sent with the planning request. */
  plannedContext: AssistantActionContext;
  /** The locally generated action ID sent with the planning request. */
  actionId: string;
  /** Current trusted workspace/turn/corpus/ordered-selection context. */
  activeContext: AssistantActionContext;
  /** Current authoritative parsed corpus. */
  dataset: Dataset;
  datasetSha256: string;
  /** True only while the served overview identity matches this corpus. */
  corpusReady: boolean;
  lifecycle: Pick<AssistantActionLifecycle, "propose">;
}): PlannedActionAcceptance {
  const { plan, dataset, datasetSha256 } = input;
  if (!input.corpusReady) {
    return {
      ok: false,
      reason: "corpus",
      message: "The corpus identity is no longer verified, so the AI proposal was not registered. Compare the recorded evidence from the current workspace.",
    };
  }
  if (plan.datasetVersion !== dataset.version || plan.datasetSha256 !== datasetSha256) {
    return {
      ok: false,
      reason: "corpus",
      message: "The AI proposal was planned against a different corpus than the current workspace, so it was not registered.",
    };
  }
  if (plan.request.actionId !== input.actionId
    || !sameAssistantActionContext(plan.request.context, input.plannedContext)) {
    return {
      ok: false,
      reason: "invalid",
      message: "The AI proposal was not bound to this exact request and context, so it was not registered.",
    };
  }
  const freshness = checkAssistantActionContext(input.plannedContext, input.activeContext);
  if (freshness.status === "stale") {
    return {
      ok: false,
      reason: "stale",
      message: `The workspace, turn, corpus or ordered selection changed while planning (${freshness.reasons.join(", ")}). The AI proposal was discarded and nothing was registered.`,
    };
  }
  if (plan.request.kind === "prepare_notebook_step") {
    return {
      ok: false,
      reason: "invalid",
      message: "AI planning cannot propose notebook changes. Pin a reviewed plot, comparison or trusted answer locally instead.",
    };
  }
  // Mirror the adapter's provider-grounding rule locally: an explicit plot or
  // comparator payload may only use runs in the ordered current selection.
  const selected = new Set(input.activeContext.selectedRunIds);
  const outsideSelection = (runIds: readonly string[]) => runIds.some((runId) => !selected.has(runId));
  const ungrounded = plan.request.kind === "create_plot"
    ? (plan.request.plot.scope.kind === "explicit-runs" && outsideSelection(plan.request.plot.scope.runIds))
    : plan.request.kind === "explain_comparison_context"
      ? outsideSelection(plan.request.request.runIds)
      : plan.request.kind === "find_comparators"
        ? (!selected.has(plan.request.request.referenceRunId)
          || (plan.request.request.candidateScope.kind === "explicit-runs"
            && outsideSelection(plan.request.request.candidateScope.runIds)))
        : true;
  if (ungrounded) {
    return {
      ok: false,
      reason: "stale",
      message: "The AI proposal uses runs outside the current ordered selection, so it was not registered. Nothing was applied.",
    };
  }
  const corpusIssues = validateAssistantActionRequestAgainstDataset(dataset, plan.request);
  if (corpusIssues.length) {
    return {
      ok: false,
      reason: "invalid",
      message: `The AI proposal no longer matches the current corpus: ${corpusIssues[0]?.message ?? "the request is invalid."} Nothing was registered.`,
    };
  }

  let proposed: ReturnType<AssistantActionLifecycle["propose"]>;
  try {
    proposed = input.lifecycle.propose(plan.request);
  } catch {
    return {
      ok: false,
      reason: "invalid",
      message: "The AI proposal could not be registered with the local action lifecycle. Nothing was registered.",
    };
  }
  if (!proposed.ok) {
    return {
      ok: false,
      reason: "invalid",
      message: `The AI proposal was not accepted by the local action lifecycle: ${proposed.outcome.issues[0]?.message ?? "the request is invalid."} Nothing was registered.`,
    };
  }
  return { ok: true, card: proposed.card, request: plan.request };
}

/** User-facing message for a non-proposed planner result. No retry is implied. */
export function assistantPlanResultMessage(
  result: Exclude<AssistantActionPlanResponse, { status: "proposed" }>,
): string {
  if (result.status === "cancelled") {
    return "The AI planning request was cancelled. Nothing was registered.";
  }
  const outcome: AssistantActionOutcome = result.outcome;
  if (outcome.kind === "stale-context") {
    return "The workspace, corpus or ordered selection changed while the AI plan was being prepared, so the result was discarded. Nothing was registered.";
  }
  if (outcome.kind === "unavailable") {
    return outcome.message ?? "AI planning is unavailable. Manual actions remain available.";
  }
  if (outcome.kind === "invalid") {
    return `The AI plan did not validate against the current workspace: ${outcome.issues[0]?.message ?? "the request is invalid."} Nothing was registered.`;
  }
  return "The AI plan did not produce a usable read-only action. Nothing was registered.";
}
