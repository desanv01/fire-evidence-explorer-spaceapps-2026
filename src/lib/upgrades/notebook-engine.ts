/**
 * U05 notebook engine — immutable step snapshots, explicit local save/load and
 * bounded UTF-8 JSON import for the Investigation Notebook.
 *
 * This module is browser-safe: it does not import `node:*`, a provider client,
 * filesystem code or the application route. It never reads `window`,
 * `localStorage` or any storage object at module evaluation time; the browser
 * adapter is created only when its factory is called.
 *
 * Boundaries:
 * - Snapshot builders validate and deep-clone their inputs. The returned steps
 *   are deep-frozen and are never affected by later mutation of the UI objects
 *   that produced them.
 * - Saving and loading are explicit. Importing or loading never writes storage;
 *   only `saveNotebookToStorage` persists a notebook.
 * - Imported content is structurally validated but remains `"not-verified"`.
 *   Receipt signatures are still verified only by the existing server path.
 */
import { z } from "zod";
import type { EvidenceExplanation } from "../evidence-client.ts";
import type { Dataset } from "../evidence.ts";
import type { SelectedRunsContextResult } from "./comparison-context.ts";
import {
  answerSnapshotBindingMatches,
  answerSnapshotSourceReferences,
  assertNotebookImportBytes,
  evidenceAnswerSnapshotSchema,
  notebookDatasetVersionReport,
  notebookImportEnvelopeSchema,
  notebookLimits,
  notebookSchema,
  notebookStepSchema,
  validateNotebookAgainstDataset,
  type EvidenceAnswerNotebookStep,
  type EvidenceAnswerSnapshot,
  type Notebook,
  type NotebookCorpusValidation,
  type NotebookImportEnvelope,
  type NotebookStep,
  type NotebookVersionContext,
  type NotebookVersionReportEntry,
  type PlotNotebookStep,
  type ComparisonNotebookStep,
} from "./notebook.ts";
import { collectPlotSourceReferences, type PlotResult, type PlotSpec } from "./plot.ts";
import {
  stableFieldReferenceKey,
  type CorpusValidationIssue,
  type StableFieldReference,
} from "./provenance.ts";
import { upgradeContractVersions } from "./versions.ts";

/* ------------------------------------------------------------------------- */
/* Shared limits and small helpers                                           */
/* ------------------------------------------------------------------------- */

/** Matches the notebookSchema `datasetVersions` maximum (not exported there). */
const maxNotebookDatasetVersions = 50;

/** Default step limitation copy for an evidence-answer snapshot. */
const evidenceAnswerStepLimitations = [
  "A stored answer preserves the returned explanation; it is not a new verification or a substitute for source inspection.",
  "Receipt syntax is retained, but signature verification remains with the existing server-side validator.",
] as const;

export const notebookStorageKeyPrefix = "fire-evidence:notebook:";

/** Deterministic, namespaced storage key for one notebook identity. */
export function notebookStorageKey(notebookId: string): string {
  return `${notebookStorageKeyPrefix}${notebookId}`;
}

/** UTF-8 byte length of serialized notebook text (never JavaScript length). */
export function measureNotebookBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function zodIssueStrings(error: z.ZodError): string[] {
  return error.issues.slice(0, 50).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as T;
}

/**
 * The contract delivered with U01-A/r1 normalized `requestQuestion` with
 * `.trim()`. The r2 correction preserves the exact submitted JS string. This
 * helper keeps the engine byte-for-byte on the exact text under either schema:
 * a value is restored only when the schema's normalized value is its trimmed
 * form and the exact text still satisfies the 500-character bound.
 */
function restoreExactRequestQuestion(rawStep: unknown, step: NotebookStep): NotebookStep {
  if (step.stepType !== "evidence-answer" || !isRecord(rawStep) || !isRecord(rawStep.answer)) return step;
  const exact = rawStep.answer.requestQuestion;
  if (typeof exact !== "string" || exact === step.answer.requestQuestion) return step;
  if (exact.length > 500 || exact.trim().length < 1 || exact.trim() !== step.answer.requestQuestion) return step;
  return { ...step, answer: { ...step.answer, requestQuestion: exact } };
}

function restoreExactRequestQuestions(rawNotebook: unknown, notebook: Notebook): Notebook {
  if (!isRecord(rawNotebook)) return notebook;
  const rawSteps = rawNotebook.steps;
  if (!Array.isArray(rawSteps)) return notebook;
  let changed = false;
  const steps = notebook.steps.map((step, index) => {
    const restored = restoreExactRequestQuestion(rawSteps[index], step);
    if (restored !== step) changed = true;
    return restored;
  });
  return changed ? { ...notebook, steps } : notebook;
}

function freezeNotebookSteps(notebook: Notebook): Notebook {
  for (const step of notebook.steps) deepFreeze(step);
  return notebook;
}

type ParseNotebookResult =
  | { ok: true; notebook: Notebook }
  | { ok: false; issues: string[]; error: z.ZodError };

/** Structural parse + exact-text preservation + frozen step snapshots. */
function parseNotebookSnapshot(input: unknown): ParseNotebookResult {
  const result = notebookSchema.safeParse(input);
  if (!result.success) return { ok: false, issues: zodIssueStrings(result.error), error: result.error };
  const notebook = freezeNotebookSteps(restoreExactRequestQuestions(input, result.data as Notebook));
  return { ok: true, notebook };
}

function parseNotebookOrThrow(input: unknown): Notebook {
  const result = parseNotebookSnapshot(input);
  if (!result.ok) throw result.error;
  return result.notebook;
}

type ParseStepResult =
  | { ok: true; step: NotebookStep }
  | { ok: false; issues: string[]; error: z.ZodError };

function parseStepSnapshot(input: unknown): ParseStepResult {
  const result = notebookStepSchema.safeParse(input);
  if (!result.success) return { ok: false, issues: zodIssueStrings(result.error), error: result.error };
  const step = deepFreeze(restoreExactRequestQuestion(input, result.data as NotebookStep));
  return { ok: true, step };
}

function parseStepOrThrow(input: unknown): NotebookStep {
  const result = parseStepSnapshot(input);
  if (!result.ok) throw result.error;
  return result.step;
}

function latestTimestamp(...values: (string | undefined)[]): string {
  const defined = values.filter((value): value is string => value !== undefined);
  let latest = defined[0] ?? currentTimestamp();
  let latestMillis = Date.parse(latest);
  for (const value of defined.slice(1)) {
    const millis = Date.parse(value);
    if (Number.isFinite(millis) && (!Number.isFinite(latestMillis) || millis > latestMillis)) {
      latest = value;
      latestMillis = millis;
    }
  }
  return latest;
}

function requireValidTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO date-time string`);
  return value;
}

/* ------------------------------------------------------------------------- */
/* U05.1 — immutable notebook and step snapshots                             */
/* ------------------------------------------------------------------------- */

export type CreateNotebookInput = {
  id: string;
  title: string;
  question?: string;
  datasetVersions: readonly string[];
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Create an empty notebook. `datasetVersions` declares the corpus context; it
 * must contain at least one version (the notebook schema requires it).
 */
export function createNotebook(input: CreateNotebookInput): Notebook {
  const createdAt = input.createdAt ?? currentTimestamp();
  return parseNotebookOrThrow({
    schemaVersion: upgradeContractVersions.notebook,
    id: input.id,
    title: input.title,
    question: input.question ?? "",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    datasetVersions: [...input.datasetVersions],
    steps: [],
    notes: [],
  });
}

type StepMetadataInput = {
  stepId: string;
  title: string;
  createdAt?: string;
};

export type CreatePlotNotebookStepInput = StepMetadataInput & {
  plotSpec: PlotSpec;
  plotResult: PlotResult;
  /** Defaults to the plot result's stable point references. */
  sourceReferences?: readonly StableFieldReference[];
  /** Defaults to the plot result's own limitations. */
  limitations?: readonly string[];
};

/**
 * Snapshot a validated plot result. The dataset version, resolved run order,
 * query scope and source references come from the result itself; no "active"
 * version is substituted.
 */
export function createPlotNotebookStep(input: CreatePlotNotebookStepInput): PlotNotebookStep {
  const { plotResult } = input;
  const step = parseStepOrThrow({
    stepId: input.stepId,
    createdAt: input.createdAt ?? currentTimestamp(),
    title: input.title,
    datasetVersion: plotResult.datasetVersion,
    resolvedRunIds: [...plotResult.resolvedRunIds],
    query: { search: plotResult.scope.search },
    sourceReferences: [...(input.sourceReferences ?? collectPlotSourceReferences(plotResult))],
    limitations: [...(input.limitations ?? plotResult.limitations)],
    stepType: "plot",
    plotSpec: input.plotSpec,
    plotResult,
  });
  return step as PlotNotebookStep;
}

/** Stable source references carried by a selected-runs context result. */
export function collectComparisonSourceReferences(
  context: SelectedRunsContextResult,
): StableFieldReference[] {
  const references = new Map<string, StableFieldReference>();
  for (const field of [...context.conditions, ...context.outcomes]) {
    for (const cell of field.cells) {
      if (cell.reference) references.set(stableFieldReferenceKey(cell.reference), cell.reference);
    }
  }
  for (const evidence of context.evidence) {
    for (const reference of evidence.sourceReferences) {
      references.set(stableFieldReferenceKey(reference), reference);
    }
  }
  return [...references.values()];
}

export type CreateComparisonNotebookStepInput = StepMetadataInput & {
  context: SelectedRunsContextResult;
  /** Defaults to the context's ordered cells and evidence references. */
  sourceReferences?: readonly StableFieldReference[];
  /** Defaults to the context's own limitations. */
  limitations?: readonly string[];
};

/**
 * Snapshot a validated selected-runs context. The request is taken from the
 * context result itself so the ordered run list cannot diverge from it.
 */
export function createComparisonNotebookStep(
  input: CreateComparisonNotebookStepInput,
): ComparisonNotebookStep {
  const { context } = input;
  const step = parseStepOrThrow({
    stepId: input.stepId,
    createdAt: input.createdAt ?? currentTimestamp(),
    title: input.title,
    datasetVersion: context.datasetVersion,
    resolvedRunIds: [...context.runIds],
    query: { search: null },
    sourceReferences: [...(input.sourceReferences ?? collectComparisonSourceReferences(context))],
    limitations: [...(input.limitations ?? context.limitations)],
    stepType: "comparison",
    request: context.request,
    context,
  });
  return step as ComparisonNotebookStep;
}

function isAnswerSnapshot(
  value: EvidenceAnswerSnapshot | EvidenceExplanation,
): value is EvidenceAnswerSnapshot {
  return isRecord(value)
    && (value as { receiptVerification?: unknown }).receiptVerification !== undefined;
}

function restoreExactAnswerRequestQuestion(
  raw: unknown,
  answer: EvidenceAnswerSnapshot,
): EvidenceAnswerSnapshot {
  if (!isRecord(raw)) return answer;
  const exact = raw.requestQuestion;
  if (typeof exact !== "string" || exact === answer.requestQuestion) return answer;
  if (exact.length > 500 || exact.trim().length < 1 || exact.trim() !== answer.requestQuestion) return answer;
  return { ...answer, requestQuestion: exact };
}

/**
 * Convert the existing client answer shape into the notebook answer snapshot.
 * The exact submitted `requestQuestion`, the server-trimmed `question`, the
 * ordered run list and the receipt string are retained. Storage marks the
 * receipt `"not-verified"`; no signature is checked or claimed here.
 */
export function snapshotEvidenceAnswer(
  answer: EvidenceAnswerSnapshot | EvidenceExplanation,
): EvidenceAnswerSnapshot {
  if (isAnswerSnapshot(answer)) {
    const parsed = evidenceAnswerSnapshotSchema.parse(answer);
    return deepFreeze(restoreExactAnswerRequestQuestion(answer, parsed));
  }
  if (!isRecord(answer)) throw new TypeError("Evidence answer must be an object");
  const candidate = {
    datasetVersion: answer.datasetVersion,
    datasetSha256: answer.datasetSha256 ?? null,
    comparisonRuleVersion: answer.comparisonRuleVersion,
    requestQuestion: answer.requestQuestion,
    question: answer.question,
    runIds: [...answer.runIds],
    packetVersion: answer.packetVersion,
    packet: answer.packet,
    citations: answer.citations,
    explanation: answer.explanation,
    explanationReceipt: answer.explanationReceipt,
    receiptVerification: "not-verified" as const,
  };
  const parsed = evidenceAnswerSnapshotSchema.parse(candidate);
  const snapshot = restoreExactAnswerRequestQuestion(candidate, parsed);
  // Existing receipt-binding helper: the snapshot must retain the exact
  // submitted question text and the ordered selected runs. It does not verify
  // the receipt signature.
  if (!answerSnapshotBindingMatches(snapshot, answer)) {
    throw new TypeError("Evidence answer does not preserve the submitted question and run order");
  }
  return deepFreeze(snapshot);
}

export type CreateEvidenceAnswerNotebookStepInput = StepMetadataInput & {
  answer: EvidenceAnswerSnapshot | EvidenceExplanation;
  /** Defaults to the stable field references derived from the answer citations. */
  sourceReferences?: readonly StableFieldReference[];
  limitations?: readonly string[];
};

/** Snapshot a validated evidence answer without sharing the caller's objects. */
export function createEvidenceAnswerNotebookStep(
  input: CreateEvidenceAnswerNotebookStepInput,
): EvidenceAnswerNotebookStep {
  const answer = snapshotEvidenceAnswer(input.answer);
  const step = parseStepOrThrow({
    stepId: input.stepId,
    createdAt: input.createdAt ?? currentTimestamp(),
    title: input.title,
    datasetVersion: answer.datasetVersion,
    resolvedRunIds: [...answer.runIds],
    query: { search: null },
    sourceReferences: [...(input.sourceReferences ?? answerSnapshotSourceReferences(answer))],
    limitations: [...(input.limitations ?? evidenceAnswerStepLimitations)],
    stepType: "evidence-answer",
    answer,
  });
  return step as EvidenceAnswerNotebookStep;
}

export type AppendNotebookStepOptions = {
  /** Defaults to the current time; must be an ISO date-time when provided. */
  now?: string;
};

export type AppendNotebookStepFailureReason =
  | "invalid-notebook"
  | "invalid-step"
  | "duplicate-step-id"
  | "step-limit"
  | "dataset-version-limit"
  | "version-mismatch";

export type AppendNotebookStepResult =
  | {
    ok: true;
    notebook: Notebook;
    /** The validated, frozen step that was appended (last in run order). */
    step: NotebookStep;
    datasetVersionAdded: boolean;
  }
  | {
    ok: false;
    reason: AppendNotebookStepFailureReason;
    message: string;
    issues?: string[];
  };

/**
 * Append one immutable step snapshot. The input notebook, its steps and its
 * notes are not mutated; the returned notebook is a new value that preserves
 * the existing snapshots and notes. Both arguments are re-validated at runtime.
 */
export function appendNotebookStep(
  notebook: Notebook,
  step: NotebookStep,
  options: AppendNotebookStepOptions = {},
): AppendNotebookStepResult {
  const now = options.now === undefined ? currentTimestamp() : requireValidTimestamp(options.now, "now");
  const parsedNotebook = parseNotebookSnapshot(notebook);
  if (!parsedNotebook.ok) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook to update is not valid, so no step was appended.",
      issues: parsedNotebook.issues,
    };
  }
  const parsedStep = parseStepSnapshot(step);
  if (!parsedStep.ok) {
    return {
      ok: false,
      reason: "invalid-step",
      message: "The step snapshot is not valid, so it was not appended.",
      issues: parsedStep.issues,
    };
  }
  const base = parsedNotebook.notebook;
  const appended = parsedStep.step;
  if (base.steps.some(({ stepId }) => stepId === appended.stepId)) {
    return {
      ok: false,
      reason: "duplicate-step-id",
      message: `Step ID already exists in this notebook: ${appended.stepId}`,
    };
  }
  if (base.steps.length >= notebookLimits.maxSteps) {
    return {
      ok: false,
      reason: "step-limit",
      message: `A notebook may contain at most ${notebookLimits.maxSteps} steps.`,
    };
  }
  const datasetVersionAdded = !base.datasetVersions.includes(appended.datasetVersion);
  if (datasetVersionAdded && base.datasetVersions.length >= maxNotebookDatasetVersions) {
    return {
      ok: false,
      reason: "dataset-version-limit",
      message: `A notebook may declare at most ${maxNotebookDatasetVersions} dataset versions.`,
    };
  }
  const rawNotebook = {
    ...base,
    datasetVersions: datasetVersionAdded
      ? [...base.datasetVersions, appended.datasetVersion]
      : [...base.datasetVersions],
    steps: [...base.steps, appended],
    updatedAt: latestTimestamp(base.updatedAt, appended.createdAt, now),
  };
  const updated = parseNotebookSnapshot(rawNotebook);
  if (!updated.ok) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook with the appended step did not validate.",
      issues: updated.issues,
    };
  }
  const appendedStep = updated.notebook.steps[updated.notebook.steps.length - 1];
  if (!appendedStep || appendedStep.stepId !== appended.stepId) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The appended step could not be located in the updated notebook.",
    };
  }
  return { ok: true, notebook: updated.notebook, step: appendedStep, datasetVersionAdded };
}

export type AppendRerunStepOptions = AppendNotebookStepOptions & {
  activeDatasetVersion: string;
};

/**
 * Append a re-run as a separate current-version step. Existing snapshots keep
 * their original version and are never relabelled. A step that does not use the
 * active version is rejected before it reaches the notebook.
 */
export function appendRerunStep(
  notebook: Notebook,
  step: NotebookStep,
  options: AppendRerunStepOptions,
): AppendNotebookStepResult {
  if (!isRecord(step) || step.datasetVersion !== options.activeDatasetVersion) {
    return {
      ok: false,
      reason: "version-mismatch",
      message: "A re-run step must use the active dataset version; saved snapshots keep their original version.",
    };
  }
  return appendNotebookStep(notebook, step, options);
}

/* ------------------------------------------------------------------------- */
/* U05.2 — explicit save/load through a narrow storage adapter               */
/* ------------------------------------------------------------------------- */

/** Narrow storage contract; satisfied by a Web Storage object or a test fake. */
export type NotebookStorage = {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
};

/** Structural subset of the browser `Storage` interface used by the adapter. */
export type NotebookStorageSource = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StorageFailureReason = "unavailable-storage" | "quota-exceeded" | "storage-failure";

/** Adapt an injectable key/value source. Returns null when no source exists. */
export function createNotebookStorage(
  source: NotebookStorageSource | null | undefined,
): NotebookStorage | null {
  if (!source) return null;
  return {
    read: (key) => source.getItem(key),
    write: (key, value) => source.setItem(key, value),
    remove: (key) => source.removeItem(key),
  };
}

function browserStorageSource(): NotebookStorageSource | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

/**
 * Lazily create the browser adapter. `window`/`localStorage` are read at call
 * time, not module evaluation, and an unavailable/denied storage returns null.
 */
export function createBrowserNotebookStorage(
  resolve: () => NotebookStorageSource | null | undefined = browserStorageSource,
): NotebookStorage | null {
  try {
    return createNotebookStorage(resolve());
  } catch {
    return null;
  }
}

function storageErrorName(error: unknown): string {
  if (isRecord(error) && typeof error.name === "string") return error.name;
  return error instanceof Error ? error.name : "";
}

function classifyStorageError(error: unknown): StorageFailureReason {
  const name = storageErrorName(error);
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return "quota-exceeded";
  if (name === "SecurityError" || name === "NotSupportedError" || name === "InvalidStateError") {
    return "unavailable-storage";
  }
  if (isRecord(error)) {
    if (error.code === 22 || error.code === 1014) return "quota-exceeded";
    if (error.code === 18) return "unavailable-storage";
  }
  return "storage-failure";
}

function storageFailureMessage(reason: StorageFailureReason): string {
  if (reason === "quota-exceeded") {
    return "The browser storage quota is full. The previously saved notebook was kept.";
  }
  if (reason === "unavailable-storage") {
    return "Notebook storage is not available in this browser context.";
  }
  return "Notebook storage failed. The previously saved notebook was kept.";
}

function restoreStoredValue(storage: NotebookStorage, key: string, prior: string | null): void {
  try {
    if (prior === null) storage.remove(key);
    else storage.write(key, prior);
  } catch {
    // Best-effort only; the structured save failure is still returned.
  }
}

export type SaveNotebookOptions = {
  /** Defaults to the notebook's namespaced key. */
  key?: string;
};

export type NotebookSaveResult =
  | {
    ok: true;
    key: string;
    notebook: Notebook;
    serializedBytes: number;
  }
  | {
    ok: false;
    reason: StorageFailureReason | "invalid-notebook";
    message: string;
    issues?: string[];
  };

/**
 * Validate, serialize and explicitly persist one notebook. Validation happens
 * before any write; a failed write returns a structured failure and makes a
 * best-effort restoration of the previous stored value.
 */
export function saveNotebookToStorage(
  storage: NotebookStorage | null | undefined,
  notebook: Notebook,
  options: SaveNotebookOptions = {},
): NotebookSaveResult {
  if (!storage) {
    return {
      ok: false,
      reason: "unavailable-storage",
      message: "Notebook storage is not available in this browser context.",
    };
  }
  const parsed = parseNotebookSnapshot(notebook);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook is not valid, so nothing was written.",
      issues: parsed.issues,
    };
  }
  const key = options.key ?? notebookStorageKey(parsed.notebook.id);
  const serialized = JSON.stringify(parsed.notebook);
  const serializedBytes = measureNotebookBytes(serialized);
  let prior: string | null;
  try {
    prior = storage.read(key);
  } catch (error) {
    const reason = classifyStorageError(error);
    return { ok: false, reason, message: storageFailureMessage(reason) };
  }
  try {
    storage.write(key, serialized);
  } catch (error) {
    restoreStoredValue(storage, key, prior);
    const reason = classifyStorageError(error);
    return { ok: false, reason, message: storageFailureMessage(reason) };
  }
  return { ok: true, key, notebook: parsed.notebook, serializedBytes };
}

export type LoadNotebookOptions = {
  /** Defaults to the notebook's namespaced key. */
  key?: string;
  /** When supplied, the result includes the contract's version report. */
  versionContext?: NotebookVersionContext;
};

export type NotebookLoadResult =
  | {
    ok: true;
    key: string;
    notebook: Notebook;
    serializedBytes: number;
    versionReport: NotebookVersionReportEntry[] | null;
  }
  | {
    ok: false;
    reason: StorageFailureReason | "not-found" | "invalid-stored-data";
    message: string;
    issues?: string[];
  };

/**
 * Explicitly read one notebook. Missing, unreadable and invalid stored data are
 * reported structurally; stored text is never rewritten or removed here.
 */
export function loadNotebookFromStorage(
  storage: NotebookStorage | null | undefined,
  notebookId: string,
  options: LoadNotebookOptions = {},
): NotebookLoadResult {
  if (!storage) {
    return {
      ok: false,
      reason: "unavailable-storage",
      message: "Notebook storage is not available in this browser context.",
    };
  }
  const key = options.key ?? notebookStorageKey(notebookId);
  let serialized: string | null;
  try {
    serialized = storage.read(key);
  } catch (error) {
    const reason = classifyStorageError(error);
    return { ok: false, reason, message: storageFailureMessage(reason) };
  }
  if (serialized === null) {
    return { ok: false, reason: "not-found", message: "No saved notebook exists for this workspace." };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return {
      ok: false,
      reason: "invalid-stored-data",
      message: "Stored notebook data is not valid JSON; the existing value was left untouched.",
    };
  }
  const parsed = parseNotebookSnapshot(value);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid-stored-data",
      message: "Stored notebook data is invalid; the existing value was left untouched.",
      issues: parsed.issues,
    };
  }
  if (options.key === undefined && parsed.notebook.id !== notebookId) {
    return {
      ok: false,
      reason: "invalid-stored-data",
      message: "Stored notebook identity does not match the requested notebook.",
    };
  }
  const versionReport = options.versionContext
    ? notebookDatasetVersionReport(parsed.notebook, options.versionContext)
    : null;
  return {
    ok: true,
    key,
    notebook: parsed.notebook,
    serializedBytes: measureNotebookBytes(serialized),
    versionReport,
  };
}

/* ------------------------------------------------------------------------- */
/* U05.3 — bounded UTF-8 JSON import                                         */
/* ------------------------------------------------------------------------- */

export type NotebookImportOptions = {
  versionContext?: NotebookVersionContext;
  /** Exact known corpora, used for membership/source checks when available. */
  datasets?: readonly Dataset[];
};

export type NotebookCorpusCheck = {
  datasetVersion: string;
  status: NotebookCorpusValidation["status"];
  checkedStepIds: string[];
  skippedStepIds: string[];
  issues: CorpusValidationIssue[];
};

export type NotebookCorpusIssue = CorpusValidationIssue & { datasetVersion: string };

export type NotebookVersionAnalysis = {
  /** Null when no active-version context was supplied. */
  report: NotebookVersionReportEntry[] | null;
  corpusChecks: NotebookCorpusCheck[];
  issues: NotebookCorpusIssue[];
  hasMismatch: boolean;
};

/**
 * Exact-corpus validation for every declared version that is actually
 * available, plus the contract version report. Unavailable versions keep their
 * stored snapshot and are reported as `unavailable-version`, never relabelled.
 */
export function analyzeNotebookVersions(
  notebook: Notebook,
  options: NotebookImportOptions = {},
): NotebookVersionAnalysis {
  const datasets = new Map<string, Dataset>();
  for (const dataset of options.datasets ?? []) datasets.set(dataset.version, dataset);
  const corpusChecks: NotebookCorpusCheck[] = [];
  const issues: NotebookCorpusIssue[] = [];
  for (const datasetVersion of notebook.datasetVersions) {
    const dataset = datasets.get(datasetVersion);
    if (!dataset) continue;
    const checked = validateNotebookAgainstDataset(notebook, dataset);
    const check: NotebookCorpusCheck = checked.status === "checked"
      ? {
        datasetVersion,
        status: "checked",
        checkedStepIds: [...checked.checkedStepIds],
        skippedStepIds: [...checked.skippedStepIds],
        issues: [...checked.issues],
      }
      : {
        datasetVersion,
        status: "version-mismatch",
        checkedStepIds: [],
        skippedStepIds: [],
        issues: [...checked.issues],
      };
    corpusChecks.push(check);
    for (const issue of check.issues) issues.push({ ...issue, datasetVersion });
  }
  const availableDatasetVersions = new Set<string>([
    ...(options.versionContext?.availableDatasetVersions ?? []),
    ...datasets.keys(),
  ]);
  const report = options.versionContext
    ? notebookDatasetVersionReport(notebook, {
      activeDatasetVersion: options.versionContext.activeDatasetVersion,
      availableDatasetVersions: [...availableDatasetVersions],
    })
    : null;
  return {
    report,
    corpusChecks,
    issues,
    hasMismatch: report?.some(({ status }) => status !== "same-version") ?? false,
  };
}

export type NotebookImportResult =
  | {
    ok: true;
    notebook: Notebook;
    /** Imported content is never presented as verified evidence. */
    verification: "not-verified";
    source: "notebook" | "import-envelope";
    byteLength: number;
    versionReport: NotebookVersionReportEntry[] | null;
    corpusChecks: NotebookCorpusCheck[];
  }
  | {
    ok: false;
    reason: "too-large" | "invalid-utf8" | "invalid-json" | "invalid-content" | "invalid-corpus";
    message: string;
    byteLength: number;
    issues?: string[] | NotebookCorpusIssue[];
  };

function importFailure(
  reason: "too-large" | "invalid-utf8" | "invalid-json" | "invalid-content",
  message: string,
  byteLength: number,
  issues?: string[],
): NotebookImportResult {
  return issues ? { ok: false, reason, message, byteLength, issues } : { ok: false, reason, message, byteLength };
}

function importSerializedNotebook(
  text: string,
  byteLength: number,
  options: NotebookImportOptions,
): NotebookImportResult {
  try {
    assertNotebookImportBytes(byteLength);
  } catch {
    return importFailure(
      "too-large",
      `Notebook import exceeds the ${notebookLimits.importMaxBytes}-byte (2 MiB) limit.`,
      byteLength,
    );
  }
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return importFailure("invalid-json", "Notebook import is not valid JSON.", byteLength);
  }
  const hasEnvelopeShape = isRecord(value) && "formatVersion" in value;
  if (hasEnvelopeShape) {
    const envelope = notebookImportEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      return importFailure(
        "invalid-content",
        "Notebook import envelope is invalid.",
        byteLength,
        zodIssueStrings(envelope.error),
      );
    }
  }
  const rawNotebook = hasEnvelopeShape ? (value as Record<string, unknown>).notebook : value;
  const parsed = parseNotebookSnapshot(rawNotebook);
  if (!parsed.ok) {
    return importFailure(
      "invalid-content",
      "Notebook import does not satisfy the notebook-1 contract.",
      byteLength,
      parsed.issues,
    );
  }
  const analysis = analyzeNotebookVersions(parsed.notebook, options);
  if (analysis.issues.length) {
    return {
      ok: false,
      reason: "invalid-corpus",
      message: "Notebook import does not match its declared, available dataset version.",
      byteLength,
      issues: analysis.issues,
    };
  }
  return {
    ok: true,
    notebook: parsed.notebook,
    verification: "not-verified",
    source: hasEnvelopeShape ? "import-envelope" : "notebook",
    byteLength,
    versionReport: analysis.report,
    corpusChecks: analysis.corpusChecks,
  };
}

/**
 * Import UTF-8 JSON supplied as text. The actual UTF-8 byte length is measured
 * and checked with the existing byte gate before `JSON.parse`.
 */
export function importNotebookFromText(
  text: string,
  options: NotebookImportOptions = {},
): NotebookImportResult {
  return importSerializedNotebook(text, measureNotebookBytes(text), options);
}

/**
 * Import UTF-8 JSON supplied as bytes. The byte length is checked before
 * decoding or parsing, and invalid UTF-8 is a structured failure.
 */
export function importNotebookFromBytes(
  bytes: Uint8Array | ArrayBuffer,
  options: NotebookImportOptions = {},
): NotebookImportResult {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const byteLength = view.byteLength;
  try {
    assertNotebookImportBytes(byteLength);
  } catch {
    return importFailure(
      "too-large",
      `Notebook import exceeds the ${notebookLimits.importMaxBytes}-byte (2 MiB) limit.`,
      byteLength,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return importFailure("invalid-utf8", "Notebook import is not valid UTF-8.", byteLength);
  }
  return importSerializedNotebook(text, byteLength, options);
}

/**
 * Build the optional import envelope. `verification` is fixed to
 * `"not-verified"`; this helper never claims that content was verified.
 */
export function createNotebookImportEnvelope(
  notebook: Notebook,
  options: { importedAt?: string; byteLength?: number } = {},
): NotebookImportEnvelope {
  const parsed = parseNotebookOrThrow(notebook);
  const envelope = notebookImportEnvelopeSchema.parse({
    formatVersion: upgradeContractVersions.notebookImport,
    byteLength: options.byteLength ?? measureNotebookBytes(JSON.stringify(parsed)),
    verification: "not-verified",
    importedAt: options.importedAt ?? currentTimestamp(),
    notebook: parsed,
  });
  return deepFreeze({ ...envelope, notebook: parsed });
}

/* ------------------------------------------------------------------------- */
/* U05.4 — corpus-version mismatch and retained snapshots                    */
/* ------------------------------------------------------------------------- */

export type NotebookVersionMismatchReport = {
  activeDatasetVersion: string;
  entries: NotebookVersionReportEntry[];
  /** Entries with saved steps whose status is not `same-version`, in step order. */
  mismatchedEntries: NotebookVersionReportEntry[];
  historicalVersions: string[];
  unavailableVersions: string[];
  hasMismatch: boolean;
  /** User-facing summary; null when every step uses the active version. */
  message: string | null;
};

/**
 * Report saved steps that use a different dataset version. The report never
 * changes a stored snapshot; a re-run must append a separate current-version
 * step through `appendRerunStep`/`appendNotebookStep`.
 */
export function reportNotebookVersionMismatch(
  notebook: Notebook,
  versionContext: NotebookVersionContext,
): NotebookVersionMismatchReport {
  const entries = notebookDatasetVersionReport(notebook, versionContext);
  // Declared versions without saved steps are corpus metadata, not a saved
  // snapshot mismatch. Any version that actually carries a step is reported.
  const mismatchedEntries = entries.filter(({ status, stepIds }) => (
    status !== "same-version" && stepIds.length > 0
  ));
  const historicalVersions = mismatchedEntries
    .filter(({ status }) => status === "historical-version")
    .map(({ datasetVersion }) => datasetVersion);
  const unavailableVersions = mismatchedEntries
    .filter(({ status }) => status === "unavailable-version")
    .map(({ datasetVersion }) => datasetVersion);
  const stepCount = mismatchedEntries.reduce((count, entry) => count + entry.stepIds.length, 0);
  return {
    activeDatasetVersion: versionContext.activeDatasetVersion,
    entries,
    mismatchedEntries,
    historicalVersions,
    unavailableVersions,
    hasMismatch: mismatchedEntries.length > 0,
    message: mismatchedEntries.length
      ? `${stepCount} saved step${stepCount === 1 ? "" : "s"} use a dataset version that is not the current corpus. `
        + "Original snapshots are retained; re-run to append a separate current-version step."
      : null,
  };
}
