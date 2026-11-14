/**
 * U08-A guided investigations — three deterministic, corpus-pinned journeys
 * through the accepted plot, comparison, notebook and export helpers.
 *
 * A guide definition is data, not prose-only copy: it names the ordered
 * explicit runs, the plot axes and scope, the selected-runs comparison request
 * and the limitations that apply. Opening a guide rebuilds every plot point and
 * comparison cell from the supplied dataset through the accepted engines; no
 * stored values are copied into this module and no value is interpolated.
 *
 * Boundaries:
 * - Opening a guide returns a new immutable notebook value. It never saves to
 *   browser storage, writes a server record, calls a provider or signs a receipt.
 *   Persistence remains the existing U05 save helper, called only by the future
 *   U09 browser wiring.
 * - A guide is pinned to the reviewed dataset version and source ID. A mismatched
 *   active corpus produces a clear structured failure; this module never
 *   relabels a guide with another corpus or reuses facts from a stale one.
 * - `null` means unknown. Missing values stay unknown, are omitted from a plot
 *   axis that requires them, and never count as a comparison match or as zero.
 * - The complete four-field gas group is retained where a guide compares runs.
 * - Guide step limitations combine the accepted engine limitations with the
 *   guide's explicit scientific limits, within the notebook contract bounds.
 *
 * U09 owns the browser entry points/buttons and the wiring to the notebook UI.
 * U08.6 private media/handoff work remains with Codex.
 */
import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import {
  buildSelectedRunsContext,
} from "./comparison-engine.ts";
import type {
  ComparisonContextField,
  ContextFieldStatus,
} from "./comparison-context.ts";
import { selectedRunsContextRequestSchema } from "./comparison-context.ts";
import type { FieldKey } from "./field-catalog.ts";
import {
  notebookLimits,
  notebookStepIdSchema,
  type ComparisonNotebookStep,
  type Notebook,
  type NotebookStep,
  type PlotNotebookStep,
} from "./notebook.ts";
import {
  appendNotebookStep,
  createComparisonNotebookStep,
  createNotebook,
  createPlotNotebookStep,
} from "./notebook-engine.ts";
import {
  exportNotebookJson,
  renderPrintableNotebookHtml,
} from "./notebook-presentation.ts";
import { buildPlotResult } from "./plot-engine.ts";
import {
  plotSpecSchema,
  type PlotOmittedReason,
  type PlotSpec,
} from "./plot.ts";
import {
  datasetVersionSchema,
  resolveStableFieldReference,
  sourceIdSchema,
  stableFieldReferenceKey,
  type StableFieldReference,
} from "./provenance.ts";
import { upgradeContractVersions } from "./versions.ts";

/* ------------------------------------------------------------------------- */
/* Corpus pins and stable identities                                         */
/* ------------------------------------------------------------------------- */

/** The reviewed corpus these guides were verified against. */
export const guidedInvestigationsDatasetVersion = "flex-psi69-v5-table-v1-subset-1";
/** The single source recorded for every field in the reviewed corpus. */
export const guidedInvestigationsSourceId = "psi-69-flex-table-v1";

export const guidedInvestigationVersion = "guided-investigation-1" as const;

const nonBlank = (max: number) => z.string().min(1).max(max)
  .refine((text) => text.trim().length > 0, "Expected non-blank text");
const guideIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const guidedLimitationSchema = z.string().min(1).max(notebookLimits.maxLimitationLength);

/* ------------------------------------------------------------------------- */
/* Guide definition schema                                                   */
/* ------------------------------------------------------------------------- */

const guidedPlotStepSchema = z.strictObject({
  kind: z.literal("plot"),
  stepId: notebookStepIdSchema,
  title: nonBlank(notebookLimits.maxTitleLength),
  /** Short UI copy describing the bounded action; not stored in the notebook. */
  purpose: nonBlank(500).optional(),
  plotSpec: plotSpecSchema,
});

const guidedComparisonStepSchema = z.strictObject({
  kind: z.literal("comparison"),
  stepId: notebookStepIdSchema,
  title: nonBlank(notebookLimits.maxTitleLength),
  purpose: nonBlank(500).optional(),
  request: selectedRunsContextRequestSchema,
});

export const guidedInvestigationStepSchema = z.discriminatedUnion("kind", [
  guidedPlotStepSchema,
  guidedComparisonStepSchema,
]);
export type GuidedInvestigationStep = z.infer<typeof guidedInvestigationStepSchema>;

export const guidedInvestigationSchema = z.strictObject({
  version: z.literal(guidedInvestigationVersion),
  /** Stable, human-readable identity used by tests, docs and the U09 entry points. */
  guideId: guideIdSchema,
  title: nonBlank(notebookLimits.maxTitleLength),
  question: nonBlank(notebookLimits.maxQuestionLength),
  /** One-paragraph description for a listing or entry card. */
  summary: nonBlank(500),
  datasetVersion: datasetVersionSchema,
  sourceId: sourceIdSchema,
  steps: z.array(guidedInvestigationStepSchema).min(1).max(6),
  limitations: z.array(guidedLimitationSchema).min(1).max(8),
}).superRefine((guide, context) => {
  const stepIds = new Set<string>();
  for (const [index, step] of guide.steps.entries()) {
    if (stepIds.has(step.stepId)) {
      context.addIssue({ code: "custom", path: ["steps", index, "stepId"], message: "Duplicate guide step ID" });
    }
    stepIds.add(step.stepId);
    // Guides are pinned to explicitly named runs so their facts cannot silently
    // change when a filter or the active workspace scope changes.
    if (step.kind === "plot" && step.plotSpec.scope.kind !== "explicit-runs") {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "plotSpec", "scope", "kind"],
        message: "A guided plot must use an explicit run scope",
      });
    }
  }
  for (const [index, limitation] of guide.limitations.entries()) {
    if (!limitation.trim()) {
      context.addIssue({
        code: "custom",
        path: ["limitations", index],
        message: "Guide limitations must be non-blank",
      });
    }
  }
});
export type GuidedInvestigation = z.infer<typeof guidedInvestigationSchema>;

/* ------------------------------------------------------------------------- */
/* The three reviewed investigations                                         */
/* ------------------------------------------------------------------------- */

const guideDefinitionInputs = [
  {
    version: guidedInvestigationVersion,
    guideId: "burn-time-condition-differences",
    title: "Burn time and recorded conditions",
    question: "How do the recorded burn times of FLEX-001 and FLEX-004 differ, and which recorded conditions differ for the same pair?",
    summary: "Compare the recorded burn times of FLEX-001 and FLEX-004, then inspect every condition and outcome the same ordered pair records.",
    datasetVersion: guidedInvestigationsDatasetVersion,
    sourceId: guidedInvestigationsSourceId,
    steps: [
      {
        kind: "plot",
        stepId: "bt-1-burn-time",
        title: "Recorded burn times",
        purpose: "Compare the two recorded burn times on one measurement axis without interpolating or selecting a zero.",
        plotSpec: {
          version: upgradeContractVersions.plotSpec,
          kind: "point-comparison",
          axes: { y: { field: "burn_time" } },
          grouping: "none",
          scope: { kind: "explicit-runs", runIds: ["FLEX-001", "FLEX-004"] },
        },
      },
      {
        kind: "comparison",
        stepId: "bt-2-context",
        title: "Recorded condition and outcome differences",
        purpose: "Inspect every recorded condition and outcome for the same ordered pair, including the unknown visible-extinction cell.",
        request: {
          version: upgradeContractVersions.comparisonContextRequest,
          kind: "selected-runs",
          runIds: ["FLEX-001", "FLEX-004"],
        },
      },
    ],
    limitations: [
      "A recorded burn-time difference describes these two runs in this curated subset; it does not establish a cause, a trend or a general rule.",
      "FLEX-004 records no visible-extinction diameter. That null cell is unknown and is neither plotted nor substituted with zero.",
      "Both runs record identical initial gas mole fractions. Gas fractions are linked, so this pair does not establish an isolated oxygen effect.",
    ],
  },
  {
    version: guidedInvestigationVersion,
    guideId: "missing-burning-rate",
    title: "A missing burning rate",
    question: "Which comparison does FLEX-014's missing burning rate prevent, and what can still be compared with FLEX-013?",
    summary: "Follow the null burning-rate cell in FLEX-014: the burning-rate comparison with FLEX-013 is prevented, while the recorded burn times remain comparable.",
    datasetVersion: guidedInvestigationsDatasetVersion,
    sourceId: guidedInvestigationsSourceId,
    steps: [
      {
        kind: "plot",
        stepId: "mr-1-burning-rate",
        title: "Burning rate with one unknown",
        purpose: "Open the comparison the missing cell blocks; FLEX-014 is omitted with an explicit reason, not plotted at zero.",
        plotSpec: {
          version: upgradeContractVersions.plotSpec,
          kind: "point-comparison",
          axes: { y: { field: "burning_rate" } },
          grouping: "none",
          scope: { kind: "explicit-runs", runIds: ["FLEX-013", "FLEX-014"] },
        },
      },
      {
        kind: "plot",
        stepId: "mr-2-burn-time",
        title: "The neighboring outcome both runs record",
        purpose: "Show the recorded burn times without treating that separate outcome as a substitute for the missing burning rate.",
        plotSpec: {
          version: upgradeContractVersions.plotSpec,
          kind: "point-comparison",
          axes: { y: { field: "burn_time" } },
          grouping: "none",
          scope: { kind: "explicit-runs", runIds: ["FLEX-013", "FLEX-014"] },
        },
      },
      {
        kind: "comparison",
        stepId: "mr-3-context",
        title: "Known and unknown outcomes together",
        purpose: "Read the engine statuses: burning rate unknown, burn time different, and the linked gas group complete.",
        request: {
          version: upgradeContractVersions.comparisonContextRequest,
          kind: "selected-runs",
          runIds: ["FLEX-013", "FLEX-014"],
        },
      },
    ],
    limitations: [
      "Null means unknown. FLEX-014's missing burning rate is never treated as zero and never counts as a match.",
      "The missing burning rate prevents a recorded burning-rate comparison between FLEX-013 and FLEX-014; no rate difference is established.",
      "The recorded burn-time comparison is a separate outcome and cannot substitute for the missing burning-rate measurement.",
      "Visible-extinction diameters are unknown for both runs in this pair, so this guide makes no extinction claim.",
    ],
  },
  {
    version: guidedInvestigationVersion,
    guideId: "visible-flame-extinction",
    title: "Visible flame extinction",
    question: "What do the reviewed records support about visible flame extinction across different test-end labels?",
    summary: "Compare recorded visible-extinction diameters across test-end labels, then inspect two ordered pairs the reviewed subset records.",
    datasetVersion: guidedInvestigationsDatasetVersion,
    sourceId: guidedInvestigationsSourceId,
    steps: [
      {
        kind: "plot",
        stepId: "xf-1-extinction",
        title: "Recorded visible-extinction diameters",
        purpose: "Place four recorded extinction diameters on one measurement axis; the categorical axis is run identity, not a test-end score.",
        plotSpec: {
          version: upgradeContractVersions.plotSpec,
          kind: "point-comparison",
          axes: { y: { field: "extinction_diameter" } },
          grouping: "none",
          scope: {
            kind: "explicit-runs",
            runIds: ["FLEX-001", "FLEX-002", "FLEX-020", "FLEX-025"],
          },
        },
      },
      {
        kind: "comparison",
        stepId: "xf-2-different-end",
        title: "A pair with different test-end labels",
        purpose: "Inspect a pair that ended differently while both records carry a visible-extinction diameter measurement.",
        request: {
          version: upgradeContractVersions.comparisonContextRequest,
          kind: "selected-runs",
          runIds: ["FLEX-001", "FLEX-002"],
        },
      },
      {
        kind: "comparison",
        stepId: "xf-3-same-end",
        title: "A pair with the same test-end label",
        purpose: "Inspect two Completion runs with different recorded gas fractions and different visible-extinction diameters.",
        request: {
          version: upgradeContractVersions.comparisonContextRequest,
          kind: "selected-runs",
          runIds: ["FLEX-020", "FLEX-025"],
        },
      },
    ],
    limitations: [
      "A visible-extinction diameter is not a generic final droplet size. Appendix A.1 notes that some values were estimated from burning history, and the selected columns do not flag individual estimates.",
      "Test-end labels describe how a test ended. They are not a quality ranking and do not by themselves establish whether a visible flame extinction measurement was recorded.",
      "Gas fractions are linked. A recorded oxygen difference is accompanied by the other gas fractions and does not establish an isolated oxygen effect.",
      "Different recorded diameters are observations, not a demonstrated controlling mechanism.",
    ],
  },
];

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as T;
}

function buildReviewedGuide(input: unknown): GuidedInvestigation {
  const guide = guidedInvestigationSchema.parse(input);
  if (guide.datasetVersion !== guidedInvestigationsDatasetVersion || guide.sourceId !== guidedInvestigationsSourceId) {
    throw new Error(
      `Guide ${guide.guideId} must stay pinned to ${guidedInvestigationsDatasetVersion}/${guidedInvestigationsSourceId}.`,
    );
  }
  return deepFreeze(guide);
}

/** The three reviewed guides, in stable listing order. */
export const guidedInvestigations: readonly GuidedInvestigation[] = Object.freeze(
  guideDefinitionInputs.map((input) => buildReviewedGuide(input)),
);

/** Typed listing for a guide picker or entry-point list. */
export function listGuidedInvestigations(): readonly GuidedInvestigation[] {
  return guidedInvestigations;
}

export function getGuidedInvestigation(guideId: string): GuidedInvestigation | undefined {
  return guidedInvestigations.find((guide) => guide.guideId === guideId);
}

/* ------------------------------------------------------------------------- */
/* Dataset identity and mismatch reporting                                   */
/* ------------------------------------------------------------------------- */

export type GuidedDatasetReport = {
  datasetVersion: string;
  expectedDatasetVersion: string;
  sourceId: string;
  versionMatches: boolean;
  sourcePresent: boolean;
  compatible: boolean;
  /** Null when compatible; otherwise a message that names both identities. */
  message: string | null;
};

/**
 * Report whether a supplied dataset is the pinned corpus. A mismatch is not
 * repaired by relabelling the guides; callers display this state instead.
 */
export function guidedInvestigationDatasetReport(dataset: Dataset): GuidedDatasetReport {
  const versionMatches = dataset.version === guidedInvestigationsDatasetVersion;
  const sourcePresent = dataset.sources.some(({ id }) => id === guidedInvestigationsSourceId);
  let message: string | null = null;
  if (!versionMatches) {
    message = `The active dataset version "${dataset.version}" does not match the guided investigations' pinned corpus `
      + `"${guidedInvestigationsDatasetVersion}". Guides were not rebuilt; stored guide facts are not reused across corpora.`;
  } else if (!sourcePresent) {
    message = `The pinned source "${guidedInvestigationsSourceId}" is absent from dataset "${dataset.version}". `
      + "Source references cannot be grounded, so the guides were not rebuilt.";
  }
  return {
    datasetVersion: dataset.version,
    expectedDatasetVersion: guidedInvestigationsDatasetVersion,
    sourceId: guidedInvestigationsSourceId,
    versionMatches,
    sourcePresent,
    compatible: versionMatches && sourcePresent,
    message,
  };
}

/* ------------------------------------------------------------------------- */
/* Opening a guide — pure notebook construction, never persistence           */
/* ------------------------------------------------------------------------- */

export type GuidedInvestigationOpenOptions = {
  /** Caller-supplied notebook identity; generated safely when omitted. */
  notebookId?: string;
  /** ISO date-time for the notebook and every immutable step; defaults to now. */
  openedAt?: string;
  /** Optional notebook update time; defaults to `openedAt`. */
  updatedAt?: string;
};

export type GuidedInvestigationFailureReason =
  | "unknown-guide"
  | "invalid-dataset"
  | "dataset-mismatch"
  | "invalid-options"
  | "build-failure"
  | "notebook-failure"
  | "export-failure";

export type GuidedInvestigationFailure = {
  ok: false;
  reason: GuidedInvestigationFailureReason;
  message: string;
  guideId?: string;
  stepId?: string;
  expectedDatasetVersion?: string;
  actualDatasetVersion?: string;
  issues?: string[];
};

export type GuidedPlotPointFacts = {
  runId: string;
  x: number | null;
  y: number;
  group: string | null;
};

export type GuidedPlotStepFacts = {
  stepId: string;
  stepType: "plot";
  title: string;
  purpose?: string;
  datasetVersion: string;
  includedCount: number;
  omittedCount: number;
  points: GuidedPlotPointFacts[];
  omitted: Array<{ runId: string; reasons: PlotOmittedReason[] }>;
  sourceReferences: StableFieldReference[];
  limitations: string[];
};

export type GuidedComparisonValueFacts = {
  runId: string;
  value: number | string | null;
  original: string | null;
  unit: string | null;
};

export type GuidedComparisonFieldFacts = {
  key: FieldKey;
  label: string;
  status: ContextFieldStatus;
  values: GuidedComparisonValueFacts[];
  deltas: Array<{
    fromRunId: string;
    toRunId: string;
    delta: number;
    unit: string;
  }>;
};

export type GuidedGasCompositionFacts = {
  fieldKeys: readonly ["oxygen", "nitrogen", "carbon_dioxide", "helium"];
  complete: boolean;
  values: Array<{
    runId: string;
    oxygen: number | null;
    nitrogen: number | null;
    carbon_dioxide: number | null;
    helium: number | null;
  }>;
  differenceCount: number;
  limitation: string;
};

export type GuidedComparisonStepFacts = {
  stepId: string;
  stepType: "comparison";
  title: string;
  purpose?: string;
  datasetVersion: string;
  runIds: string[];
  conditions: GuidedComparisonFieldFacts[];
  outcomes: GuidedComparisonFieldFacts[];
  gasComposition: GuidedGasCompositionFacts;
  sourceReferences: StableFieldReference[];
  limitations: string[];
};

export type GuidedStepFacts = GuidedPlotStepFacts | GuidedComparisonStepFacts;

export type GuidedSourceAnchor = {
  reference: StableFieldReference;
  value: number | string | null;
  original: string | null;
  locator: string;
  sourceTitle: string;
  sourceUrl: string;
};

export type GuidedCorpusIdentity = {
  datasetVersion: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceVersion: string;
  license: string;
  doi: string | null;
};

export type GuidedInvestigationOpenSuccess = {
  ok: true;
  guide: GuidedInvestigation;
  corpus: GuidedCorpusIdentity;
  notebook: Notebook;
  facts: GuidedStepFacts[];
  sourceReferences: StableFieldReference[];
  sourceAnchors: GuidedSourceAnchor[];
  limitations: string[];
};

export type GuidedInvestigationOpenResult =
  | GuidedInvestigationOpenSuccess
  | GuidedInvestigationFailure;

function failure(
  reason: GuidedInvestigationFailureReason,
  message: string,
  details: Omit<GuidedInvestigationFailure, "ok" | "reason" | "message"> = {},
): GuidedInvestigationFailure {
  return { ok: false, reason, message, ...details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDatasetShape(value: unknown): value is Dataset {
  return isRecord(value)
    && typeof value.version === "string"
    && value.version.trim().length > 0
    && Array.isArray(value.sources)
    && Array.isArray(value.runs);
}

function zodIssueStrings(error: z.ZodError): string[] {
  return error.issues.slice(0, 50).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorIssues(error: unknown): string[] | undefined {
  return error instanceof z.ZodError ? zodIssueStrings(error) : undefined;
}

function uniqueStrings(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const text of list) {
      if (seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function mergeStepLimitations(
  engineLimitations: readonly string[],
  guideLimitations: readonly string[],
): string[] {
  const merged = uniqueStrings([engineLimitations, guideLimitations]);
  if (merged.length > notebookLimits.maxLimitations) {
    throw new RangeError(
      `Guide limitations plus engine limitations exceed the ${notebookLimits.maxLimitations}-limitation notebook bound.`,
    );
  }
  return merged;
}

function generatedGuidedNotebookId(guideId: string): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `guide-${guideId}-${random}`.slice(0, 64);
}

function comparisonFieldFacts(fields: readonly ComparisonContextField[]): GuidedComparisonFieldFacts[] {
  return fields.map((field) => ({
    key: field.key as FieldKey,
    label: field.label,
    status: field.status,
    values: field.cells.map((cell) => ({
      runId: cell.runId,
      value: cell.value,
      original: cell.original,
      unit: field.unit,
    })),
    deltas: field.deltas.map(({ fromRunId, toRunId, delta, unit }) => ({
      fromRunId,
      toRunId,
      delta,
      unit,
    })),
  }));
}

function comparisonFacts(
  step: ComparisonNotebookStep,
  definition: GuidedInvestigationStep & { kind: "comparison" },
): GuidedComparisonStepFacts {
  const { context } = step;
  return {
    stepId: step.stepId,
    stepType: "comparison",
    title: step.title,
    ...(definition.purpose === undefined ? {} : { purpose: definition.purpose }),
    datasetVersion: step.datasetVersion,
    runIds: [...context.runIds],
    conditions: comparisonFieldFacts(context.conditions),
    outcomes: comparisonFieldFacts(context.outcomes),
    gasComposition: {
      fieldKeys: [...context.gasComposition.fieldKeys],
      complete: context.gasComposition.complete,
      values: context.gasComposition.values.map(({ runId, values }) => ({ runId, ...values })),
      differenceCount: context.gasComposition.differences.length,
      limitation: context.gasComposition.limitation,
    },
    sourceReferences: [...step.sourceReferences],
    limitations: [...step.limitations],
  };
}

function plotFacts(
  step: PlotNotebookStep,
  definition: GuidedInvestigationStep & { kind: "plot" },
): GuidedPlotStepFacts {
  return {
    stepId: step.stepId,
    stepType: "plot",
    title: step.title,
    ...(definition.purpose === undefined ? {} : { purpose: definition.purpose }),
    datasetVersion: step.datasetVersion,
    includedCount: step.plotResult.includedCount,
    omittedCount: step.plotResult.omittedCount,
    points: step.plotResult.points.map(({ runId, x, y, group }) => ({ runId, x, y, group })),
    omitted: step.plotResult.omitted.map(({ runId, reasons }) => ({ runId, reasons: [...reasons] })),
    sourceReferences: [...step.sourceReferences],
    limitations: [...step.limitations],
  };
}

function buildGuideStep(
  dataset: Dataset,
  guide: GuidedInvestigation,
  definition: GuidedInvestigationStep,
  openedAt: string,
): { step: NotebookStep; facts: GuidedStepFacts } {
  if (definition.kind === "plot") {
    const plotResult = buildPlotResult(dataset, definition.plotSpec);
    const limitations = mergeStepLimitations(plotResult.limitations, guide.limitations);
    const step = createPlotNotebookStep({
      stepId: definition.stepId,
      title: definition.title,
      createdAt: openedAt,
      plotSpec: definition.plotSpec,
      plotResult,
      limitations,
    });
    return { step, facts: plotFacts(step, definition) };
  }

  const context = buildSelectedRunsContext(dataset, definition.request);
  const limitations = mergeStepLimitations(context.limitations, guide.limitations);
  const step = createComparisonNotebookStep({
    stepId: definition.stepId,
    title: definition.title,
    createdAt: openedAt,
    context,
    limitations,
  });
  return { step, facts: comparisonFacts(step, definition) };
}

function collectStepSourceReferences(steps: readonly NotebookStep[]): StableFieldReference[] {
  const references = new Map<string, StableFieldReference>();
  for (const step of steps) {
    for (const reference of step.sourceReferences) {
      references.set(stableFieldReferenceKey(reference), reference);
    }
  }
  return [...references.values()];
}

function resolveSourceAnchors(
  dataset: Dataset,
  references: readonly StableFieldReference[],
): { anchors: GuidedSourceAnchor[]; issues: string[] } {
  const anchors: GuidedSourceAnchor[] = [];
  const issues: string[] = [];
  for (const reference of references) {
    const resolution = resolveStableFieldReference(dataset, reference);
    if (resolution.status !== "resolved") {
      issues.push(
        `${reference.runId}/${reference.fieldKey}: ${resolution.status}`,
      );
      continue;
    }
    anchors.push({
      reference: resolution.reference,
      value: resolution.field.value,
      original: resolution.field.original,
      locator: resolution.field.locator,
      sourceTitle: resolution.source.title,
      sourceUrl: resolution.source.url,
    });
  }
  return { anchors, issues };
}

/**
 * Open one guide as a new immutable notebook. This is the guide entry-point
 * construction helper for U09: it rebuilds the facts from `dataset` and returns
 * the notebook value. It does not save, import, print, export, call a provider
 * or write any server record.
 *
 * Callers supply a notebook ID/time when they need reproducibility. Otherwise a
 * namespaced ID and the current ISO time are generated. The returned notebook
 * steps are deep-frozen by the accepted notebook helpers.
 */
export function openGuidedInvestigation(
  dataset: Dataset,
  guideId: string,
  options: GuidedInvestigationOpenOptions = {},
): GuidedInvestigationOpenResult {
  const guide = getGuidedInvestigation(guideId);
  if (!guide) {
    return failure(
      "unknown-guide",
      `Unknown guided investigation "${guideId}". Available guides: ${guidedInvestigations.map(({ guideId: id }) => id).join(", ")}.`,
      { guideId },
    );
  }
  if (!isDatasetShape(dataset)) {
    return failure(
      "invalid-dataset",
      "A parsed dataset with a version, sources and runs is required before a guide can be opened.",
      { guideId },
    );
  }

  const report = guidedInvestigationDatasetReport(dataset);
  if (!report.compatible) {
    return failure(
      "dataset-mismatch",
      report.message ?? "The active dataset does not match the guides' pinned corpus.",
      {
        guideId,
        expectedDatasetVersion: report.expectedDatasetVersion,
        actualDatasetVersion: report.datasetVersion,
      },
    );
  }

  const source = dataset.sources.find(({ id }) => id === guidedInvestigationsSourceId);
  if (!source) {
    return failure(
      "dataset-mismatch",
      `The pinned source "${guidedInvestigationsSourceId}" is absent from dataset "${dataset.version}".`,
      {
        guideId,
        expectedDatasetVersion: report.expectedDatasetVersion,
        actualDatasetVersion: report.datasetVersion,
      },
    );
  }

  const openedAt = options.openedAt ?? new Date().toISOString();
  const updatedAt = options.updatedAt ?? openedAt;
  if (!Number.isFinite(Date.parse(openedAt))) {
    return failure("invalid-options", "openedAt must be an ISO date-time string.", { guideId });
  }
  if (!Number.isFinite(Date.parse(updatedAt))) {
    return failure("invalid-options", "updatedAt must be an ISO date-time string.", { guideId });
  }
  if (Date.parse(updatedAt) < Date.parse(openedAt)) {
    return failure("invalid-options", "updatedAt must not precede openedAt.", { guideId });
  }
  const notebookId = options.notebookId ?? generatedGuidedNotebookId(guide.guideId);

  let notebook: Notebook;
  try {
    notebook = createNotebook({
      id: notebookId,
      title: guide.title,
      question: guide.question,
      datasetVersions: [guide.datasetVersion],
      createdAt: openedAt,
      updatedAt,
    });
  } catch (error) {
    return failure("invalid-options", describeError(error), {
      guideId,
      issues: errorIssues(error),
    });
  }

  const facts: GuidedStepFacts[] = [];
  for (const definition of guide.steps) {
    let built: { step: NotebookStep; facts: GuidedStepFacts };
    try {
      built = buildGuideStep(dataset, guide, definition, openedAt);
    } catch (error) {
      return failure("build-failure", describeError(error), {
        guideId,
        stepId: definition.stepId,
        issues: errorIssues(error),
      });
    }
    const appended = appendNotebookStep(notebook, built.step, { now: openedAt });
    if (!appended.ok) {
      return failure("notebook-failure", appended.message, {
        guideId,
        stepId: definition.stepId,
        issues: appended.issues,
      });
    }
    notebook = appended.notebook;
    facts.push(built.facts);
  }

  const sourceReferences = collectStepSourceReferences(notebook.steps);
  const { anchors, issues } = resolveSourceAnchors(dataset, sourceReferences);
  if (issues.length) {
    return failure(
      "build-failure",
      "The rebuilt guide carried source references that do not resolve against the pinned corpus.",
      { guideId, issues },
    );
  }

  return deepFreeze({
    ok: true,
    guide,
    corpus: {
      datasetVersion: dataset.version,
      sourceId: source.id,
      sourceTitle: source.title,
      sourceUrl: source.url,
      sourceVersion: source.version,
      license: source.license,
      doi: source.doi ?? null,
    },
    notebook,
    facts,
    sourceReferences,
    sourceAnchors: anchors,
    limitations: [...guide.limitations],
  });
}

/* ------------------------------------------------------------------------- */
/* Guide-to-export journey                                                   */
/* ------------------------------------------------------------------------- */

export type GuidedInvestigationExportOptions = GuidedInvestigationOpenOptions & {
  /** Optional JSON download filename override. */
  filename?: string;
  /** Optional print-report display time; omitted keeps the report deterministic. */
  generatedAt?: string;
};

export type GuidedInvestigationExportSuccess = {
  ok: true;
  investigation: GuidedInvestigationOpenSuccess;
  json: {
    text: string;
    byteLength: number;
    filename: string;
    mediaType: "application/json";
  };
  printableHtml: string;
};

export type GuidedInvestigationExportResult =
  | GuidedInvestigationExportSuccess
  | GuidedInvestigationFailure;

/**
 * Open a guide and build both accepted portable products:
 * - the notebook-1 JSON document from `exportNotebookJson` (re-importable by
 *   the existing U05 import engine); and
 * - the standalone printable HTML report from `renderPrintableNotebookHtml`,
 *   with the supplied exact corpus used to re-resolve locators.
 *
 * The report and JSON retain the dataset version, source references, step
 * limitations and the unknown values. Nothing is downloaded, printed, saved or
 * sent by this function; the future U09 browser wiring owns those actions.
 */
export function exportGuidedInvestigation(
  dataset: Dataset,
  guideId: string,
  options: GuidedInvestigationExportOptions = {},
): GuidedInvestigationExportResult {
  const investigation = openGuidedInvestigation(dataset, guideId, options);
  if (!investigation.ok) return investigation;

  const exported = exportNotebookJson(investigation.notebook, { filename: options.filename });
  if (!exported.ok) {
    return failure("export-failure", exported.message, {
      guideId,
      issues: exported.issues,
    });
  }

  const printableHtml = renderPrintableNotebookHtml(investigation.notebook, {
    datasets: [dataset],
    versionContext: { activeDatasetVersion: dataset.version },
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });

  return {
    ok: true,
    investigation,
    json: {
      text: exported.text,
      byteLength: exported.byteLength,
      filename: exported.filename,
      mediaType: exported.mediaType,
    },
    printableHtml,
  };
}
