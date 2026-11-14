import { z } from "zod";
import type { EvidenceExplanation } from "../evidence-client.ts";
import { runSearchSchema, type Dataset, type RunSearchRequest } from "../evidence.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetHashSchema,
  datasetVersionSchema,
  displayCitationIdSchema,
  resolveStableFieldReference,
  stableFieldReferenceSchema,
  type CorpusValidationIssue,
} from "./provenance.ts";
import {
  analysisRunIdsSchema,
  validateSearchAgainstDataset,
} from "./scope.ts";
import { plotResultSchema, plotSpecSchema, validatePlotResultAgainstDataset } from "./plot.ts";
import {
  selectedRunsContextRequestSchema,
  selectedRunsContextResultSchema,
} from "./comparison-context.ts";
import { upgradeContractVersions } from "./versions.ts";
import { fieldKeySchema } from "./field-catalog.ts";

export const notebookLimits = {
  maxSteps: 50,
  maxTitleLength: 160,
  maxQuestionLength: 2_000,
  maxNoteLength: 4_000,
  maxNotes: 200,
  maxStepSourceReferences: 256,
  maxLimitations: 12,
  maxLimitationLength: 500,
  /** U05 must enforce this before JSON parsing. Zod never sees file bytes. */
  importMaxBytes: 2 * 1024 * 1024,
} as const;

export const notebookImportMaxBytes = notebookLimits.importMaxBytes;
export const notebookStepMaxCount = notebookLimits.maxSteps;

const nonBlank = z.string().min(1).refine((text) => text.trim().length > 0, "Expected non-blank text");
const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const limitationSchema = z.string().min(1).max(notebookLimits.maxLimitationLength);

export const notebookIdSchema = identifierSchema;
export const notebookStepIdSchema = identifierSchema;
export const notebookNoteIdSchema = identifierSchema;
export type NotebookTimestamp = z.infer<typeof timestampSchema>;

export const notebookQueryContextSchema = z.strictObject({
  search: runSearchSchema.nullable(),
});
export type NotebookQueryContext = z.infer<typeof notebookQueryContextSchema>;

function sameSearchRequest(left: RunSearchRequest | null, right: RunSearchRequest | null): boolean {
  if (left === null || right === null) return left === right;
  const leftFilters = left.filters ?? [];
  const rightFilters = right.filters ?? [];
  return left.query === right.query
    && left.investigation === right.investigation
    && leftFilters.length === rightFilters.length
    && leftFilters.every((filter, index) => (
      filter.key === rightFilters[index]?.key && filter.value === rightFilters[index]?.value
    ));
}

export const notebookLimitationsSchema = z.array(limitationSchema)
  .min(1)
  .max(notebookLimits.maxLimitations);

/** Personal notes are persisted separately from immutable evidence snapshots. */
export const notebookNoteSchema = z.strictObject({
  noteId: notebookNoteIdSchema,
  text: z.string().trim().min(1).max(notebookLimits.maxNoteLength),
  classification: z.literal("personal-note"),
  verifiedEvidence: z.literal(false),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((note, context) => {
  if (Date.parse(note.createdAt) > Date.parse(note.updatedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "Note update time precedes creation" });
  }
});
export type NotebookNote = z.infer<typeof notebookNoteSchema>;

export const notebookNoteLabel = "Personal note";

const evidenceNumberSchema = z.strictObject({
  label: z.string().min(1).max(100),
  value: z.number().finite(),
  unit: z.string().max(40),
});

const evidenceItemSchema = z.strictObject({
  id: displayCitationIdSchema,
  status: z.enum(["reported", "derived", "unknown"]),
  text: z.string().min(1).max(1_000),
  numbers: z.array(evidenceNumberSchema).max(12).optional(),
}).superRefine((item, context) => {
  if (item.status === "unknown" && item.numbers !== undefined) {
    context.addIssue({ code: "custom", path: ["numbers"], message: "Unknown evidence cannot carry numbers" });
  }
});

export const evidencePacketSnapshotSchema = z.strictObject({
  scope: z.enum(["selected-runs", "selected-comparison"]),
  evidence: z.array(evidenceItemSchema).max(16),
  limitations: z.array(z.string().min(1).max(300)).max(8).optional(),
}).superRefine((packet, context) => {
  if (new Set(packet.evidence.map(({ id }) => id)).size !== packet.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be distinct" });
  }
});
export type EvidencePacketSnapshot = z.infer<typeof evidencePacketSnapshotSchema>;

export const citationSourceSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  sourceId: z.string().min(1).max(128),
  locator: z.string().min(1).max(500),
});
export type CitationSource = z.infer<typeof citationSourceSchema>;

export const citationSnapshotSchema = z.strictObject({
  fieldKey: fieldKeySchema,
  sources: z.array(citationSourceSchema).max(8),
});
export type CitationSnapshot = z.infer<typeof citationSnapshotSchema>;

export const deepSeekModelSnapshotSchema = z.strictObject({
  requested: z.enum(["deepseek-flash", "deepseek-v4-pro"]),
  returned: z.string().max(80).nullable(),
  promptVersion: z.string().min(1).max(64),
  configVersion: z.string().min(1).max(64),
  usage: z.strictObject({
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
  }).nullable(),
});
export type DeepSeekModelSnapshot = z.infer<typeof deepSeekModelSnapshotSchema>;

export const evidenceClaimSnapshotSchema = z.strictObject({
  text: z.string().min(1).max(360),
  citationIds: z.array(displayCitationIdSchema).max(4)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct citation IDs"),
  citationTargets: z.array(z.strictObject({
    citationId: displayCitationIdSchema,
    runId: canonicalRunIdSchema,
  })).max(12).optional(),
  status: z.enum(["reported", "derived", "inferred", "insufficient"]),
  scope: z.enum(["selected-runs", "selected-comparison"]),
  measurements: z.array(evidenceNumberSchema.extend({
    citationId: displayCitationIdSchema,
  })).max(48),
});
export type EvidenceClaimSnapshot = z.infer<typeof evidenceClaimSnapshotSchema>;

export const deepSeekExplanationSnapshotSchema = z.strictObject({
  status: z.enum(["supported", "insufficient"]),
  scope: z.enum(["selected-runs", "selected-comparison"]),
  claims: z.array(evidenceClaimSnapshotSchema).min(1).max(4),
  withheldClaims: z.int().min(1).max(3).optional(),
  provenance: z.strictObject({
    kind: z.literal("deterministic-evidence"),
    ruleVersion: z.string().min(1).max(64),
  }).optional(),
  model: deepSeekModelSnapshotSchema.nullable(),
});
export type DeepSeekExplanationSnapshot = z.infer<typeof deepSeekExplanationSnapshotSchema>;

/** Matches the existing answer receipt format; parsing never verifies the signature. */
export const explanationReceiptSchema = z.string().max(48_000)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
export type ExplanationReceipt = z.infer<typeof explanationReceiptSchema>;

export const evidenceAnswerSnapshotSchema = z.strictObject({
  datasetVersion: datasetVersionSchema,
  datasetSha256: datasetHashSchema.nullable(),
  comparisonRuleVersion: z.string().min(1).max(64),
  /** Exact submitted text, retained so receipt/answer binding is not lost. */
  requestQuestion: z.string().max(500).refine((text) => text.trim().length > 0, "Question must not be blank"),
  /** Server-trimmed question stored in the existing evidence result. */
  question: z.string().trim().min(1).max(500),
  runIds: analysisRunIdsSchema,
  packetVersion: z.int().nonnegative(),
  packet: evidencePacketSnapshotSchema,
  citations: z.record(displayCitationIdSchema, citationSnapshotSchema),
  explanation: deepSeekExplanationSnapshotSchema,
  explanationReceipt: explanationReceiptSchema.nullable(),
  /**
   * A schema parse validates receipt syntax only. Cryptographic verification
   * remains with the existing server-side validator and signing key.
   */
  receiptVerification: z.literal("not-verified"),
}).superRefine((answer, context) => {
  const expectedScope = answer.runIds.length === 1 ? "selected-runs" : "selected-comparison";
  if (answer.packet.scope !== expectedScope) {
    context.addIssue({ code: "custom", path: ["packet", "scope"], message: "Packet scope does not match run count" });
  }
  if (answer.explanation.scope !== expectedScope) {
    context.addIssue({
      code: "custom",
      path: ["explanation", "scope"],
      message: "Explanation scope does not match run count",
    });
  }
  for (const [claimIndex, claim] of answer.explanation.claims.entries()) {
    if (claim.scope !== expectedScope) {
      context.addIssue({
        code: "custom",
        path: ["explanation", "claims", claimIndex, "scope"],
        message: "Claim scope does not match run count",
      });
    }
    for (const [citationIndex, citationId] of claim.citationIds.entries()) {
      if (!Object.hasOwn(answer.citations, citationId)) {
        context.addIssue({
          code: "custom",
          path: ["explanation", "claims", claimIndex, "citationIds", citationIndex],
          message: "Citation ID is absent from the answer citations",
        });
      }
    }
    for (const [targetIndex, target] of (claim.citationTargets ?? []).entries()) {
      if (!claim.citationIds.includes(target.citationId)) {
        context.addIssue({
          code: "custom",
          path: ["explanation", "claims", claimIndex, "citationTargets", targetIndex],
          message: "Citation target is not cited by the claim",
        });
      }
      if (!answer.runIds.includes(target.runId)) {
        context.addIssue({
          code: "custom",
          path: ["explanation", "claims", claimIndex, "citationTargets", targetIndex, "runId"],
          message: "Citation target run is outside the answer scope",
        });
      }
      if (!answer.citations[target.citationId]?.sources.some(({ runId }) => runId === target.runId)) {
        context.addIssue({
          code: "custom",
          path: ["explanation", "claims", claimIndex, "citationTargets", targetIndex],
          message: "Citation target has no matching source",
        });
      }
    }
    if (answer.explanation.provenance?.kind === "deterministic-evidence") {
      for (const citationId of claim.citationIds) {
        const citation = answer.citations[citationId];
        if (citation?.sources.length && !claim.citationTargets?.some(({ citationId: id }) => id === citationId)) {
          context.addIssue({
            code: "custom",
            path: ["explanation", "claims", claimIndex, "citationTargets"],
            message: "Deterministic answers need explicit citation targets",
          });
        }
      }
    }
  }
});
export type EvidenceAnswerSnapshot = z.infer<typeof evidenceAnswerSnapshotSchema>;

const notebookStepBase = {
  stepId: notebookStepIdSchema,
  createdAt: timestampSchema,
  title: nonBlank.max(notebookLimits.maxTitleLength),
  datasetVersion: datasetVersionSchema,
  resolvedRunIds: z.array(canonicalRunIdSchema).min(1).max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct resolved run IDs"),
  query: notebookQueryContextSchema,
  sourceReferences: z.array(stableFieldReferenceSchema).max(notebookLimits.maxStepSourceReferences),
  limitations: notebookLimitationsSchema,
};

export const plotNotebookStepSchema = z.strictObject({
  ...notebookStepBase,
  stepType: z.literal("plot"),
  plotSpec: plotSpecSchema,
  plotResult: plotResultSchema,
}).superRefine((step, context) => {
  if (step.datasetVersion !== step.plotResult.datasetVersion) {
    context.addIssue({ code: "custom", path: ["datasetVersion"], message: "Step and plot result versions differ" });
  }
  if (step.resolvedRunIds.length !== step.plotResult.resolvedRunIds.length
    || step.resolvedRunIds.some((runId, index) => runId !== step.plotResult.resolvedRunIds[index])) {
    context.addIssue({ code: "custom", path: ["resolvedRunIds"], message: "Step runs differ from plot result runs" });
  }
  if (!sameSearchRequest(step.query.search, step.plotResult.scope.search)) {
    context.addIssue({ code: "custom", path: ["query", "search"], message: "Step query differs from the plot scope" });
  }});
export type PlotNotebookStep = z.infer<typeof plotNotebookStepSchema>;

export const comparisonNotebookStepSchema = z.strictObject({
  ...notebookStepBase,
  stepType: z.literal("comparison"),
  request: selectedRunsContextRequestSchema,
  context: selectedRunsContextResultSchema,
}).superRefine((step, context) => {
  if (step.datasetVersion !== step.context.datasetVersion) {
    context.addIssue({ code: "custom", path: ["datasetVersion"], message: "Step and context versions differ" });
  }
  if (step.request.runIds.length !== step.context.runIds.length
    || step.request.runIds.some((runId, index) => runId !== step.context.runIds[index])) {
    context.addIssue({
      code: "custom",
      path: ["request", "runIds"],
      message: "Request and context run order or length differ",
    });
  }
  if (step.resolvedRunIds.length !== step.context.runIds.length
    || step.resolvedRunIds.some((runId, index) => runId !== step.context.runIds[index])) {
    context.addIssue({ code: "custom", path: ["resolvedRunIds"], message: "Step runs differ from context runs" });
  }
});
export type ComparisonNotebookStep = z.infer<typeof comparisonNotebookStepSchema>;

export const evidenceAnswerNotebookStepSchema = z.strictObject({
  ...notebookStepBase,
  stepType: z.literal("evidence-answer"),
  answer: evidenceAnswerSnapshotSchema,
}).superRefine((step, context) => {
  if (step.datasetVersion !== step.answer.datasetVersion) {
    context.addIssue({ code: "custom", path: ["datasetVersion"], message: "Step and answer versions differ" });
  }
  if (step.resolvedRunIds.length !== step.answer.runIds.length
    || step.resolvedRunIds.some((runId, index) => runId !== step.answer.runIds[index])) {
    context.addIssue({ code: "custom", path: ["resolvedRunIds"], message: "Step runs differ from answer runs" });
  }
});
export type EvidenceAnswerNotebookStep = z.infer<typeof evidenceAnswerNotebookStepSchema>;

export const notebookStepSchema = z.discriminatedUnion("stepType", [
  plotNotebookStepSchema,
  comparisonNotebookStepSchema,
  evidenceAnswerNotebookStepSchema,
]);
export type NotebookStep = z.infer<typeof notebookStepSchema>;

export const notebookSchema = z.strictObject({
  schemaVersion: z.literal(upgradeContractVersions.notebook),
  id: notebookIdSchema,
  title: nonBlank.max(notebookLimits.maxTitleLength),
  question: z.string().trim().max(notebookLimits.maxQuestionLength),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  datasetVersions: z.array(datasetVersionSchema).min(1).max(50)
    .refine((versions) => new Set(versions).size === versions.length, "Use distinct dataset versions"),
  steps: z.array(notebookStepSchema).max(notebookLimits.maxSteps),
  notes: z.array(notebookNoteSchema).max(notebookLimits.maxNotes),
  /** Optional metadata only; a content difference hash is not a signature. */
  integrity: z.strictObject({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    hashMeaning: z.literal("content-difference-only"),
    receiptVerification: z.literal("not-verified"),
  }).optional(),
}).superRefine((notebook, context) => {
  if (Date.parse(notebook.createdAt) > Date.parse(notebook.updatedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "Notebook update time precedes creation" });
  }
  const stepIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const [index, step] of notebook.steps.entries()) {
    if (stepIds.has(step.stepId)) {
      context.addIssue({ code: "custom", path: ["steps", index, "stepId"], message: "Duplicate step ID" });
    }
    stepIds.add(step.stepId);
    if (!notebook.datasetVersions.includes(step.datasetVersion)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "datasetVersion"],
        message: "Step version is absent from notebook datasetVersions",
      });
    }
    for (const [referenceIndex, reference] of step.sourceReferences.entries()) {
      if (reference.datasetVersion !== step.datasetVersion) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "sourceReferences", referenceIndex, "datasetVersion"],
          message: "Source reference version differs from the step version",
        });
      }
    }
  }
  for (const [index, note] of notebook.notes.entries()) {
    if (noteIds.has(note.noteId)) {
      context.addIssue({ code: "custom", path: ["notes", index, "noteId"], message: "Duplicate note ID" });
    }
    noteIds.add(note.noteId);
  }
});
export type Notebook = z.infer<typeof notebookSchema>;

export const notebookImportEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(upgradeContractVersions.notebookImport),
  /** Metadata only. U05 must call assertNotebookImportBytes on the real bytes first. */
  byteLength: z.int().nonnegative().max(notebookLimits.importMaxBytes),
  verification: z.literal("not-verified"),
  importedAt: timestampSchema,
  notebook: notebookSchema,
});
export type NotebookImportEnvelope = z.infer<typeof notebookImportEnvelopeSchema>;

/** Structural parsing only; it does not verify signatures, versions, or scientific support. */
export function parseNotebook(input: unknown): Notebook {
  return notebookSchema.parse(input);
}

export function safeParseNotebook(input: unknown) {
  return notebookSchema.safeParse(input);
}

/**
 * U05 must enforce the byte limit after reading the file and before
 * JSON.parse. A schema parse cannot observe the original file size.
 */
export function assertNotebookImportBytes(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError("Notebook import size must be a non-negative integer number of bytes");
  }
  if (byteLength > notebookLimits.importMaxBytes) {
    throw new RangeError(`Notebook import exceeds ${notebookLimits.importMaxBytes} bytes`);
  }
}

export function meetsNotebookImportByteLimit(byteLength: number): boolean {
  return Number.isInteger(byteLength) && byteLength >= 0 && byteLength <= notebookLimits.importMaxBytes;
}

export const notebookDatasetVersionStatusSchema = z.enum([
  "same-version",
  "historical-version",
  "unavailable-version",
]);
export type NotebookDatasetVersionStatus = z.infer<typeof notebookDatasetVersionStatusSchema>;

export type NotebookVersionContext = {
  activeDatasetVersion: string;
  /** Versions the app can still validate against (for example, cached corpora). */
  availableDatasetVersions?: readonly string[];
};

export type NotebookVersionReportEntry = {
  datasetVersion: string;
  status: NotebookDatasetVersionStatus;
  stepIds: string[];
};

/**
 * `historical-version` means the version is still available for exact-corpus
 * checks; `unavailable-version` means only the snapshot remains. Neither status
 * rejects the stored run/source identities: old snapshots stay stable.
 */
export function classifyNotebookDatasetVersion(
  datasetVersion: string,
  context: NotebookVersionContext,
): NotebookDatasetVersionStatus {
  if (datasetVersion === context.activeDatasetVersion) return "same-version";
  if (context.availableDatasetVersions?.includes(datasetVersion)) return "historical-version";
  return "unavailable-version";
}

export function notebookDatasetVersionReport(
  notebook: Notebook,
  context: NotebookVersionContext,
): NotebookVersionReportEntry[] {
  const byVersion = new Map<string, string[]>();
  for (const version of notebook.datasetVersions) byVersion.set(version, []);
  for (const step of notebook.steps) {
    const steps = byVersion.get(step.datasetVersion) ?? [];
    steps.push(step.stepId);
    byVersion.set(step.datasetVersion, steps);
  }
  return [...byVersion].map(([datasetVersion, stepIds]) => ({
    datasetVersion,
    status: classifyNotebookDatasetVersion(datasetVersion, context),
    stepIds,
  }));
}

export type NotebookCorpusValidation =
  | {
    status: "version-mismatch";
    datasetVersion: string;
    notebookDatasetVersions: string[];
    issues: [];
  }
  | {
    status: "checked";
    datasetVersion: string;
    checkedStepIds: string[];
    skippedStepIds: string[];
    issues: CorpusValidationIssue[];
  };

/**
 * Validate only the steps whose referenced dataset version equals the supplied
 * dataset. Older-version steps are skipped, not relabelled or rejected; U05
 * can still validate them when an exact historical corpus is available.
 */
export function validateNotebookAgainstDataset(
  notebook: Notebook,
  dataset: Dataset,
): NotebookCorpusValidation {
  const checkedStepIds: string[] = [];
  const skippedStepIds: string[] = [];
  const issues: CorpusValidationIssue[] = [];
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  const knownSourceIds = new Set(dataset.sources.map(({ id }) => id));

  for (const step of notebook.steps) {
    if (step.datasetVersion !== dataset.version) {
      skippedStepIds.push(step.stepId);
      continue;
    }
    checkedStepIds.push(step.stepId);
    for (const [index, runId] of step.resolvedRunIds.entries()) {
      if (!knownRunIds.has(runId)) {
        issues.push(corpusIssue(
          `steps.${step.stepId}.resolvedRunIds.${index}`,
          "unknown-run",
          `Unknown run ID in the referenced corpus: ${runId}`,
        ));
      }
    }
    if (step.query.search !== null) {
      issues.push(...validateSearchAgainstDataset(dataset, step.query.search, `steps.${step.stepId}.query.search`));
    }
    for (const [index, reference] of step.sourceReferences.entries()) {
      if (!knownSourceIds.has(reference.sourceId)) {
        issues.push(corpusIssue(
          `steps.${step.stepId}.sourceReferences.${index}`,
          "unknown-source",
          `Unknown source ID: ${reference.sourceId}`,
        ));
        continue;
      }
      const resolution = resolveStableFieldReference(dataset, reference);
      if (resolution.status !== "resolved") {
        issues.push(corpusIssue(
          `steps.${step.stepId}.sourceReferences.${index}`,
          resolution.status === "dataset-version-mismatch" ? "version-mismatch"
            : resolution.status === "unknown-run" ? "unknown-run"
            : resolution.status === "unknown-field" ? "unknown-field"
            : resolution.status === "unknown-source" ? "unknown-source" : "source-mismatch",
          `Source reference did not resolve: ${reference.runId}/${reference.fieldKey}`,
        ));
      }
    }
    if (step.stepType === "plot") {
      issues.push(...validatePlotResultAgainstDataset(dataset, step.plotResult, `steps.${step.stepId}.plotResult`));
    }
    if (step.stepType === "evidence-answer") {
      for (const [citationId, citation] of Object.entries(step.answer.citations)) {
        for (const [index, source] of citation.sources.entries()) {
          if (!knownRunIds.has(source.runId)) {
            issues.push(corpusIssue(
              `steps.${step.stepId}.answer.citations.${citationId}.${index}.runId`,
              "unknown-run",
              `Unknown citation run ID: ${source.runId}`,
            ));
          }
          const resolution = resolveStableFieldReference(dataset, {
            datasetVersion: step.datasetVersion,
            runId: source.runId,
            fieldKey: citation.fieldKey,
            sourceId: source.sourceId,
          });
          if (resolution.status !== "resolved") {
            issues.push(corpusIssue(
              `steps.${step.stepId}.answer.citations.${citationId}.${index}`,
              resolution.status === "unknown-source" ? "unknown-source" : "source-mismatch",
              `Citation source did not resolve: ${source.runId}/${citation.fieldKey}`,
            ));
          }
        }
      }
    }
  }

  if (!checkedStepIds.length) {
    return {
      status: "version-mismatch",
      datasetVersion: dataset.version,
      notebookDatasetVersions: [...notebook.datasetVersions],
      issues: [],
    };
  }
  return {
    status: "checked",
    datasetVersion: dataset.version,
    checkedStepIds,
    skippedStepIds,
    issues,
  };
}

export type AnswerBindingExpectation = Pick<
  EvidenceExplanation,
  "requestQuestion" | "question" | "runIds"
>;

/**
 * Reproduce the existing client's question/run-order binding check. A true
 * result means the stored binding matches this question and run order; it does
 * not cryptographically verify a receipt or establish scientific support.
 */
export function answerSnapshotBindingMatches(
  answer: EvidenceAnswerSnapshot,
  expected: AnswerBindingExpectation,
): boolean {
  return answer.requestQuestion === expected.requestQuestion
    && answer.question === expected.question.trim()
    && answer.runIds.length === expected.runIds.length
    && answer.runIds.every((runId, index) => runId === expected.runIds[index]);
}

/**
 * Generated prose stays distinguishable from deterministic evidence-only
 * answers. This does not verify either form.
 */
export function answerSnapshotProvenanceClass(
  answer: EvidenceAnswerSnapshot,
): "generated-explanation" | "deterministic-derived" {
  return answer.explanation.provenance?.kind === "deterministic-evidence"
    && answer.explanation.model === null
    ? "deterministic-derived"
    : "generated-explanation";
}

/** Convert answer-local citations into durable field references. */
export function answerSnapshotSourceReferences(answer: EvidenceAnswerSnapshot) {
  const references = new Map<string, z.infer<typeof stableFieldReferenceSchema>>();
  for (const citation of Object.values(answer.citations)) {
    for (const source of citation.sources) {
      const reference = {
        datasetVersion: answer.datasetVersion,
        runId: source.runId,
        fieldKey: citation.fieldKey,
        sourceId: source.sourceId,
      };
      references.set(JSON.stringify([
        reference.datasetVersion,
        reference.runId,
        reference.fieldKey,
        reference.sourceId,
      ]), reference);
    }
  }
  return [...references.values()];
}

