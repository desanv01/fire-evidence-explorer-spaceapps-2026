import { z } from "zod";
import { comparisonRequestSchema, datasetSchema, runSearchSchema, type RunSearchRequest } from "./evidence.ts";
import type { DatasetProvenance } from "./evidence-export.ts";
import type { RankedCandidate } from "./evidence-ranking.ts";

const endpoint = "/api/evidence";
const selectionParam = "run";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const webUrl = z.url({ protocol: /^https?$/ });
const identity = {
  datasetVersion: z.string().min(1),
  datasetSha256: hash,
  comparisonRuleVersion: z.string().min(1),
};
const source = datasetSchema.shape.sources.element;
const run = datasetSchema.shape.runs.element;
const field = run.shape.fields.element;
const count = z.int().nonnegative();
const provenance = z.object({
  datasetVersion: z.string(), datasetFile: z.string(), datasetSha256: hash,
  source: z.object({
    id: z.string(), accession: z.string(), investigationUrl: webUrl, investigationVersion: count,
    doi: z.string(), license: z.string(), licenseUrl: webUrl, fileName: z.string(), fileVersion: count,
    repositoryObjectPath: z.string(), repositoryObjectVersion: z.string(),
    sizeBytes: count, sha256: hash, encoding: z.string(), dataRows: count,
  }),
  selection: z.object({
    rule: z.string(), runCount: count, fieldsPerRun: count, unknownFields: count,
    reviewDate: z.string().optional(), reviewMethod: z.string(),
  }),
  interpretationReference: z.object({
    reportNumber: z.string(), url: webUrl,
    locations: z.array(z.object({ section: z.string(), printedPage: count, pdfPage: count })),
  }),
  transforms: z.object({
    original: z.string(), value: z.string(), locator: z.string(),
    burning_rate: z.string(), gas_labels: z.string(), extinction_diameter: z.string(),
  }),
}) satisfies z.ZodType<DatasetProvenance>;

const overview = z.object({
  ...identity, runCount: count, investigations: z.array(z.string()), sources: z.array(source),
  provenance, aiEnabled: z.boolean(),
});
const searchResult = z.object({ ...identity, search: runSearchSchema, runs: z.array(run) });
const runResult = z.object({ ...identity, run });
const sourceResult = z.object({ ...identity, runId: z.string(), field, source, provenance });
const runIdsSchema = comparisonRequestSchema.shape.runIds;
const condition = z.object({
  key: z.string(), label: z.string(), reason: z.string(),
  status: z.enum(["same", "different", "unknown", "incompatible"]),
});
const comparison = z.object({
  ...identity, runIds: runIdsSchema,
  rows: z.array(condition.extend({
    cells: z.array(z.object({ runId: z.string(), field: field.nullable(), source: source.nullable() })),
    differences: z.array(z.object({ fromRunId: z.string(), toRunId: z.string(), delta: z.number() })),
  })),
});
const rankedCandidate = z.object({
  runId: z.string().min(1),
  score: z.number().min(0).max(1).nullable(),
  comparableCount: count,
  sameCount: count,
  differentCount: count,
  unknownCount: count,
  incompatibleCount: count,
  conditions: z.array(condition),
}) satisfies z.ZodType<RankedCandidate>;
const ranking = z.object({
  ...identity, rankingRuleVersion: z.string().min(1), referenceRunId: z.string().min(1),
  search: runSearchSchema.optional(), candidates: z.array(rankedCandidate),
});
const model = z.object({
  requested: z.enum(["deepseek-flash", "deepseek-v4-pro"]),
  returned: z.string().nullable(),
  promptVersion: z.string(), configVersion: z.string(),
  usage: z.object({
    inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
  }).nullable(),
});
const proposal = z.object({
  ...identity, question: z.string(), model,
  filters: runSearchSchema.shape.filters.unwrap(),
});
const scope = z.enum(["selected-runs", "selected-comparison"]);
const measurement = z.object({ label: z.string(), value: z.number(), unit: z.string() });
const receipt = z.string().max(48_000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
const explanation = z.object({
  ...identity, question: z.string(), runIds: runIdsSchema,
  packetVersion: count,
  packet: z.object({
    scope,
    limitations: z.array(z.string()).optional(),
    evidence: z.array(z.object({
      id: z.string(), text: z.string(), status: z.enum(["reported", "derived", "unknown"]),
      numbers: z.array(measurement).optional(),
    })),
  }),
  citations: z.record(z.string(), z.object({
    fieldKey: z.string(),
    sources: z.array(z.object({ runId: z.string(), sourceId: z.string(), locator: z.string() })),
  })),
  explanation: z.object({
    status: z.enum(["supported", "insufficient"]), scope, model: model.nullable(),
    provenance: z.object({
      kind: z.literal("deterministic-evidence"),
      ruleVersion: z.string().min(1),
    }).optional(),
    withheldClaims: z.int().min(1).max(3).optional(),
    claims: z.array(z.object({
      text: z.string(), citationIds: z.array(z.string()), scope,
      citationTargets: z.array(z.object({ citationId: z.string(), runId: z.string() })).optional(),
      status: z.enum(["reported", "derived", "inferred", "insufficient"]),
      measurements: z.array(measurement.extend({ citationId: z.string() })),
    })),
  }),
  explanationReceipt: receipt.nullable(),
});

const chatRunIds = z.array(z.string().regex(/^FLEX-\d{3}$/)).max(3)
  .refine(ids => new Set(ids).size === ids.length);
const chatExplanation = explanation.extend({ question: z.string().trim().min(1).max(500), runIds: chatRunIds.min(1) });
const chatHistory = z.array(z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(500),
})).max(8).refine(messages => messages.reduce((length, { content }) => length + content.length, 0) <= 2_000);
const chatReply = z.string().trim().min(1).max(4_000);
const chatResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), reply: chatReply, model: model.optional() }),
  z.object({ kind: z.literal("clarification"), reply: chatReply }),
  z.object({ kind: z.literal("explanation"), result: chatExplanation }),
  z.object({ kind: z.literal("proposal"), result: proposal.extend({ question: z.string().trim().min(1).max(500) }), reply: chatReply.optional() }),
]);

export type EvidenceOverview = z.infer<typeof overview>;
export type EvidenceSearchResult = z.infer<typeof searchResult>;
export type EvidenceRunResult = z.infer<typeof runResult>;
export type EvidenceSourceResult = z.infer<typeof sourceResult>;
export type EvidenceComparison = z.infer<typeof comparison>;
export type EvidenceRanking = z.infer<typeof ranking>;
export type EvidenceFilterProposal = z.infer<typeof proposal>;
export type EvidenceExplanation = z.infer<typeof explanation> & {
  /** Exact submitted string, before server trimming. */
  requestQuestion: string;
};
export type EvidenceRequestOptions = { signal?: AbortSignal };
export type EvidenceChatMessage = z.infer<typeof chatHistory>[number];
export type EvidenceChatResponse =
  | Exclude<z.infer<typeof chatResponse>, { kind: "explanation" }>
  | { kind: "explanation"; result: EvidenceExplanation };

export function requestedEvidenceAction(question: string): { kind: "source" | "brief"; runId?: string } | undefined {
  const request = question.toLowerCase().trim().replaceAll("’", "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ")
    .replace(/^(?:please |(?:can|could|would|may) (?:you|i|we) (?:please )?)/, "").replace(/,? please$/, "");
  const source = /^(?:show(?: me)?|see|view|open|inspect|(?:where|what) (?:is|are)|what's) (?:the |a |my )?(?:sources?|citations?)(?: for (?:(?:this|that|the last) (?:answer|claim|comparison|result)|(flex-\d{3})))?$/.exec(request);
  if (source) return { kind: "source", runId: source[1]?.toUpperCase() };
  if (/^(?:prepare|make|build|create|open|export|download)(?: me)? (?:an? |the |my )?(?:evidence )?brief(?: for (?:this|that|the last) (?:answer|claim|comparison|result))?$/.test(request)) return { kind: "brief" };
}

export function describeProposedFilter({ key, value }: EvidenceFilterProposal["filters"][number]): string {
  const field = key.replaceAll("_", " ");
  return `${field[0]?.toUpperCase() ?? ""}${field.slice(1)}: ${value ?? "Unknown"}`;
}

const errorMessages = {
  "invalid-selection": "Select two or three distinct runs.",
  "invalid-action": "Check the evidence request and try again.",
  "unknown-run": "A selected run is unavailable in this dataset.",
  "unknown-field": "The requested field is unavailable for this run.",
  "unknown-filter-field": "A filter field is unavailable in this dataset.",
  "invalid-filter-type": "A filter value has the wrong type for its field.",
  "body-too-large": "The evidence request is too large.",
  "explanation-mismatch": "The saved explanation could not be matched to this export.",
  "invalid-response": "The evidence service returned an invalid response.",
  "network-error": "The evidence service could not be reached.",
  "request-failed": "The evidence request failed.",
  aborted: "The evidence request was cancelled.",
  disabled: "DeepSeek is disabled.",
  "not-configured": "DeepSeek is unavailable.",
  "invalid-input": "The explanation or filter proposal request is outside the supported limits.",
  timeout: "DeepSeek timed out.",
  "rate-limit": "DeepSeek is rate limited. Try again later.",
  "budget-exhausted": "The shared DeepSeek allowance is exhausted. You can still browse and compare recorded evidence.",
  "insufficient-balance": "DeepSeek is unavailable.",
  authentication: "DeepSeek is unavailable.",
  network: "DeepSeek could not be reached.",
  service: "DeepSeek could not complete the request.",
  truncated: "DeepSeek returned an incomplete response.",
} as const;
type EvidenceErrorCode = keyof typeof errorMessages;

export class EvidenceClientError extends Error {
  readonly code: EvidenceErrorCode;
  readonly status?: number;

  constructor(code: EvidenceErrorCode, status?: number) {
    super(errorMessages[code]);
    this.name = "EvidenceClientError";
    this.code = code;
    this.status = status;
  }
}

function sameOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validSelection(runIds: readonly string[]) {
  return runIdsSchema.safeParse(runIds).success && runIds.every((id) => id.length <= 128 && id === id.trim());
}

function selection(runIds: readonly string[]) {
  if (!validSelection(runIds)) throw new EvidenceClientError("invalid-selection");
  return { runIds: [...runIds] };
}

/** A share link contains an ordered pair or trio. An absent or invalid link reads as empty. */
export function readEvidenceSelection(url: URL): string[] {
  const runIds = url.searchParams.getAll(selectionParam);
  return validSelection(runIds) ? runIds : [];
}

/** Return a new URL. An empty selection clears the share link parameters. */
export function writeEvidenceSelection(url: URL, runIds: readonly string[]): URL {
  if (runIds.length) selection(runIds);
  const updated = new URL(url);
  updated.searchParams.delete(selectionParam);
  for (const id of runIds) updated.searchParams.append(selectionParam, id);
  return updated;
}

function contentType(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
}

function aborted(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

async function request(action: object | undefined, options: EvidenceRequestOptions = {}) {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: action ? "POST" : "GET",
      headers: action ? { "Content-Type": "application/json" } : undefined,
      body: action ? JSON.stringify(action) : undefined,
      signal: options.signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch (error) {
    throw new EvidenceClientError(aborted(error, options.signal) ? "aborted" : "network-error");
  }
  if (response.ok) return response;
  let code: EvidenceErrorCode = "request-failed";
  if (contentType(response) === "application/json") {
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body && "error" in body && typeof body.error === "string"
        && Object.hasOwn(errorMessages, body.error)) {
        code = body.error === "rate-limit" && "message" in body
          && body.message === "The shared DeepSeek attempt allowance is exhausted."
          ? "budget-exhausted" : body.error as EvidenceErrorCode;
      }
    } catch (error) {
      if (aborted(error, options.signal)) throw new EvidenceClientError("aborted");
    }
  }
  throw new EvidenceClientError(code, response.status);
}

async function requestJson<T>(schema: z.ZodType<T>, action?: object, options?: EvidenceRequestOptions): Promise<T> {
  const response = await request(action, options);
  if (contentType(response) !== "application/json") throw new EvidenceClientError("invalid-response", response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new EvidenceClientError(aborted(error, options?.signal) ? "aborted" : "invalid-response", response.status);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EvidenceClientError("invalid-response", response.status);
  return parsed.data;
}

export function getEvidenceOverview(options?: EvidenceRequestOptions): Promise<EvidenceOverview> {
  return requestJson(overview, undefined, options);
}

export function searchEvidence(search: RunSearchRequest, options?: EvidenceRequestOptions): Promise<EvidenceSearchResult> {
  return requestJson(searchResult, { action: "search", search }, options);
}

export async function getEvidenceRun(runId: string, options?: EvidenceRequestOptions): Promise<EvidenceRunResult> {
  const result = await requestJson(runResult, { action: "run", runId }, options);
  if (result.run.id !== runId.trim()) throw new EvidenceClientError("invalid-response");
  return result;
}

export async function getEvidenceSource(
  runId: string, fieldKey: string, options?: EvidenceRequestOptions,
): Promise<EvidenceSourceResult> {
  const result = await requestJson(sourceResult, { action: "source", runId, fieldKey }, options);
  if (result.runId !== runId.trim() || result.field.key !== fieldKey.trim() || result.source.id !== result.field.sourceId) {
    throw new EvidenceClientError("invalid-response");
  }
  return result;
}

export async function compareEvidence(runIds: readonly string[], options?: EvidenceRequestOptions): Promise<EvidenceComparison> {
  const selected = selection(runIds);
  const result = await requestJson(comparison, { action: "compare", selection: selected }, options);
  if (!sameOrder(selected.runIds, result.runIds) || result.rows.some((row) =>
    !sameOrder(selected.runIds, row.cells.map(({ runId }) => runId)))) {
    throw new EvidenceClientError("invalid-response");
  }
  return result;
}

export async function rankEvidence(
  referenceRunId: string, search?: RunSearchRequest, options?: EvidenceRequestOptions,
): Promise<EvidenceRanking> {
  const result = await requestJson(ranking, { action: "rank", referenceRunId, search }, options);
  if (result.referenceRunId !== referenceRunId.trim()) throw new EvidenceClientError("invalid-response");
  return result;
}

export async function proposeEvidenceFilters(question: string, options?: EvidenceRequestOptions): Promise<EvidenceFilterProposal> {
  const result = await requestJson(proposal, { action: "propose-filters", question, ai: true }, options);
  if (result.question !== question.trim()) throw new EvidenceClientError("invalid-response");
  return result;
}

export async function explainEvidence(
  question: string, runIds: readonly string[], options?: EvidenceRequestOptions,
): Promise<EvidenceExplanation> {
  const selected = selection(runIds);
  const result = await requestJson(explanation, { action: "explain", question, selection: selected, ai: true }, options);
  return bindExplanation(result, question, selected.runIds);
}

function bindExplanation(result: z.infer<typeof explanation>, question: string, runIds: readonly string[]) {
  const { citations, explanation: { claims, provenance } } = result;
  const invalidCitations = claims.some(({ citationIds, citationTargets }) => {
    if (citationIds.some((id) => !Object.hasOwn(citations, id))) return true;
    if (citationTargets?.some(({ citationId, runId }) =>
        !citationIds.includes(citationId) || !runIds.includes(runId)
        || !citations[citationId]?.sources.some((source) => source.runId === runId))) return true;
    return provenance?.kind === "deterministic-evidence" && citationIds.some((id) =>
      citations[id].sources.length > 0 && !citationTargets?.some((target) => target.citationId === id));
  });
  if (result.question !== question.trim() || !sameOrder(runIds, result.runIds) || invalidCitations) {
    throw new EvidenceClientError("invalid-response");
  }
  return { ...result, requestQuestion: question };
}

function bindChatResponse(response: z.infer<typeof chatResponse>): EvidenceChatResponse {
  if (response.kind === "explanation") {
    const { result } = response;
    return { kind: "explanation", result: bindExplanation(result, result.question, result.runIds) };
  }
  return response;
}

export function restoreEvidenceChatResponse(response: unknown) {
  return bindChatResponse(chatResponse.parse(response));
}

export async function sendEvidenceChat(
  input: { question: string; runIds: readonly string[]; history: readonly EvidenceChatMessage[]; historyRunIds?: readonly string[] },
  options?: EvidenceRequestOptions,
): Promise<EvidenceChatResponse> {
  const { question, runIds, history, historyRunIds } = input;
  const selected = chatRunIds.safeParse(runIds);
  const previous = chatRunIds.optional().safeParse(historyRunIds);
  const recent = chatHistory.safeParse(history);
  const trimmed = question.trim();
  if (!selected.success || !previous.success || !recent.success || !trimmed || trimmed.length > 500) {
    throw new EvidenceClientError("invalid-input");
  }
  const response = await requestJson(chatResponse, {
    action: "chat", ai: true, question: trimmed, runIds: selected.data, history: recent.data, historyRunIds: previous.data,
  }, options);
  return bindChatResponse(response);
}

const formats = {
  json: { mime: "application/json", filename: "fire-evidence-brief.json" },
  csv: { mime: "text/csv", filename: "fire-evidence-brief.csv" },
  brief: { mime: "text/html", filename: "fire-evidence-brief.html" },
} as const;

export type EvidenceExportFormat = keyof typeof formats;
export type EvidenceExportInput = {
  format: EvidenceExportFormat;
  runIds: readonly string[];
  question?: string;
  search?: RunSearchRequest;
  explanation?: EvidenceExplanation | null;
  requireExplanation?: boolean;
};
export type EvidenceDownload = {
  blob: Blob;
  filename: string;
  explanationStatus: "included" | "not-requested" | "omitted-mismatch" | "omitted-rejected";
};

export async function fetchEvidenceExport(
  input: EvidenceExportInput, options?: EvidenceRequestOptions,
): Promise<EvidenceDownload> {
  const { format, question, search, runIds, explanation: prior, requireExplanation } = input;
  const matchingReceipt = prior && question !== undefined && prior.requestQuestion === question
    && prior.question === question.trim() && sameOrder(prior.runIds, runIds)
    && receipt.safeParse(prior.explanationReceipt).success ? prior.explanationReceipt : null;
  if (requireExplanation && !matchingReceipt) throw new EvidenceClientError("explanation-mismatch");
  const selected = matchingReceipt && runIds.length === 1 ? { runIds: chatRunIds.parse(runIds) } : selection(runIds);
  const action = { action: "export", format, question, search, selection: selected };
  let explanationStatus: EvidenceDownload["explanationStatus"] = matchingReceipt ? "included"
    : prior ? "omitted-mismatch" : "not-requested";
  let response: Response;
  try {
    response = await request({ ...action, explanationReceipt: matchingReceipt ?? undefined }, options);
  } catch (error) {
    if (requireExplanation || !matchingReceipt || !(error instanceof EvidenceClientError)
      || error.status !== 409 || error.code !== "explanation-mismatch") throw error;
    explanationStatus = "omitted-rejected";
    response = await request(action, options);
  }
  const { mime, filename } = formats[format];
  if (contentType(response) !== mime) throw new EvidenceClientError("invalid-response", response.status);
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    throw new EvidenceClientError(aborted(error, options?.signal) ? "aborted" : "invalid-response", response.status);
  }
  if (!blob.size) throw new EvidenceClientError("invalid-response", response.status);
  return { blob, filename, explanationStatus };
}

export async function downloadEvidence(input: EvidenceExportInput, options?: EvidenceRequestOptions): Promise<EvidenceDownload> {
  const result = await fetchEvidenceExport(input, options);
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(result.blob);
  link.href = objectUrl;
  link.download = result.filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return result;
}
