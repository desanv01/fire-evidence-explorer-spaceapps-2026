import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  compareRuns, comparisonRequestSchema, comparisonRuleVersion, runSearchSchema, searchRuns, type Dataset,
  type ComparisonResult, type RunSearchRequest,
} from "./evidence.ts";
import { rankCandidates, rankingRuleVersion } from "./evidence-ranking.ts";
import {
  DeepSeekError, explainEvidence, replyToConversation, suggestFilters,
  type DeepSeekOptions, type EvidenceFollowUp,
} from "./deepseek.ts";
import { chatRequestSchema, explainRecordedBurnTime, resolveEvidenceChat } from "./evidence-chat.ts";
import { explainSelectedFlexEvidence } from "./evidence-explanation.ts";
import {
  buildEvidenceExport, exportEvidenceCsv, exportEvidenceJson, exportPrintableBrief, type DatasetProvenance,
} from "./evidence-export.ts";
import {
  buildExplanationPacket, createExplanationReceipt, explanationIdentity, readExplanationReceipt, selectEvidenceSnapshot,
} from "./evidence-packet.ts";

const maxBodyBytes = 64 * 1024;
const question = z.string().trim().min(1).max(500);
const shortId = z.string().trim().min(1).max(128);
const exportSelection = z.union([comparisonRequestSchema, z.strictObject({ runIds: z.tuple([shortId]) })]);
const actions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("search"), search: runSearchSchema }),
  z.strictObject({ action: z.literal("run"), runId: shortId }),
  z.strictObject({ action: z.literal("source"), runId: shortId, fieldKey: shortId }),
  z.strictObject({ action: z.literal("compare"), selection: comparisonRequestSchema }),
  z.strictObject({ action: z.literal("rank"), referenceRunId: shortId, search: runSearchSchema.optional() }),
  z.strictObject({ action: z.literal("propose-filters"), question, ai: z.literal(true) }),
  z.strictObject({ action: z.literal("explain"), question, selection: comparisonRequestSchema, ai: z.literal(true) }),
  chatRequestSchema,
  z.strictObject({
    action: z.literal("export"),
    format: z.enum(["json", "csv", "brief"]),
    question: question.optional(),
    selection: exportSelection,
    search: runSearchSchema.optional(),
    explanationReceipt: z.string().max(48_000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/).optional(),
  }),
]);

type EvidenceApiOptions = {
  dataset: Dataset;
  datasetSha256: string;
  datasetProvenance?: DatasetProvenance;
  deepSeek?: DeepSeekOptions;
};

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders });
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readAction(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "expected-json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBodyBytes) {
    throw new RequestError(413, "body-too-large");
  }
  if (!request.body) throw new RequestError(400, "invalid-json");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
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
    return actions.parse(JSON.parse(chunks.join("")));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof z.ZodError) throw new RequestError(400, "invalid-action");
    void reader.cancel().catch(() => undefined);
    throw new RequestError(400, "invalid-json");
  } finally {
    reader.releaseLock();
  }
}

function proposedFieldValues(dataset: Dataset) {
  const values = new Map<string, Set<string | number>>();
  for (const { fields } of dataset.runs) {
    for (const { key, value } of fields) {
      if (value === null) continue;
      const existing = values.get(key) ?? new Set<string | number>();
      existing.add(value);
      values.set(key, existing);
    }
  }
  return Object.fromEntries([...values].map(([key, allowed]) => [key, [...allowed]]));
}

function validateFilters(dataset: Dataset, search: RunSearchRequest) {
  for (const { key, value } of search.filters ?? []) {
    const fields = dataset.runs.flatMap((run) => run.fields.filter((field) => field.key === key));
    if (!fields.length) throw new RequestError(400, "unknown-filter-field");
    if (value !== null && !fields.some((field) => field.value !== null && typeof field.value === typeof value)) {
      throw new RequestError(400, "invalid-filter-type");
    }
  }
}

function getComparison(dataset: Dataset, selection: { runIds: string[] }) {
  try {
    return compareRuns(dataset, selection);
  } catch (error) {
    if (error instanceof RangeError) throw new RequestError(404, "unknown-run");
    throw error;
  }
}

const exportFormats = {
  json: { type: "application/json", extension: "json", render: exportEvidenceJson },
  csv: { type: "text/csv", extension: "csv", render: exportEvidenceCsv },
  brief: { type: "text/html", extension: "html", render: exportPrintableBrief },
};

export async function handleEvidenceRequest(request: Request, options: EvidenceApiOptions): Promise<Response> {
  const { dataset, datasetSha256, datasetProvenance, deepSeek } = options;
  const identity = { datasetVersion: dataset.version, datasetSha256, comparisonRuleVersion };
  const providerOptions = { ...deepSeek, signal: request.signal };

  async function propose(question: string) {
    const proposal = await suggestFilters(question, proposedFieldValues(dataset), providerOptions);
    return {
      ...identity, question, model: proposal.model,
      filters: Object.entries(proposal.filters).map(([key, value]) => ({ key, value })),
    };
  }

  async function explain(
    question: string, comparison: ComparisonResult, burnTime?: "order" | "reason", followUp?: EvidenceFollowUp,
  ) {
    const context = buildExplanationPacket(comparison);
    const explanation = explainSelectedFlexEvidence(question, comparison, context)
      ?? (burnTime ? explainRecordedBurnTime(comparison, context, burnTime) : null)
      ?? await explainEvidence(question, context.packet, {
        ...providerOptions, selectedRunIds: comparison.runIds, followUp,
      });
    const key = (deepSeek?.env ?? process.env).DEEPSEEK_API_KEY?.trim();
    const fingerprint = explanationIdentity(datasetSha256, question, comparison, context);
    const explanationReceipt = key ? createExplanationReceipt(fingerprint, explanation, key) : null;
    return { ...identity, runIds: comparison.runIds, question, ...context, explanation, explanationReceipt };
  }

  try {
    const input = await readAction(request);
    switch (input.action) {
      case "search":
        validateFilters(dataset, input.search);
        return json({ ...identity, search: input.search, runs: searchRuns(dataset, input.search) });
      case "run":
      case "source": {
        const run = dataset.runs.find(({ id }) => id === input.runId);
        if (!run) throw new RequestError(404, "unknown-run");
        if (input.action === "run") return json({ ...identity, run });
        const field = run.fields.find(({ key }) => key === input.fieldKey);
        if (!field) throw new RequestError(404, "unknown-field");
        const source = dataset.sources.find(({ id }) => id === field.sourceId);
        return json({ ...identity, runId: run.id, field, source, provenance: datasetProvenance });
      }
      case "compare":
        return json({ ...getComparison(dataset, input.selection), datasetSha256 });
      case "rank": {
        if (input.search) validateFilters(dataset, input.search);
        const candidates = rankCandidates(dataset, input.referenceRunId, input.search);
        if (candidates === null) throw new RequestError(404, "unknown-run");
        return json({ ...identity, rankingRuleVersion, referenceRunId: input.referenceRunId, search: input.search, candidates });
      }
      case "propose-filters":
        return json(await propose(input.question));
      case "explain":
        return json(await explain(input.question, getComparison(dataset, input.selection)));
      case "chat": {
        const log = (deepSeek?.env ?? process.env).EVIDENCE_CHAT_DIAGNOSTICS === "true";
        const requestId = log ? randomUUID() : undefined;
        const start = Date.now();
        let mode = "unresolved";
        let errorCode: string | undefined;
        try {
          if (request.signal.aborted) throw new DeepSeekError("aborted");
          const dispatch = resolveEvidenceChat(input, dataset);
          mode = dispatch.kind;
          switch (dispatch.kind) {
            case "conversation":
            case "clarification":
              return json(dispatch);
            case "dialogue":
              return json({ kind: "conversation",
                ...await replyToConversation(dispatch.question, dispatch.history, providerOptions, dispatch.background) });
            case "proposal":
              return json({ kind: "proposal", result: await propose(dispatch.question) });
            case "explanation":
              return json({ kind: "explanation", result: await explain(dispatch.question,
                selectEvidenceSnapshot(dataset, dispatch.runIds), dispatch.burnTime, dispatch.followUp) });
          }
          throw new Error("Unsupported chat dispatch");
        } catch (error) {
          errorCode = error instanceof DeepSeekError || error instanceof RequestError ? error.code : "internal-error";
          throw error;
        } finally {
          if (log) console.info("Evidence chat", { requestId, mode, durationMs: Date.now() - start, errorCode });
        }
      }
      case "export": {
        if (input.search) validateFilters(dataset, input.search);
        if (input.selection.runIds.some((id) => !dataset.runs.some((run) => run.id === id))) {
          throw new RequestError(404, "unknown-run");
        }
        let ai;
        if (input.explanationReceipt) {
          const key = (deepSeek?.env ?? process.env).DEEPSEEK_API_KEY?.trim();
          if (!key || !input.question) throw new RequestError(409, "explanation-mismatch");
          const comparison = selectEvidenceSnapshot(dataset, input.selection.runIds);
          const context = buildExplanationPacket(comparison);
          const fingerprint = explanationIdentity(datasetSha256, input.question, comparison, context);
          const explanation = readExplanationReceipt(input.explanationReceipt, fingerprint, key);
          if (!explanation) throw new RequestError(409, "explanation-mismatch");
          ai = { ...context, explanation };
        }
        const evidence = buildEvidenceExport({ ...input, dataset });
        const { type, extension, render } = exportFormats[input.format];
        return new Response(render({ ...evidence, datasetSha256, datasetProvenance, ai }), {
          headers: {
            ...responseHeaders,
            "Content-Type": `${type}; charset=utf-8`,
            "Content-Disposition": `attachment; filename="fire-evidence-brief.${extension}"`,
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    if (error instanceof DeepSeekError) {
      const status = error.code === "aborted" ? 408
        : error.code === "timeout" ? 504
        : error.code === "rate-limit" ? 429
        : error.code === "disabled" || error.code === "not-configured" ? 503 : 502;
      return json({ error: error.code, message: error.message }, status);
    }
    return json({ error: "internal-error" }, 500);
  }
}
