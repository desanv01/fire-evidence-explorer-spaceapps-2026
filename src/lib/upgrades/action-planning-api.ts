/**
 * U09.2 — bounded, validated server-side action planning.
 *
 * This module is the only server entry point for the opt-in AI planner. It:
 * - accepts one small JSON request (question, locally generated action ID, the
 *   trusted assistant-action context and the public corpus identity);
 * - bounds the body, question and context before any provider work;
 * - validates the corpus identity, run membership and context against the same
 *   authoritative parsed public corpus used by `/api/evidence`;
 * - forwards request cancellation to the existing guarded DeepSeek adapter
 *   (`suggestAssistantAction`) rather than opening a second provider client;
 * - returns one typed, validated outcome with no notebook, receipt, private
 *   note, raw upstream response, model output or credential.
 *
 * The response is deliberately smaller than the chat API. The browser wrapper
 * (`src/components/workbench/action-planning-client.ts`) revalidates it, then
 * the workbench rechecks the current corpus, workspace, turn and ordered
 * selection before registering anything with the local action lifecycle.
 */
import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import {
  assistantActionContextSchema,
  assistantActionOutcomeSchema,
  assistantActionRequestSchema,
  type AssistantActionOutcome,
} from "./actions.ts";
import { sameAssistantActionContext } from "./action-registry.ts";
import { datasetHashSchema, datasetVersionSchema } from "./provenance.ts";
import {
  suggestAssistantAction,
  type DeepSeekActionSuggestion,
} from "../deepseek.ts";

const maxBodyBytes = 8 * 1024;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
 * One planning request. The action ID is generated locally by the browser and
 * is never accepted from provider text; the server only echoes it into the
 * validated request it returns.
 */
export const assistantActionPlanRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  actionId: identifierSchema,
  context: assistantActionContextSchema,
  datasetVersion: datasetVersionSchema,
  datasetSha256: datasetHashSchema,
});
export type AssistantActionPlanRequest = z.infer<typeof assistantActionPlanRequestSchema>;

const planIdentity = {
  datasetVersion: datasetVersionSchema,
  datasetSha256: datasetHashSchema,
};

/**
 * Closed typed response union. `proposed` carries a validated action request;
 * the other states carry only the canonical outcome union or a cancellation
 * marker. The client duplicate of this schema is checked against real server
 * responses in the U09 integration test.
 */
export const assistantActionPlanResponseSchema = z.discriminatedUnion("status", [
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
export type AssistantActionPlanResponse = z.infer<typeof assistantActionPlanResponseSchema>;

export type AssistantActionPlanningApiOptions = {
  /** Authoritative parsed public corpus, exactly as used by the evidence route. */
  dataset: Dataset;
  /** Manifest hash for that corpus. */
  datasetSha256: string;
  /** Injectable provider environment/transport for tests; production omits them. */
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
};

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

async function readPlanRequest(request: Request): Promise<AssistantActionPlanRequest> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "expected-json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0) throw new RequestError(400, "invalid-request");
    if (length > maxBodyBytes) throw new RequestError(413, "body-too-large");
  }
  if (!request.body) throw new RequestError(400, "invalid-json");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "body-too-large");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return assistantActionPlanRequestSchema.parse(JSON.parse(chunks.join("")));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof z.ZodError) throw new RequestError(400, "invalid-request");
    void reader.cancel().catch(() => undefined);
    throw new RequestError(400, "invalid-json");
  } finally {
    reader.releaseLock();
  }
}

function invalidOutcome(
  code: Extract<AssistantActionOutcome, { kind: "invalid" }>["code"],
  issues: readonly { path: string; message: string }[],
): AssistantActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "invalid",
    code,
    issues: issues.length ? issues.slice(0, 20) : [{ path: "action", message: "The planned action is invalid." }],
  });
}

function staleOutcome(
  reasons: Extract<AssistantActionOutcome, { kind: "stale-context" }>["reasons"],
): AssistantActionOutcome {
  return assistantActionOutcomeSchema.parse({ kind: "stale-context", reasons: [...reasons] });
}

function unavailableOutcome(message: string): AssistantActionOutcome {
  return assistantActionOutcomeSchema.parse({
    kind: "unavailable",
    code: "service-unavailable",
    message: message.slice(0, 300),
  });
}

/**
 * Handle one POST /api/assistant-action request. No provider work starts until
 * the body, identity, context and run membership have been validated against
 * the authoritative corpus.
 */
export async function handleAssistantActionPlanRequest(
  request: Request,
  options: AssistantActionPlanningApiOptions,
): Promise<Response> {
  const { dataset, datasetSha256 } = options;
  const identity = { datasetVersion: dataset.version, datasetSha256 };

  let input: AssistantActionPlanRequest;
  try {
    input = await readPlanRequest(request);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    return json({ error: "internal-error" }, 500);
  }

  // The browser's public corpus identity and the context's corpus version must
  // both describe the authoritative server corpus. A mismatch is a typed stale
  // result and never reaches the provider.
  if (input.datasetVersion !== dataset.version
    || input.datasetSha256 !== datasetSha256
    || input.context.datasetVersion !== dataset.version) {
    return json(assistantActionPlanResponseSchema.parse({
      status: "stale",
      ...identity,
      outcome: staleOutcome(["dataset-version"]),
    }));
  }

  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  const unknownRunIds = input.context.selectedRunIds.filter((runId) => !knownRunIds.has(runId));
  if (unknownRunIds.length) {
    return json(assistantActionPlanResponseSchema.parse({
      status: "invalid",
      ...identity,
      outcome: invalidOutcome("unknown-run", unknownRunIds.slice(0, 3).map((runId, index) => ({
        path: `context.selectedRunIds.${index}`,
        message: `The planning context contains an unknown run ID: ${runId}`,
      }))),
    }));
  }

  let suggestion: DeepSeekActionSuggestion;
  try {
    // The existing guarded adapter owns the single provider call, shared attempt
    // reservation, timeout, redacted diagnostics and typed availability mapping.
    suggestion = await suggestAssistantAction(input.question, input.context, dataset, {
      env: options.env,
      fetchImpl: options.fetchImpl,
      signal: request.signal,
      actionId: input.actionId,
    });
  } catch {
    return json(assistantActionPlanResponseSchema.parse({
      status: "unavailable",
      ...identity,
      outcome: unavailableOutcome("AI action planning could not complete. Manual actions remain available."),
    }));
  }

  if (suggestion.status === "cancelled") {
    return json(assistantActionPlanResponseSchema.parse({ status: "cancelled", ...identity }));
  }

  if (suggestion.status === "proposed") {
    // Defense in depth: the adapter derives identity/context locally, but never
    // return a request that is not bound to this exact request and corpus.
    if (suggestion.request.actionId !== input.actionId
      || !sameAssistantActionContext(suggestion.request.context, input.context)
      || suggestion.request.kind === "prepare_notebook_step") {
      return json(assistantActionPlanResponseSchema.parse({
        status: "unavailable",
        ...identity,
        outcome: unavailableOutcome("The planning response did not bind to this request. Manual actions remain available."),
      }));
    }
    return json(assistantActionPlanResponseSchema.parse({
      status: "proposed",
      ...identity,
      request: suggestion.request,
    }));
  }

  return json(assistantActionPlanResponseSchema.parse({
    status: suggestion.status,
    ...identity,
    outcome: suggestion.outcome,
  }));
}
