/**
 * U03 Visual Evidence Lab engine — deterministic PlotResult construction.
 *
 * `buildPlotResult(dataset, spec)` is a pure, browser-safe function: it reads
 * the parsed corpus and a `plot-spec-1` request, and returns the accepted
 * `PlotResult` (`plot-result-1`) that chart, table and assistant consumers
 * share. It performs no rendering, selection-state management, persistence,
 * provider calls, unit conversion or interpolation.
 *
 * ## Consumption guide
 *
 * - Chart: plot `result.points` with `x`/`y` in their native units. Axis units
 *   come from the reviewed catalog (`plotAxisUnits(spec)` in `plot.ts`); the
 *   `plot-result-1` shape carries field keys, not units. For
 *   `kind: "point-comparison"`, `x` is always `null`; the categorical x
 *   position is run identity (`runId`), and `y` is the selected measurement.
 * - Table: `resolvedRunIds` is the canonical row order. Map each ID to its
 *   `points` row (included) or `omitted` row (excluded with reasons). The two
 *   lists plus the counts account for every scoped run exactly once. Omitted
 *   rows carry only `runId`/`reasons` by contract; resolve any other field for
 *   an omitted run from the corpus by run ID.
 * - Assistant/export: use `includedCount`, `omittedCount`, `omitted` reasons,
 *   `limitations` and the per-point `sourceReferences`. A stable reference
 *   resolves the raw `value`, `original` and `locator` from the authoritative
 *   dataset through `resolveStableFieldReference`; do not rebuild them from
 *   display text.
 * - Grouping: when `grouping` is `"fuel"`, every point carries the run's
 *   recorded fuel label; otherwise `group` is `null`.
 * - Empty scope: a valid scope may resolve to zero runs. The normal result then
 *   has empty `resolvedRunIds`, `points` and `omitted` arrays with zero counts;
 *   its axes, grouping, resolved scope, active filters and limitations are
 *   preserved. Render an empty state from that result. This is distinct from a
 *   nonempty scope whose runs all lack a required measurement: those runs stay
 *   in `resolvedRunIds` and are counted in `omitted` with reasons.
 *
 * ```ts
 * const spec = plotSpecSchema.parse(rawSpec);
 * const result = buildPlotResult(dataset, spec); // throws only for invalid input
 * if (result.resolvedRunIds.length === 0) {
 *   renderEmptyState(result.scope); // valid zero-row scope, not an error
 * } else {
 *   renderPoints(result.points, plotAxisUnits(spec)); // units from the catalog
 * }
 * ```
 *
 * ## Contract behavior and limits
 *
 * - The spec is parsed with `plotSpecSchema`; scopes are resolved through
 *   `resolveRunScope`, so all/filtered/explicit order and filter semantics match
 *   the shared contract (`catalog order`, `catalog order after filtering`,
 *   caller order).
 * - Only reviewed, axis-eligible numeric fields with a native unit can be axes.
 *   Recorded values must be finite numbers in that native unit; zero is a real
 *   value, `null` is unknown.
 * - A run missing either required axis value is omitted with a frozen
 *   `plot-result-1` reason (`missing-x`/`missing-y`/`non-numeric-x`/
 *   `non-numeric-y`), never dropped silently.
 * - Unknown explicit run IDs, an absent axis field, a non-native recorded unit,
 *   missing fuel for a requested fuel grouping, and scopes beyond the frozen
 *   result bounds are reported as a typed `PlotEngineError`. A valid empty scope
 *   is not an error: it returns a normal zero-row `PlotResult`.
 * - `plot-result-1` allows zero resolved runs only when `resolvedRunIds`,
 *   `points` and `omitted` are all empty and both counts are zero. It is still
 *   bounded to 128 resolved runs / 16 active filters, and those bounds apply
 *   even when the scope happens to resolve to zero rows.
 *
 * Import this module directly: `buildPlotResult` is exported from
 * `src/lib/upgrades/plot-engine.ts` (U03 owns this file; `index.ts` is not
 * changed). Invalid input throws `PlotEngineError`; use `isPlotEngineError` or
 * `error.code` for branching.
 */
import type { Dataset, Run, RunField } from "../evidence.ts";
import {
  getFieldDefinition,
  numericFieldKeys,
  type NumericFieldKey,
} from "./field-catalog.ts";
import {
  plotAxisFields,
  plotLimitationsForSpec,
  plotResultSchema,
  plotSpecSchema,
  validatePlotResultAgainstDataset,
  validatePlotSpecAgainstDataset,
  type PlotOmittedReason,
  type PlotOmittedRun,
  type PlotPoint,
  type PlotResult,
  type PlotSpec,
} from "./plot.ts";
import {
  ruleVersions,
  type CorpusValidationIssue,
  type StableFieldReference,
} from "./provenance.ts";
import { resolveRunScope, type ResolvedRunScope } from "./scope.ts";
import { upgradeContractVersions } from "./versions.ts";

/** Mirrors the frozen `plot-result-1` bounds in `plot.ts`. */
export const plotEngineLimits = {
  resolvedRunCount: 128,
  activeFilterCount: 16,
} as const;

/**
 * Deterministic rule versions for the operations this engine performs. They are
 * not embedded in `PlotResult` (its schema is closed); carry them in assistant
 * prose, notebook metadata or export headers when labelling the operation.
 */
export const plotEngineRuleVersions = {
  scope: ruleVersions.plotScope,
  omissionAccounting: ruleVersions.omissionAccounting,
  provenance: ruleVersions.provenance,
} as const;

export const plotEngineErrorCodes = [
  "invalid-dataset",
  "invalid-spec",
  "invalid-scope",
  "unknown-runs",
  "axis-incompatible",
  "axis-unavailable",
  "axis-unit-mismatch",
  "grouping-unavailable",
  "scope-limit",
  "contract-violation",
] as const;

export type PlotEngineErrorCode = (typeof plotEngineErrorCodes)[number];

export type PlotAxisUnitMismatch = {
  readonly runId: string;
  readonly fieldKey: NumericFieldKey;
  readonly recordedUnit: string | null;
  readonly nativeUnit: string;
};

export type PlotEngineErrorDetails = {
  /** Corpus validator issues, when the failure came from scope/axis checks. */
  readonly issues?: readonly CorpusValidationIssue[];
  /** Flattened spec parse issues, when the failure came from `plotSpecSchema`. */
  readonly specIssues?: readonly string[];
  /** Run IDs implicated by the failure (unknown, ungrouped or unit-mismatched). */
  readonly runIds?: readonly string[];
  /** Axis field keys implicated by the failure. */
  readonly fieldKeys?: readonly string[];
  /** Recorded-vs-native unit conflicts for the values that would be plotted. */
  readonly units?: readonly PlotAxisUnitMismatch[];
  /** Scope summary for the failure, when the scope itself was valid. */
  readonly scope?: PlotResult["scope"];
  /** Resolved run IDs for a failure that concerns the resolved scope. */
  readonly resolvedRunIds?: readonly string[];
  readonly rowCount?: number;
  readonly rowLimit?: number;
  readonly filterCount?: number;
  readonly filterLimit?: number;
};

/**
 * Typed failure for invalid or unrepresentable plot requests. It is thrown only
 * before a caller could observe a partial `PlotResult`.
 */
export class PlotEngineError extends Error {
  readonly code: PlotEngineErrorCode;
  readonly details: PlotEngineErrorDetails;

  constructor(
    code: PlotEngineErrorCode,
    message: string,
    details: PlotEngineErrorDetails = {},
  ) {
    super(message);
    this.name = "PlotEngineError";
    this.code = code;
    this.details = details;
  }
}

export function isPlotEngineError(value: unknown): value is PlotEngineError {
  return value instanceof PlotEngineError;
}

type PlotScopeSummary = PlotResult["scope"];

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
    throw new PlotEngineError(
      "invalid-dataset",
      "buildPlotResult needs a parsed dataset with a non-empty version, sources and runs. Parse the corpus with parseDataset before plotting.",
    );
  }
}

function formatSpecIssues(
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

function scopeSummary(resolved: ResolvedRunScope): PlotScopeSummary {
  return {
    kind: resolved.scopeKind,
    search: resolved.search,
    activeFilters: [...resolved.activeFilters],
  };
}

type AxisReading =
  | {
    readonly status: "value";
    readonly fieldKey: NumericFieldKey;
    readonly field: RunField;
    readonly value: number;
  }
  | { readonly status: "missing" }
  | { readonly status: "non-numeric" };

/**
 * Read one recorded axis value. Absent fields and `null` are unknown; non-number
 * values (including non-finite numbers, which JSON cannot record) are
 * non-numeric. Zero is returned as a value.
 */
function readAxis(run: Run, fieldKey: NumericFieldKey): AxisReading {
  const field = run.fields.find(({ key }) => key === fieldKey);
  if (!field || field.value === null) return { status: "missing" };
  if (typeof field.value !== "number" || !Number.isFinite(field.value)) {
    return { status: "non-numeric" };
  }
  return { status: "value", fieldKey, field, value: field.value };
}

function omissionReasons(
  xRead: AxisReading | null,
  yRead: AxisReading,
): PlotOmittedReason[] {
  const reasons: PlotOmittedReason[] = [];
  if (xRead?.status === "missing") reasons.push("missing-x");
  if (xRead?.status === "non-numeric") reasons.push("non-numeric-x");
  if (yRead.status === "missing") reasons.push("missing-y");
  if (yRead.status === "non-numeric") reasons.push("non-numeric-y");
  return reasons;
}

function unitMismatch(
  runId: string,
  reading: Extract<AxisReading, { status: "value" }>,
): PlotAxisUnitMismatch | null {
  const { nativeUnit } = getFieldDefinition(reading.fieldKey);
  if (nativeUnit === null || reading.field.unit === nativeUnit) return null;
  return {
    runId,
    fieldKey: reading.fieldKey,
    recordedUnit: reading.field.unit,
    nativeUnit,
  };
}

function stableReference(
  dataset: Dataset,
  runId: string,
  reading: Extract<AxisReading, { status: "value" }>,
): StableFieldReference {
  return {
    datasetVersion: dataset.version,
    runId,
    fieldKey: reading.fieldKey,
    sourceId: reading.field.sourceId,
  };
}

/**
 * Read the optional fuel group as recorded. `plot-result-1` bounds a group to
 * 1–80 characters and requires a non-null group for every point when grouping is
 * `"fuel"`; a missing/blank/oversized fuel label cannot be represented.
 */
function readFuelGroup(run: Run): string | null {
  const field = run.fields.find(({ key }) => key === "fuel");
  if (!field || typeof field.value !== "string") return null;
  const value = field.value;
  if (value.trim().length === 0 || value.length > 80) return null;
  return value;
}

function corpusFailure(
  dataset: Dataset,
  spec: PlotSpec,
  issues: CorpusValidationIssue[],
): PlotEngineError {
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  const unknownRunIds = spec.scope.kind === "explicit-runs"
    ? spec.scope.runIds.filter((runId) => !knownRunIds.has(runId))
    : [];
  if (unknownRunIds.length > 0) {
    return new PlotEngineError(
      "unknown-runs",
      `Unknown run ID(s) in the explicit scope: ${unknownRunIds.join(", ")}. Use run IDs present in dataset "${dataset.version}".`,
      { issues, runIds: unknownRunIds },
    );
  }

  const recordedFieldKeys = new Set(dataset.runs.flatMap((run) => run.fields.map(({ key }) => key)));
  const missingAxisFields = plotAxisFields(spec).filter((fieldKey) => !recordedFieldKeys.has(fieldKey));
  if (missingAxisFields.length > 0) {
    const availableAxisFields = numericFieldKeys.filter((fieldKey) =>
      dataset.runs.some((run) => run.fields.some((field) => field.key === fieldKey && field.unit !== null)));
    return new PlotEngineError(
      "axis-unavailable",
      `Axis field(s) absent from dataset "${dataset.version}": ${missingAxisFields.join(", ")}. Available numeric axis fields: ${availableAxisFields.join(", ") || "none"}.`,
      { issues, fieldKeys: missingAxisFields },
    );
  }

  return new PlotEngineError(
    "invalid-scope",
    `The plot scope does not match dataset "${dataset.version}": ${formatCorpusIssues(issues)}`,
    { issues },
  );
}

/**
 * Build the single canonical `PlotResult` for a plot request.
 *
 * @param dataset A corpus parsed with `parseDataset` (full structural validation
 *   happens at load; this engine only performs a light shape check).
 * @param spec The raw `plot-spec-1` request. It is parsed and validated here.
 * @returns A schema-valid, corpus-validated `PlotResult` in `plot-result-1`.
 * @throws {PlotEngineError} With a stable `code` and structured `details` when
 *   the request is structurally invalid, outside the corpus, or beyond the
 *   frozen result bounds. A valid zero-row scope is returned normally.
 */
export function buildPlotResult(dataset: Dataset, spec: unknown): PlotResult {
  assertDatasetShape(dataset);

  const parsedSpec = plotSpecSchema.safeParse(spec);
  if (!parsedSpec.success) {
    const specIssues = formatSpecIssues(parsedSpec.error.issues);
    throw new PlotEngineError(
      "invalid-spec",
      `Invalid plot spec: ${specIssues.join("; ")}`,
      { specIssues },
    );
  }
  const plotSpec = parsedSpec.data;

  // U03.2: axes are reviewed numeric catalog fields with a native unit. Numeric
  // values are used exactly as recorded; no conversion or interpolation.
  for (const fieldKey of plotAxisFields(plotSpec)) {
    const definition = getFieldDefinition(fieldKey);
    if (definition.dataType !== "numeric" || !definition.axisEligible || definition.nativeUnit === null) {
      throw new PlotEngineError(
        "axis-incompatible",
        `Axis field "${fieldKey}" is not an axis-eligible numeric field with a native unit in field-catalog-1. Use a reviewed numeric measurement such as diameter, burn_time or burning_rate.`,
        { fieldKeys: [fieldKey] },
      );
    }
  }

  // U03.1: corpus membership, filter validity and axis availability. Unknown
  // explicit IDs are never dropped silently.
  const corpusIssues = validatePlotSpecAgainstDataset(dataset, plotSpec);
  if (corpusIssues.length > 0) throw corpusFailure(dataset, plotSpec, corpusIssues);

  const resolution = resolveRunScope(dataset, plotSpec.scope);
  if (!resolution.ok) throw corpusFailure(dataset, plotSpec, resolution.issues);
  const resolved = resolution.resolved;
  const resolvedRunIds = [...resolved.runIds];
  const resolvedScope = scopeSummary(resolved);
  const limitations = plotLimitationsForSpec(plotSpec);

  // U03.4: a valid scope can resolve to zero runs. The normal construction path
  // below returns a schema-valid zero-row result; the frozen row and filter
  // bounds still apply, and a nonempty scope whose measurements are all unknown
  // is accounted for through `omitted` rather than treated as an empty scope.
  if (resolved.runs.length > plotEngineLimits.resolvedRunCount) {
    throw new PlotEngineError(
      "scope-limit",
      `The ${resolved.scopeKind} scope resolved to ${resolved.runs.length} runs, but plot-result-1 is bounded to ${plotEngineLimits.resolvedRunCount} resolved runs. Narrow the scope with filters or explicit run IDs.`,
      {
        scope: resolvedScope,
        resolvedRunIds,
        rowCount: resolved.runs.length,
        rowLimit: plotEngineLimits.resolvedRunCount,
      },
    );
  }
  if (resolved.activeFilters.length > plotEngineLimits.activeFilterCount) {
    throw new PlotEngineError(
      "scope-limit",
      `The filtered scope declares ${resolved.activeFilters.length} active filters, but plot-result-1.scope.activeFilters is bounded to ${plotEngineLimits.activeFilterCount}. Reduce the filter list or split the query.`,
      {
        scope: resolvedScope,
        resolvedRunIds,
        filterCount: resolved.activeFilters.length,
        filterLimit: plotEngineLimits.activeFilterCount,
      },
    );
  }

  const points: PlotPoint[] = [];
  const omitted: PlotOmittedRun[] = [];
  const unitMismatches: PlotAxisUnitMismatch[] = [];
  const ungroupedRunIds: string[] = [];
  const yFieldKey = plotSpec.axes.y.field;
  const xFieldKey = plotSpec.kind === "scatter" ? plotSpec.axes.x.field : null;

  for (const run of resolved.runs) {
    const yRead = readAxis(run, yFieldKey);
    const xRead = xFieldKey === null ? null : readAxis(run, xFieldKey);
    const reasons = omissionReasons(xRead, yRead);

    if (reasons.length > 0) {
      omitted.push({ runId: run.id, reasons });
      continue;
    }

    // Defensive narrowing: every non-value reading contributes a reason above.
    if (yRead.status !== "value" || (xRead !== null && xRead.status !== "value")) {
      throw new PlotEngineError(
        "contract-violation",
        "Omission accounting reached an unaccounted non-value reading.",
        { runIds: [run.id] },
      );
    }

    if (xRead !== null) {
      const mismatch = unitMismatch(run.id, xRead);
      if (mismatch) unitMismatches.push(mismatch);
    }
    const yMismatch = unitMismatch(run.id, yRead);
    if (yMismatch) unitMismatches.push(yMismatch);

    const group = plotSpec.grouping === "fuel" ? readFuelGroup(run) : null;
    if (plotSpec.grouping === "fuel" && group === null) {
      ungroupedRunIds.push(run.id);
      continue;
    }

    points.push({
      runId: run.id,
      x: xRead === null ? null : xRead.value,
      y: yRead.value,
      group,
      sourceReferences: xRead === null
        ? [stableReference(dataset, run.id, yRead)]
        : [stableReference(dataset, run.id, xRead), stableReference(dataset, run.id, yRead)],
    });
  }

  if (unitMismatches.length > 0) {
    const first = unitMismatches[0];
    throw new PlotEngineError(
      "axis-unit-mismatch",
      `Axis field "${first.fieldKey}" is recorded as ${first.recordedUnit === null ? "no unit" : `"${first.recordedUnit}"`} for run ${first.runId}, but the reviewed native unit is "${first.nativeUnit}". plot-result-1 carries no unit field, so the engine does not convert or relabel values; align the dataset or choose another axis.`,
      {
        units: unitMismatches,
        runIds: [...new Set(unitMismatches.map(({ runId }) => runId))],
        fieldKeys: [...new Set(unitMismatches.map(({ fieldKey }) => fieldKey))],
      },
    );
  }

  if (ungroupedRunIds.length > 0) {
    throw new PlotEngineError(
      "grouping-unavailable",
      `Fuel grouping was requested, but included run(s) ${ungroupedRunIds.join(", ")} have no representable recorded fuel value. plot-result-1 requires a non-null group on every point when grouping is "fuel"; choose grouping "none" or a scope whose runs record fuel.`,
      { runIds: ungroupedRunIds },
    );
  }

  // U03.3: one canonical result for chart/table/assistant consumers.
  const axes: PlotResult["axes"] = plotSpec.kind === "scatter"
    ? { kind: "scatter", x: plotSpec.axes.x.field, y: plotSpec.axes.y.field }
    : { kind: "point-comparison", y: plotSpec.axes.y.field };

  const result: PlotResult = {
    version: upgradeContractVersions.plotResult,
    specVersion: upgradeContractVersions.plotSpec,
    kind: plotSpec.kind,
    datasetVersion: dataset.version,
    axes,
    grouping: plotSpec.grouping,
    scope: resolvedScope,
    resolvedRunIds,
    includedCount: points.length,
    omittedCount: omitted.length,
    points,
    omitted,
    limitations,
  };

  const validated = plotResultSchema.safeParse(result);
  if (!validated.success) {
    throw new PlotEngineError(
      "contract-violation",
      `Plot engine produced a result outside plot-result-1: ${formatSpecIssues(validated.error.issues).join("; ")}`,
      { specIssues: formatSpecIssues(validated.error.issues) },
    );
  }
  const resultIssues = validatePlotResultAgainstDataset(dataset, validated.data);
  if (resultIssues.length > 0) {
    throw new PlotEngineError(
      "contract-violation",
      `Plot engine produced source references that do not resolve against dataset "${dataset.version}": ${formatCorpusIssues(resultIssues)}`,
      { issues: resultIssues },
    );
  }

  return validated.data;
}
