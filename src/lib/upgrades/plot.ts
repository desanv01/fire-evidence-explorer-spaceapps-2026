import { z } from "zod";
import { runSearchSchema, type Dataset } from "../evidence.ts";
import {
  fieldDefinitionByKey,
  numericFieldKeySchema,
  type NumericFieldKey,
} from "./field-catalog.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetVersionSchema,
  finiteNumberSchema,
  resolveStableFieldReference,
  stableFieldReferenceSchema,
  type CorpusValidationIssue,
} from "./provenance.ts";
import {
  activeFilterSchema,
  runScopeSchema,
  runSelectionSchema,
  resolveRunScope,
  validateRunScopeAgainstDataset,
  type RunScope,
  type RunSelection,
} from "./scope.ts";
import { upgradeContractVersions } from "./versions.ts";

const limitationSchema = z.string().min(1).max(500);

export const plotKindSchema = z.enum(["scatter", "point-comparison"]);
export type PlotKind = z.infer<typeof plotKindSchema>;

export const fuelGroupingSchema = z.enum(["none", "fuel"]);
export type FuelGrouping = z.infer<typeof fuelGroupingSchema>;

export const plotAxisSchema = z.strictObject({
  field: numericFieldKeySchema,
});
export type PlotAxis = z.infer<typeof plotAxisSchema>;

const scatterAxesSchema = z.strictObject({
  x: plotAxisSchema,
  y: plotAxisSchema,
});

const pointComparisonAxesSchema = z.strictObject({
  y: plotAxisSchema,
});

/**
 * A validated plot request. Numeric axes are reviewed catalog keys; fuel is the
 * only approved grouping. The scope is resolved separately before any data is
 * plotted, and plotted rows are never automatically the comparison selection.
 */
export const scatterPlotSpecSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.plotSpec),
  kind: z.literal("scatter"),
  axes: scatterAxesSchema,
  grouping: fuelGroupingSchema,
  scope: runScopeSchema,
}).superRefine((spec, context) => {
  if (spec.axes.x.field === spec.axes.y.field) {
    context.addIssue({
      code: "custom",
      path: ["axes"],
      message: "Scatter axes must use two different numeric fields",
    });
  }
});

export const pointComparisonPlotSpecSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.plotSpec),
  kind: z.literal("point-comparison"),
  axes: pointComparisonAxesSchema,
  grouping: fuelGroupingSchema,
  scope: runScopeSchema,
});

export const plotSpecSchema = z.discriminatedUnion("kind", [
  scatterPlotSpecSchema,
  pointComparisonPlotSpecSchema,
]);
export type ScatterPlotSpec = z.infer<typeof scatterPlotSpecSchema>;
export type PointComparisonPlotSpec = z.infer<typeof pointComparisonPlotSpecSchema>;
export type PlotSpec = z.infer<typeof plotSpecSchema>;

export const plotSelectionSchema = runSelectionSchema;
export type PlotSelection = RunSelection;

export function plotAxisFields(spec: PlotSpec): NumericFieldKey[] {
  return spec.kind === "scatter" ? [spec.axes.x.field, spec.axes.y.field] : [spec.axes.y.field];
}

export function plotAxisUnits(spec: PlotSpec): { x: string | null; y: string | null } {
  return spec.kind === "scatter"
    ? {
      x: fieldDefinitionByKey[spec.axes.x.field].nativeUnit,
      y: fieldDefinitionByKey[spec.axes.y.field].nativeUnit,
    }
    : { x: null, y: fieldDefinitionByKey[spec.axes.y.field].nativeUnit };
}

export const plotLimitations = [
  "Only runs with finite recorded values for each required axis are included; no value is interpolated.",
  "Null values are unknown and are omitted from an axis that requires them. Zero remains a recorded value.",
  "Each point represents one reviewed run. A plot does not by itself establish a trend, equivalence, or causation.",
  "Matching or differing recorded values cannot establish scientific equivalence; unrecorded conditions may affect outcomes.",
] as const;

export function plotLimitationsForSpec(spec: PlotSpec): string[] {
  const limits: string[] = [...plotLimitations];
  if (plotAxisFields(spec).includes("extinction_diameter")) {
    limits.push(
      "Visible-extinction diameters may include values estimated from burning history; the selected source does not flag individual estimates.",
    );
  }
  return limits;
}

export const plotOmittedReasonSchema = z.enum([
  "missing-x",
  "missing-y",
  "non-numeric-x",
  "non-numeric-y",
]);
export type PlotOmittedReason = z.infer<typeof plotOmittedReasonSchema>;

export const plotOmittedRunSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  reasons: z.array(plotOmittedReasonSchema).min(1).max(2)
    .refine((reasons) => new Set(reasons).size === reasons.length, "Omission reasons must be distinct"),
});
export type PlotOmittedRun = z.infer<typeof plotOmittedRunSchema>;

export const plotPointSchema = z.strictObject({
  runId: canonicalRunIdSchema,
  /** Null only for point-comparison plots, whose categorical axis is run identity. */
  x: finiteNumberSchema.nullable(),
  y: finiteNumberSchema,
  group: z.string().min(1).max(80).nullable(),
  sourceReferences: z.array(stableFieldReferenceSchema).min(1).max(2),
});
export type PlotPoint = z.infer<typeof plotPointSchema>;

export const plotScopeSummarySchema = z.strictObject({
  kind: z.enum(["all-reviewed-runs", "filtered-results", "explicit-runs"]),
  search: runSearchSchema.nullable(),
  activeFilters: z.array(activeFilterSchema).max(16),
});

export const plotResultSchema = z.strictObject({
  version: z.literal(upgradeContractVersions.plotResult),
  specVersion: z.literal(upgradeContractVersions.plotSpec),
  kind: plotKindSchema,
  datasetVersion: datasetVersionSchema,
  axes: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("scatter"), x: numericFieldKeySchema, y: numericFieldKeySchema }),
    z.strictObject({ kind: z.literal("point-comparison"), y: numericFieldKeySchema }),
  ]),
  grouping: fuelGroupingSchema,
  scope: plotScopeSummarySchema,
  /**
   * Empty only for a valid zero-row scope. The count and partition refinements
   * below then require `points`, `omitted`, and both counts to be zero too.
   */
  resolvedRunIds: z.array(canonicalRunIdSchema).max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct resolved run IDs"),
  includedCount: z.int().nonnegative(),
  omittedCount: z.int().nonnegative(),
  points: z.array(plotPointSchema).max(128),
  omitted: z.array(plotOmittedRunSchema).max(128),
  limitations: z.array(limitationSchema).min(1).max(12),
}).superRefine((result, context) => {
  if (result.includedCount !== result.points.length) {
    context.addIssue({ code: "custom", path: ["includedCount"], message: "Included count does not match points" });
  }
  if (result.omittedCount !== result.omitted.length) {
    context.addIssue({ code: "custom", path: ["omittedCount"], message: "Omitted count does not match omitted records" });
  }
  if (result.axes.kind !== result.kind) {
    context.addIssue({ code: "custom", path: ["axes", "kind"], message: "Axis kind does not match plot kind" });
  }
  if (result.axes.kind === "scatter" && result.axes.x === result.axes.y) {
    context.addIssue({ code: "custom", path: ["axes"], message: "Scatter axes must use two different fields" });
  }
  if (result.includedCount + result.omittedCount !== result.resolvedRunIds.length) {
    context.addIssue({
      code: "custom",
      path: ["includedCount"],
      message: "Included and omitted counts must account for every resolved run",
    });
  }

  const pointIds = new Set<string>();
  for (const [index, point] of result.points.entries()) {
    if (pointIds.has(point.runId)) {
      context.addIssue({ code: "custom", path: ["points", index, "runId"], message: "Duplicate plotted run" });
    }
    pointIds.add(point.runId);
    if (result.kind === "scatter") {
      if (point.x === null) {
        context.addIssue({ code: "custom", path: ["points", index, "x"], message: "Scatter points need a numeric x value" });
      }
      if (point.sourceReferences.length !== 2) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "sourceReferences"],
          message: "Scatter points need both axis source references",
        });
      }
    } else {
      if (point.x !== null) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "x"],
          message: "Point-comparison x must be null; run identity is categorical",
        });
      }
      if (point.sourceReferences.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "sourceReferences"],
          message: "Point-comparison points need one source reference",
        });
      }
    }
    if (result.grouping === "fuel" && point.group === null) {
      context.addIssue({ code: "custom", path: ["points", index, "group"], message: "Fuel grouping needs a fuel group" });
    }
    if (result.grouping === "none" && point.group !== null) {
      context.addIssue({ code: "custom", path: ["points", index, "group"], message: "Ungrouped points cannot carry a group" });
    }
  }

  const omittedIds = new Set<string>();
  for (const [index, omitted] of result.omitted.entries()) {
    if (omittedIds.has(omitted.runId)) {
      context.addIssue({ code: "custom", path: ["omitted", index, "runId"], message: "Duplicate omitted run" });
    }
    omittedIds.add(omitted.runId);
    if (result.kind === "point-comparison" && omitted.reasons.some((reason) => reason.endsWith("-x"))) {
      context.addIssue({
        code: "custom",
        path: ["omitted", index, "reasons"],
        message: "Point-comparison omissions cannot be x-axis omissions",
      });
    }
  }

  const resolved = new Set(result.resolvedRunIds);
  for (const id of [...pointIds, ...omittedIds]) {
    if (!resolved.has(id)) {
      context.addIssue({ code: "custom", path: ["resolvedRunIds"], message: `Run is not in the resolved scope: ${id}` });
    }
  }
  for (const id of resolved) {
    if (!pointIds.has(id) && !omittedIds.has(id)) {
      context.addIssue({ code: "custom", path: ["resolvedRunIds"], message: `Resolved run is unaccounted for: ${id}` });
    }
  }
});

export type PlotResult = z.infer<typeof plotResultSchema>;

export function plotSelectionRunIds(selection: PlotSelection): string[] {
  return selection.mode === "inspection" ? [selection.runId] : [...selection.runIds];
}

export function validatePlotSelectionAgainstDataset(
  dataset: Dataset,
  selection: PlotSelection,
  path = "selection",
): CorpusValidationIssue[] {
  const known = new Set(dataset.runs.map(({ id }) => id));
  return plotSelectionRunIds(selection).flatMap((runId, index) => known.has(runId)
    ? []
    : [corpusIssue(`${path}.${index}`, "unknown-run", `Unknown run ID: ${runId}`)]);
}

export function validatePlotSpecAgainstDataset(
  dataset: Dataset,
  spec: PlotSpec,
  path = "plot",
): CorpusValidationIssue[] {
  const issues = validateRunScopeAgainstDataset(dataset, spec.scope, `${path}.scope`);
  const fields = new Set(dataset.runs.flatMap((run) => run.fields.map(({ key }) => key)));
  for (const field of plotAxisFields(spec)) {
    if (!fields.has(field)) {
      issues.push(corpusIssue(`${path}.axes`, "unknown-field", `Axis field is absent from the dataset: ${field}`));
    }
  }
  return issues;
}

/**
 * Resolve the scope separately from plotting. The resolved run list can contain
 * many plotted rows; selecting two or three of them for comparison remains a
 * later, explicit user action.
 */
export function resolvePlotScope(dataset: Dataset, spec: PlotSpec) {
  return resolveRunScope(dataset, spec.scope);
}

export function resolvePlotScopeOrThrow(dataset: Dataset, spec: PlotSpec) {
  const resolution = resolvePlotScope(dataset, spec);
  if (!resolution.ok) throw new RangeError(resolution.issues.map(({ message }) => message).join("; "));
  return resolution.resolved;
}

export function validatePlotResultAgainstDataset(
  dataset: Dataset,
  result: PlotResult,
  path = "plotResult",
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  if (result.datasetVersion !== dataset.version) {
    issues.push(corpusIssue(
      `${path}.datasetVersion`,
      "version-mismatch",
      `Result dataset version ${result.datasetVersion} does not match ${dataset.version}`,
    ));
    return issues;
  }
  const known = new Set(dataset.runs.map(({ id }) => id));
  for (const [index, runId] of result.resolvedRunIds.entries()) {
    if (!known.has(runId)) {
      issues.push(corpusIssue(`${path}.resolvedRunIds.${index}`, "unknown-run", `Unknown run ID: ${runId}`));
    }
  }
  for (const [index, point] of result.points.entries()) {
    for (const [referenceIndex, reference] of point.sourceReferences.entries()) {
      const resolution = resolveStableFieldReference(dataset, reference);
      if (resolution.status !== "resolved") {
        issues.push(corpusIssue(
          `${path}.points.${index}.sourceReferences.${referenceIndex}`,
          resolution.status === "dataset-version-mismatch" ? "version-mismatch"
            : resolution.status === "unknown-run" ? "unknown-run"
            : resolution.status === "unknown-field" ? "unknown-field"
            : resolution.status === "unknown-source" ? "unknown-source" : "source-mismatch",
          `Source reference did not resolve: ${reference.runId}/${reference.fieldKey}`,
        ));
      }
    }
  }
  for (const [index, omitted] of result.omitted.entries()) {
    if (!known.has(omitted.runId)) {
      issues.push(corpusIssue(`${path}.omitted.${index}`, "unknown-run", `Unknown omitted run ID: ${omitted.runId}`));
    }
  }
  return issues;
}

export function collectPlotSourceReferences(result: PlotResult) {
  const byKey = new Map<string, PlotResult["points"][number]["sourceReferences"][number]>();
  for (const point of result.points) {
    for (const reference of point.sourceReferences) {
      byKey.set(JSON.stringify([reference.datasetVersion, reference.runId, reference.fieldKey, reference.sourceId]), reference);
    }
  }
  return [...byKey.values()];
}

export const plotScopeSchema = runScopeSchema;
export type PlotScope = RunScope;
