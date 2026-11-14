/**
 * U03.5/U03.6 — plot/table run selection and plot export payload contracts.
 *
 * This module is additive, pure and browser-safe. It owns two things:
 *
 * 1. `PlotRunSelection` — the ordered 0–3 run identity list shared by the plot
 *    and table views (U03.5). The existing Workbench `selected` state is not
 *    imported or mutated; U07 keeps its React state and calls these helpers.
 * 2. `PlotExportPayload` (`plot-export-1`) — a versioned JSON document built
 *    from a validated `PlotSpec` and its canonical `PlotResult` (U03.6), with
 *    raw recorded source values resolved only from the matching dataset.
 *
 * ## Selection consumption (U07)
 *
 * - Keep one `PlotRunSelection` per workspace; call `togglePlotRunSelection`
 *   for a point or table-row toggle. The returned status is `"added"` or
 *   `"removed"` with a new immutable state and incremented `revision`.
 * - When the third run is already selected, a fourth toggle returns
 *   `"replacement-required"` with the unchanged selection and an explicit
 *   `choice`. Render the three existing slots plus Cancel; Cancel discards the
 *   choice without a state change. Replace via `replacePlotRunSelection(...,
 *   replacedRunId)`, which keeps that run's slot. If the user changed the
 *   selection after the choice was shown, replacement throws
 *   `PlotWorkspaceError("stale-selection")`; close the picker and retry.
 * - `plotRunSelectionMode` reports `"empty"`, `"inspection"` (one run) or
 *   `"comparison"` (two/three runs). Only two or three runs may launch the
 *   existing comparison. `plotRunSelectionScope` maps a nonempty selection to an
 *   `explicit-runs` plot scope; an empty selection uses the all/filtered scope.
 * - The same ordered `runIds` list drives plot highlighting and table row
 *   selection. The module never changes the Workbench selection, URL or chat
 *   context implicitly.
 *
 * ## Export consumption (U07)
 *
 * - Call `buildPlotExportPayload(dataset, spec, result)` after the engine has
 *   produced the displayed result. It re-validates the spec/result pair, requires
 *   the result's dataset version to match the supplied dataset, requires the
 *   spec's scope/axes to match the result, resolves every plotted source value
 *   from that dataset, and returns the parsed `plot-export-1` payload.
 * - Serialize the returned object in U07. Rendering, downloads, confirmation
 *   controls and app-shell changes are not part of this module. The existing
 *   signed evidence export is untouched.
 * - A zero-row `PlotResult` exports as a valid payload with empty `rows` and
 *   `omitted`, zero `counts`, the original scope and the frozen limitations.
 *   `rows` contains measurements only; omitted runs and reasons stay in the
 *   separate `omitted` array.
 *
 * `plot-export-1` is a U03-owned payload version. The shared
 * `upgradeContractVersions` object is closed and was not edited.
 */
import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import {
  getFieldDefinition,
  numericFieldKeySchema,
  type NumericFieldKey,
} from "./field-catalog.ts";
import {
  plotOmittedRunSchema,
  plotResultSchema,
  plotScopeSummarySchema,
  plotSpecSchema,
  validatePlotResultAgainstDataset,
  type PlotPoint,
  type PlotResult,
  type PlotSpec,
} from "./plot.ts";
import {
  canonicalRunIdSchema,
  datasetVersionSchema,
  finiteNumberSchema,
  resolveStableFieldReference,
  ruleVersions,
  stableFieldReferenceSchema,
  type CorpusValidationIssue,
} from "./provenance.ts";
import { resolveRunScope, runScopeSchema, type RunScope } from "./scope.ts";
import { upgradeContractVersions } from "./versions.ts";

const limitationSchema = z.string().min(1).max(500);

/** U03-owned export payload version; independent of the frozen contract list. */
export const plotExportPayloadVersion = "plot-export-1" as const;

/** Contract identity recorded in every export payload. */
export const plotExportContractVersions = {
  plotSpec: upgradeContractVersions.plotSpec,
  plotResult: upgradeContractVersions.plotResult,
  fieldCatalog: upgradeContractVersions.fieldCatalog,
  stableFieldReference: upgradeContractVersions.stableFieldReference,
  runScope: upgradeContractVersions.runScope,
  plotExport: plotExportPayloadVersion,
  scopeRuleVersion: ruleVersions.plotScope,
  omissionRuleVersion: ruleVersions.omissionAccounting,
} as const;

export const plotWorkspaceErrorCodes = [
  "invalid-dataset",
  "invalid-run-id",
  "unknown-run",
  "duplicate-run",
  "selection-limit",
  "dataset-version-mismatch",
  "stale-selection",
  "run-not-selected",
  "invalid-spec",
  "invalid-result",
  "spec-result-mismatch",
  "axes-mismatch",
  "scope-mismatch",
  "source-mismatch",
  "unit-mismatch",
  "count-mismatch",
  "contract-violation",
] as const;

export type PlotWorkspaceErrorCode = (typeof plotWorkspaceErrorCodes)[number];

export type PlotWorkspaceErrorDetails = {
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly datasetVersion?: string;
  readonly expectedDatasetVersion?: string;
  readonly selectionRevision?: number;
  readonly choiceRevision?: number;
  readonly fieldKey?: string;
  readonly axis?: "x" | "y";
  readonly specIssues?: readonly string[];
  readonly resultIssues?: readonly string[];
  readonly issues?: readonly CorpusValidationIssue[];
};

/**
 * Typed failure for selection and export helpers. Selection helpers throw only
 * for invalid input/stale choices; a fourth-run toggle is a normal
 * `"replacement-required"` result, not an error.
 */
export class PlotWorkspaceError extends Error {
  readonly code: PlotWorkspaceErrorCode;
  readonly details: PlotWorkspaceErrorDetails;

  constructor(
    code: PlotWorkspaceErrorCode,
    message: string,
    details: PlotWorkspaceErrorDetails = {},
  ) {
    super(message);
    this.name = "PlotWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export function isPlotWorkspaceError(value: unknown): value is PlotWorkspaceError {
  return value instanceof PlotWorkspaceError;
}

function assertDatasetShape(dataset: Dataset): void {
  const candidate = dataset as unknown as {
    version?: unknown;
    sources?: unknown;
    runs?: unknown;
  } | null | undefined;
  if (
    !candidate
    || typeof candidate !== "object"
    || typeof candidate.version !== "string"
    || candidate.version.trim().length === 0
    || !Array.isArray(candidate.sources)
    || !Array.isArray(candidate.runs)
  ) {
    throw new PlotWorkspaceError(
      "invalid-dataset",
      "A parsed dataset with a non-empty version, sources and runs is required.",
    );
  }
}

function formatZodIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string[] {
  return issues.map(({ path, message }) => {
    const location = path.length ? path.map(String).join(".") : "(root)";
    return `${location}: ${message}`;
  });
}

function formatCorpusIssues(issues: readonly CorpusValidationIssue[]): string {
  return issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Order-insensitive JSON equality for small contract values (search filters). */
function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return nested;
  });
}

type AxisFieldPair = {
  readonly axis: "x" | "y";
  readonly fieldKey: NumericFieldKey;
};

function axisFieldPairs(spec: PlotSpec): AxisFieldPair[] {
  return spec.kind === "scatter"
    ? [{ axis: "x", fieldKey: spec.axes.x.field }, { axis: "y", fieldKey: spec.axes.y.field }]
    : [{ axis: "y", fieldKey: spec.axes.y.field }];
}

// ---------------------------------------------------------------------------
// U03.5 — ordered plot/table run selection
// ---------------------------------------------------------------------------

/**
 * Ordered, distinct, dataset-scoped selection of zero to three runs. `revision`
 * increments on every effective mutation and is the freshness token checked by
 * an explicit replacement.
 */
export type PlotRunSelection = {
  readonly datasetVersion: string;
  readonly runIds: readonly string[];
  readonly revision: number;
};

export const plotRunSelectionSchema = z.strictObject({
  datasetVersion: datasetVersionSchema,
  runIds: z.array(canonicalRunIdSchema).max(3)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct run IDs"),
  revision: z.int().nonnegative(),
});

export type PlotSelectionMode = "empty" | "inspection" | "comparison";

/** Snapshot captured when a fourth run needs an explicit replace-or-cancel choice. */
export type PlotReplacementChoice = {
  readonly datasetVersion: string;
  readonly incomingRunId: string;
  readonly selectionRunIds: readonly string[];
  readonly selectionRevision: number;
};

export type PlotRunToggleResult =
  | { readonly status: "added"; readonly selection: PlotRunSelection }
  | { readonly status: "removed"; readonly selection: PlotRunSelection }
  | {
    readonly status: "replacement-required";
    readonly selection: PlotRunSelection;
    readonly choice: PlotReplacementChoice;
  };

function validateSelectedRunId(dataset: Dataset, runId: string): string {
  const parsed = canonicalRunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new PlotWorkspaceError(
      "invalid-run-id",
      `Run ID "${runId}" is not canonical (expected FLEX-NNN).`,
      { runId },
    );
  }
  if (!dataset.runs.some(({ id }) => id === parsed.data)) {
    throw new PlotWorkspaceError(
      "unknown-run",
      `Run ID "${parsed.data}" is not present in dataset "${dataset.version}".`,
      { runId: parsed.data, datasetVersion: dataset.version },
    );
  }
  return parsed.data;
}

function assertSelectionDataset(selection: PlotRunSelection, dataset: Dataset): void {
  assertDatasetShape(dataset);
  if (dataset.version !== selection.datasetVersion) {
    throw new PlotWorkspaceError(
      "dataset-version-mismatch",
      `Selection belongs to dataset "${selection.datasetVersion}" but the supplied dataset is "${dataset.version}". Rebuild the selection for the current corpus.`,
      {
        datasetVersion: dataset.version,
        expectedDatasetVersion: selection.datasetVersion,
      },
    );
  }
}

/**
 * Create an empty selection or restore an ordered one for the current corpus.
 * IDs must be canonical metadata run IDs present in `dataset`; duplicates,
 * unknown IDs and more than three runs are rejected.
 */
export function createPlotRunSelection(
  dataset: Dataset,
  runIds: readonly string[] = [],
): PlotRunSelection {
  assertDatasetShape(dataset);
  if (runIds.length > 3) {
    throw new PlotWorkspaceError(
      "selection-limit",
      `A plot workspace selection holds at most three runs; received ${runIds.length}.`,
      { runIds },
    );
  }
  if (new Set(runIds).size !== runIds.length) {
    throw new PlotWorkspaceError(
      "duplicate-run",
      "A plot workspace selection cannot contain the same run twice.",
      { runIds },
    );
  }
  const validated = runIds.map((runId) => validateSelectedRunId(dataset, runId));
  return plotRunSelectionSchema.parse({
    datasetVersion: dataset.version,
    runIds: validated,
    revision: 0,
  });
}

/**
 * Toggle one run in an ordered selection. A selected run is removed. A new run
 * is appended while fewer than three are selected. At three, the selection is
 * returned unchanged with an explicit replace-or-cancel choice.
 */
export function togglePlotRunSelection(
  selection: PlotRunSelection,
  dataset: Dataset,
  runId: string,
): PlotRunToggleResult {
  assertSelectionDataset(selection, dataset);
  const canonicalId = validateSelectedRunId(dataset, runId);

  if (selection.runIds.includes(canonicalId)) {
    return {
      status: "removed",
      selection: {
        datasetVersion: selection.datasetVersion,
        runIds: selection.runIds.filter((selected) => selected !== canonicalId),
        revision: selection.revision + 1,
      },
    };
  }

  if (selection.runIds.length >= 3) {
    return {
      status: "replacement-required",
      selection,
      choice: {
        datasetVersion: selection.datasetVersion,
        incomingRunId: canonicalId,
        selectionRunIds: [...selection.runIds],
        selectionRevision: selection.revision,
      },
    };
  }

  return {
    status: "added",
    selection: {
      datasetVersion: selection.datasetVersion,
      runIds: [...selection.runIds, canonicalId],
      revision: selection.revision + 1,
    },
  };
}

/**
 * Apply an explicit replacement at the slot occupied by `replacedRunId`.
 *
 * The choice must have been produced from the exact current selection (same
 * revision and same ordered IDs). Any change after the choice was shown raises
 * `stale-selection`; the caller must not guess an older slot.
 */
export function replacePlotRunSelection(
  selection: PlotRunSelection,
  dataset: Dataset,
  choice: PlotReplacementChoice,
  replacedRunId: string,
): PlotRunSelection {
  assertSelectionDataset(selection, dataset);
  if (choice.datasetVersion !== selection.datasetVersion) {
    throw new PlotWorkspaceError(
      "dataset-version-mismatch",
      `Replacement choice belongs to dataset "${choice.datasetVersion}" but the selection uses "${selection.datasetVersion}".`,
      {
        datasetVersion: selection.datasetVersion,
        expectedDatasetVersion: choice.datasetVersion,
      },
    );
  }
  if (
    choice.selectionRevision !== selection.revision
    || !sameStringArray(choice.selectionRunIds, selection.runIds)
  ) {
    throw new PlotWorkspaceError(
      "stale-selection",
      "The plot selection changed after the replacement choice was offered. Close the replacement picker and choose again.",
      {
        selectionRevision: selection.revision,
        choiceRevision: choice.selectionRevision,
        runIds: [...selection.runIds],
      },
    );
  }

  const incomingRunId = validateSelectedRunId(dataset, choice.incomingRunId);
  if (selection.runIds.includes(incomingRunId)) {
    throw new PlotWorkspaceError(
      "duplicate-run",
      `Run ID "${incomingRunId}" is already selected; a replacement must introduce a new run.`,
      { runId: incomingRunId, runIds: [...selection.runIds] },
    );
  }

  const slotIndex = selection.runIds.indexOf(replacedRunId);
  if (slotIndex < 0) {
    throw new PlotWorkspaceError(
      "run-not-selected",
      `Run ID "${replacedRunId}" is not in the current selection and has no slot to replace.`,
      { runId: replacedRunId, runIds: [...selection.runIds] },
    );
  }

  const runIds = [...selection.runIds];
  runIds[slotIndex] = incomingRunId;
  return {
    datasetVersion: selection.datasetVersion,
    runIds,
    revision: selection.revision + 1,
  };
}

/** Clear the selection. Clearing an already-empty selection is a no-op. */
export function clearPlotRunSelection(selection: PlotRunSelection): PlotRunSelection {
  if (selection.runIds.length === 0) return selection;
  return {
    datasetVersion: selection.datasetVersion,
    runIds: [],
    revision: selection.revision + 1,
  };
}

/** Empty, one-run inspection, or two/three-run comparison mode. */
export function plotRunSelectionMode(selection: PlotRunSelection): PlotSelectionMode {
  if (selection.runIds.length === 0) return "empty";
  return selection.runIds.length === 1 ? "inspection" : "comparison";
}

/** Comparison launch requires two or three distinct selected runs. */
export function canLaunchPlotComparison(selection: PlotRunSelection): boolean {
  return plotRunSelectionMode(selection) === "comparison";
}

/**
 * Map a nonempty selection to an explicit plot scope. An empty selection has no
 * explicit scope (`null`); the caller should use the active all/filtered scope.
 */
export function plotRunSelectionScope(selection: PlotRunSelection): RunScope | null {
  if (selection.runIds.length === 0) return null;
  return runScopeSchema.parse({
    kind: "explicit-runs",
    runIds: [...selection.runIds],
  });
}

// ---------------------------------------------------------------------------
// U03.6 — versioned plot export payload
// ---------------------------------------------------------------------------

export const plotExportAxisSchema = z.strictObject({
  field: numericFieldKeySchema,
  label: z.string().min(1).max(400),
  nativeUnit: z.string().min(1).max(64),
});
export type PlotExportAxis = z.infer<typeof plotExportAxisSchema>;

export const plotExportAxesSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("scatter"),
    x: plotExportAxisSchema,
    y: plotExportAxisSchema,
  }),
  z.strictObject({
    kind: z.literal("point-comparison"),
    y: plotExportAxisSchema,
  }),
]);
export type PlotExportAxes = z.infer<typeof plotExportAxesSchema>;

/** One plotted measurement, resolved from the authoritative corpus cell. */
export const plotExportSourceSchema = z.strictObject({
  axis: z.enum(["x", "y"]),
  reference: stableFieldReferenceSchema,
  value: finiteNumberSchema,
  original: z.string().nullable(),
  unit: z.string().min(1).max(64),
  locator: z.string().min(1).max(2000),
  label: z.string().min(1).max(400),
});
export type PlotExportSource = z.infer<typeof plotExportSourceSchema>;

/** One included point/table row in displayed order. */
export const plotExportRowSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  x: finiteNumberSchema.nullable(),
  y: finiteNumberSchema,
  group: z.string().min(1).max(80).nullable(),
  sourceReferences: z.array(plotExportSourceSchema).min(1).max(2),
});
export type PlotExportRow = z.infer<typeof plotExportRowSchema>;

export const plotExportCountsSchema = z.strictObject({
  resolved: z.int().nonnegative(),
  included: z.int().nonnegative(),
  omitted: z.int().nonnegative(),
});
export type PlotExportCounts = z.infer<typeof plotExportCountsSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

/**
 * `plot-export-1` payload. `rows` contains only plotted measurements in display
 * order; `omitted` is the separate omission record. A valid zero-row result has
 * empty `rows`/`omitted` and zero counts.
 */
export const plotExportPayloadSchema = z.strictObject({
  version: z.literal(plotExportPayloadVersion),
  dataset: z.strictObject({
    version: datasetVersionSchema,
  }),
  contracts: z.strictObject({
    plotSpec: z.literal(plotExportContractVersions.plotSpec),
    plotResult: z.literal(plotExportContractVersions.plotResult),
    fieldCatalog: z.literal(plotExportContractVersions.fieldCatalog),
    stableFieldReference: z.literal(plotExportContractVersions.stableFieldReference),
    runScope: z.literal(plotExportContractVersions.runScope),
    plotExport: z.literal(plotExportContractVersions.plotExport),
    scopeRuleVersion: z.literal(plotExportContractVersions.scopeRuleVersion),
    omissionRuleVersion: z.literal(plotExportContractVersions.omissionRuleVersion),
  }),
  spec: plotSpecSchema,
  axes: plotExportAxesSchema,
  scope: plotScopeSummarySchema,
  resolvedRunIds: z.array(canonicalRunIdSchema).max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct resolved run IDs"),
  rows: z.array(plotExportRowSchema).max(128),
  omitted: z.array(plotOmittedRunSchema).max(128),
  counts: plotExportCountsSchema,
  limitations: z.array(limitationSchema).min(1).max(12),
}).superRefine((payload, context) => {
  const { spec, axes, scope, counts } = payload;
  const expectedAxes = axisFieldPairs(spec);

  if (axes.kind !== spec.kind) {
    addIssue(context, ["axes", "kind"], "Axis kind must match the spec kind");
  }
  if (spec.kind === "scatter") {
    if (axes.kind === "scatter") {
      if (axes.x.field !== spec.axes.x.field) {
        addIssue(context, ["axes", "x", "field"], "x axis field must match the spec");
      }
      if (axes.y.field !== spec.axes.y.field) {
        addIssue(context, ["axes", "y", "field"], "y axis field must match the spec");
      }
    }
  } else if (axes.kind === "point-comparison") {
    if (axes.y.field !== spec.axes.y.field) {
      addIssue(context, ["axes", "y", "field"], "y axis field must match the spec");
    }
  }

  const axisEntries = axes.kind === "scatter"
    ? [{ axis: "x" as const, axisPayload: axes.x }, { axis: "y" as const, axisPayload: axes.y }]
    : [{ axis: "y" as const, axisPayload: axes.y }];
  for (const { axis, axisPayload } of axisEntries) {
    const definition = getFieldDefinition(axisPayload.field);
    if (axisPayload.label !== definition.label) {
      addIssue(context, ["axes", axis, "label"], "Axis label must match the reviewed field catalog");
    }
    if (definition.nativeUnit === null || axisPayload.nativeUnit !== definition.nativeUnit) {
      addIssue(context, ["axes", axis, "nativeUnit"], "Axis unit must be the reviewed native unit");
    }
  }

  if (scope.kind !== spec.scope.kind) {
    addIssue(context, ["scope", "kind"], "Scope kind must match the spec");
  }
  if (spec.scope.kind === "filtered-results") {
    if (!sameJson(scope.search, spec.scope.search)) {
      addIssue(context, ["scope", "search"], "Search request must match the spec");
    }
    if (!sameJson(scope.activeFilters, spec.scope.search.filters ?? [])) {
      addIssue(context, ["scope", "activeFilters"], "Active filters must match the spec filters");
    }
  } else {
    if (scope.search !== null) {
      addIssue(context, ["scope", "search"], "Only a filtered scope records a search request");
    }
    if (scope.activeFilters.length > 0) {
      addIssue(context, ["scope", "activeFilters"], "Only a filtered scope records active filters");
    }
  }
  if (spec.scope.kind === "explicit-runs" && !sameStringArray(payload.resolvedRunIds, spec.scope.runIds)) {
    addIssue(context, ["resolvedRunIds"], "Explicit scope resolved runs must retain caller order");
  }

  if (counts.resolved !== payload.resolvedRunIds.length) {
    addIssue(context, ["counts", "resolved"], "Resolved count must match resolvedRunIds");
  }
  if (counts.included !== payload.rows.length) {
    addIssue(context, ["counts", "included"], "Included count must match rows");
  }
  if (counts.omitted !== payload.omitted.length) {
    addIssue(context, ["counts", "omitted"], "Omitted count must match omitted records");
  }
  if (counts.resolved !== counts.included + counts.omitted) {
    addIssue(context, ["counts"], "Included and omitted counts must account for every resolved run");
  }

  const resolved = new Set(payload.resolvedRunIds);
  const rowIds = new Set<string>();
  for (const [index, row] of payload.rows.entries()) {
    if (rowIds.has(row.runId)) {
      addIssue(context, ["rows", index, "runId"], "Duplicate plotted run");
    }
    rowIds.add(row.runId);
    if (!resolved.has(row.runId)) {
      addIssue(context, ["rows", index, "runId"], "Plotted run is not in the resolved scope");
    }
    if (spec.kind === "scatter" && row.x === null) {
      addIssue(context, ["rows", index, "x"], "Scatter rows need a numeric x value");
    }
    if (spec.kind === "point-comparison" && row.x !== null) {
      addIssue(context, ["rows", index, "x"], "Point-comparison rows keep x categorical (null)");
    }
    if (row.sourceReferences.length !== expectedAxes.length) {
      addIssue(
        context,
        ["rows", index, "sourceReferences"],
        "A row must carry exactly one stable source per plotted axis",
      );
    }

    for (const source of row.sourceReferences) {
      const expected = expectedAxes.find(({ axis }) => axis === source.axis);
      if (!expected || expected.fieldKey !== source.reference.fieldKey) {
        addIssue(context, ["rows", index, "sourceReferences"], "Source does not match a requested axis");
        continue;
      }
      if (source.reference.runId !== row.runId) {
        addIssue(context, ["rows", index, "sourceReferences"], "Source run must match the row run");
      }
      if (source.reference.datasetVersion !== payload.dataset.version) {
        addIssue(context, ["rows", index, "sourceReferences"], "Source dataset version must match the payload dataset");
      }
      const coordinate = source.axis === "x" ? row.x : row.y;
      if (coordinate === null || source.value !== coordinate) {
        addIssue(context, ["rows", index, source.axis], "Source value must equal the plotted coordinate");
      }
      const definition = getFieldDefinition(source.reference.fieldKey);
      if (definition.nativeUnit === null || source.unit !== definition.nativeUnit) {
        addIssue(context, ["rows", index, "sourceReferences"], "Source unit must be the reviewed native unit");
      }
      if (source.label !== definition.label) {
        addIssue(context, ["rows", index, "sourceReferences"], "Source label must match the reviewed field catalog");
      }
    }

    for (const expected of expectedAxes) {
      const matches = row.sourceReferences.filter(({ axis }) => axis === expected.axis);
      if (matches.length !== 1 || matches[0].reference.fieldKey !== expected.fieldKey) {
        addIssue(context, ["rows", index, "sourceReferences"], "Each plotted axis needs exactly one matching source");
      }
    }
  }

  const omittedIds = new Set<string>();
  for (const [index, omitted] of payload.omitted.entries()) {
    if (omittedIds.has(omitted.runId)) {
      addIssue(context, ["omitted", index, "runId"], "Duplicate omitted run");
    }
    omittedIds.add(omitted.runId);
    if (!resolved.has(omitted.runId)) {
      addIssue(context, ["omitted", index, "runId"], "Omitted run is not in the resolved scope");
    }
    if (rowIds.has(omitted.runId)) {
      addIssue(context, ["omitted", index, "runId"], "An omitted run cannot also be a plotted row");
    }
  }
  for (const runId of resolved) {
    if (!rowIds.has(runId) && !omittedIds.has(runId)) {
      addIssue(context, ["resolvedRunIds"], `Resolved run is unaccounted for: ${runId}`);
    }
  }
});

export type PlotExportPayload = z.infer<typeof plotExportPayloadSchema>;

function exportAxis(fieldKey: NumericFieldKey): PlotExportAxis {
  const definition = getFieldDefinition(fieldKey);
  if (
    definition.dataType !== "numeric"
    || !definition.axisEligible
    || definition.nativeUnit === null
  ) {
    throw new PlotWorkspaceError(
      "axes-mismatch",
      `Axis field "${fieldKey}" is not an axis-eligible numeric field with a native unit.`,
      { fieldKey },
    );
  }
  return {
    field: fieldKey,
    label: definition.label,
    nativeUnit: definition.nativeUnit,
  };
}

function exportAxesForSpec(spec: PlotSpec): PlotExportAxes {
  return spec.kind === "scatter"
    ? { kind: "scatter", x: exportAxis(spec.axes.x.field), y: exportAxis(spec.axes.y.field) }
    : { kind: "point-comparison", y: exportAxis(spec.axes.y.field) };
}

function assertSpecResultAxes(spec: PlotSpec, result: PlotResult): void {
  if (result.kind !== spec.kind) {
    throw new PlotWorkspaceError(
      "spec-result-mismatch",
      `Plot spec kind "${spec.kind}" does not match result kind "${result.kind}".`,
    );
  }
  if (result.grouping !== spec.grouping) {
    throw new PlotWorkspaceError(
      "spec-result-mismatch",
      `Plot spec grouping "${spec.grouping}" does not match result grouping "${result.grouping}".`,
    );
  }
  if (spec.kind === "scatter") {
    if (
      result.axes.kind !== "scatter"
      || result.axes.x !== spec.axes.x.field
      || result.axes.y !== spec.axes.y.field
    ) {
      throw new PlotWorkspaceError(
        "axes-mismatch",
        "Plot spec and result must use the same two scatter axis fields.",
        { fieldKey: [spec.axes.x.field, spec.axes.y.field].join(",") },
      );
    }
  } else if (result.axes.kind !== "point-comparison" || result.axes.y !== spec.axes.y.field) {
    throw new PlotWorkspaceError(
      "axes-mismatch",
      "Plot spec and result must use the same point-comparison measurement field.",
      { fieldKey: spec.axes.y.field },
    );
  }
}

function assertSpecResultScope(
  dataset: Dataset,
  spec: PlotSpec,
  result: PlotResult,
): void {
  const resolution = resolveRunScope(dataset, spec.scope);
  if (!resolution.ok) {
    throw new PlotWorkspaceError(
      "scope-mismatch",
      `The plot spec scope does not resolve against dataset "${dataset.version}": ${formatCorpusIssues(resolution.issues)}`,
      { issues: resolution.issues },
    );
  }
  const resolved = resolution.resolved;
  if (!sameStringArray(resolved.runIds, result.resolvedRunIds)) {
    throw new PlotWorkspaceError(
      "scope-mismatch",
      "Plot spec resolved run IDs do not match the result resolved run IDs.",
      { runIds: [...result.resolvedRunIds], datasetVersion: dataset.version },
    );
  }
  if (result.scope.kind !== resolved.scopeKind) {
    throw new PlotWorkspaceError(
      "scope-mismatch",
      `Plot spec scope kind "${resolved.scopeKind}" does not match result scope kind "${result.scope.kind}".`,
    );
  }
  if (!sameJson(result.scope.search, resolved.search)) {
    throw new PlotWorkspaceError(
      "scope-mismatch",
      "Plot spec scope search does not match the result scope search.",
      { datasetVersion: dataset.version },
    );
  }
  if (!sameJson(result.scope.activeFilters, resolved.activeFilters)) {
    throw new PlotWorkspaceError(
      "scope-mismatch",
      "Plot spec scope filters do not match the result active filters.",
      { datasetVersion: dataset.version },
    );
  }
}

function exportSource(
  dataset: Dataset,
  point: PlotPoint,
  axis: "x" | "y",
  fieldKey: NumericFieldKey,
  coordinate: number | null,
): PlotExportSource {
  const matches = point.sourceReferences.filter(({ fieldKey: key }) => key === fieldKey);
  if (matches.length !== 1) {
    throw new PlotWorkspaceError(
      "source-mismatch",
      `Plotted run ${point.runId} needs exactly one "${fieldKey}" source reference for the ${axis} axis.`,
      { runId: point.runId, fieldKey, axis },
    );
  }
  const reference = matches[0];
  if (reference.runId !== point.runId) {
    throw new PlotWorkspaceError(
      "source-mismatch",
      `Source reference run "${reference.runId}" does not match plotted run "${point.runId}".`,
      { runId: point.runId, fieldKey, axis },
    );
  }
  if (reference.datasetVersion !== dataset.version) {
    throw new PlotWorkspaceError(
      "dataset-version-mismatch",
      `Source reference dataset version "${reference.datasetVersion}" does not match "${dataset.version}".`,
      {
        datasetVersion: dataset.version,
        expectedDatasetVersion: reference.datasetVersion,
        runId: point.runId,
        fieldKey,
        axis,
      },
    );
  }

  const resolution = resolveStableFieldReference(dataset, reference);
  if (resolution.status !== "resolved") {
    const versionMismatch = resolution.status === "dataset-version-mismatch";
    throw new PlotWorkspaceError(
      versionMismatch ? "dataset-version-mismatch" : "source-mismatch",
      `Source reference ${point.runId}/${fieldKey} did not resolve against dataset "${dataset.version}" (${resolution.status}).`,
      {
        runId: point.runId,
        fieldKey,
        axis,
        datasetVersion: dataset.version,
        ...(versionMismatch ? { expectedDatasetVersion: resolution.actualDatasetVersion } : {}),
      },
    );
  }

  const definition = getFieldDefinition(fieldKey);
  if (definition.nativeUnit === null) {
    throw new PlotWorkspaceError(
      "axes-mismatch",
      `Axis field "${fieldKey}" has no reviewed native unit.`,
      { fieldKey, axis },
    );
  }
  if (resolution.field.unit !== definition.nativeUnit) {
    throw new PlotWorkspaceError(
      "unit-mismatch",
      `Axis field "${fieldKey}" is recorded as ${resolution.field.unit === null ? "no unit" : `"${resolution.field.unit}"`} for run ${point.runId}, but the reviewed native unit is "${definition.nativeUnit}".`,
      { runId: point.runId, fieldKey, axis },
    );
  }
  if (
    typeof resolution.field.value !== "number"
    || !Number.isFinite(resolution.field.value)
    || coordinate === null
    || resolution.field.value !== coordinate
  ) {
    throw new PlotWorkspaceError(
      "source-mismatch",
      `Plotted ${axis} value for run ${point.runId} does not match the recorded "${fieldKey}" source value.`,
      { runId: point.runId, fieldKey, axis },
    );
  }

  return {
    axis,
    reference,
    value: resolution.field.value,
    original: resolution.field.original,
    unit: definition.nativeUnit,
    locator: resolution.field.locator,
    label: definition.label,
  };
}

/**
 * Build the versioned, validated JSON export payload for one plot. The spec and
 * result must describe the same kind, grouping, axes and resolved scope; every
 * plotted source value is resolved from `dataset`, whose version must equal the
 * result's dataset version.
 */
export function buildPlotExportPayload(
  dataset: Dataset,
  spec: PlotSpec,
  result: PlotResult,
): PlotExportPayload {
  assertDatasetShape(dataset);

  const parsedSpec = plotSpecSchema.safeParse(spec);
  if (!parsedSpec.success) {
    const specIssues = formatZodIssues(parsedSpec.error.issues);
    throw new PlotWorkspaceError(
      "invalid-spec",
      `Invalid plot spec: ${specIssues.join("; ")}`,
      { specIssues },
    );
  }
  const canonicalSpec = parsedSpec.data;

  const parsedResult = plotResultSchema.safeParse(result);
  if (!parsedResult.success) {
    const resultIssues = formatZodIssues(parsedResult.error.issues);
    throw new PlotWorkspaceError(
      "invalid-result",
      `Invalid plot result: ${resultIssues.join("; ")}`,
      { resultIssues },
    );
  }
  const canonicalResult = parsedResult.data;

  if (canonicalResult.datasetVersion !== dataset.version) {
    throw new PlotWorkspaceError(
      "dataset-version-mismatch",
      `Plot result dataset version "${canonicalResult.datasetVersion}" does not match "${dataset.version}". Resolve source values only from the matching corpus.`,
      {
        datasetVersion: dataset.version,
        expectedDatasetVersion: canonicalResult.datasetVersion,
      },
    );
  }

  assertSpecResultAxes(canonicalSpec, canonicalResult);
  const axes = exportAxesForSpec(canonicalSpec);
  const recordedFieldKeys = new Set(dataset.runs.flatMap((run) => run.fields.map(({ key }) => key)));
  for (const { fieldKey } of axisFieldPairs(canonicalSpec)) {
    if (!recordedFieldKeys.has(fieldKey)) {
      throw new PlotWorkspaceError(
        "axes-mismatch",
        `Axis field "${fieldKey}" is absent from dataset "${dataset.version}".`,
        { fieldKey, datasetVersion: dataset.version },
      );
    }
  }
  assertSpecResultScope(dataset, canonicalSpec, canonicalResult);

  const corpusIssues = validatePlotResultAgainstDataset(dataset, canonicalResult);
  if (corpusIssues.length > 0) {
    throw new PlotWorkspaceError(
      "source-mismatch",
      `Plot result source references do not resolve against dataset "${dataset.version}": ${formatCorpusIssues(corpusIssues)}`,
      { issues: corpusIssues },
    );
  }

  const rows: PlotExportRow[] = canonicalResult.points.map((point) => {
    const sourceReferences = canonicalSpec.kind === "scatter"
      ? [
        exportSource(dataset, point, "x", canonicalSpec.axes.x.field, point.x),
        exportSource(dataset, point, "y", canonicalSpec.axes.y.field, point.y),
      ]
      : [exportSource(dataset, point, "y", canonicalSpec.axes.y.field, point.y)];
    return {
      runId: point.runId,
      x: point.x,
      y: point.y,
      group: point.group,
      sourceReferences,
    };
  });

  const omitted = canonicalResult.omitted.map(({ runId, reasons }) => ({
    runId,
    reasons: [...reasons],
  }));

  const counts = {
    resolved: canonicalResult.resolvedRunIds.length,
    included: rows.length,
    omitted: omitted.length,
  };
  if (
    counts.resolved !== canonicalResult.includedCount + canonicalResult.omittedCount
    || counts.included !== canonicalResult.includedCount
    || counts.omitted !== canonicalResult.omittedCount
  ) {
    throw new PlotWorkspaceError(
      "count-mismatch",
      "Plot result counts do not account for every resolved run exactly once.",
      {
        runIds: [...canonicalResult.resolvedRunIds],
        datasetVersion: dataset.version,
      },
    );
  }

  const payload: PlotExportPayload = {
    version: plotExportPayloadVersion,
    dataset: { version: dataset.version },
    contracts: { ...plotExportContractVersions },
    spec: canonicalSpec,
    axes,
    scope: {
      kind: canonicalResult.scope.kind,
      search: canonicalResult.scope.search,
      activeFilters: [...canonicalResult.scope.activeFilters],
    },
    resolvedRunIds: [...canonicalResult.resolvedRunIds],
    rows,
    omitted,
    counts,
    limitations: [...canonicalResult.limitations],
  };

  const validated = plotExportPayloadSchema.safeParse(payload);
  if (!validated.success) {
    const specIssues = formatZodIssues(validated.error.issues);
    throw new PlotWorkspaceError(
      "contract-violation",
      `Plot export payload failed plot-export-1 validation: ${specIssues.join("; ")}`,
      { specIssues },
    );
  }
  return validated.data;
}
