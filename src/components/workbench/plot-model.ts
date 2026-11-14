/**
 * U07 plot workspace model — the small pure layer the Visual Evidence Lab uses
 * for presets, scopes, labels and filenames.
 *
 * The accepted `plot.ts` / `plot-engine.ts` / `plot-workspace.ts` modules stay
 * the authority for request validation, omission accounting, selection and the
 * export payload. This module only maps workspace UI choices onto those
 * contracts so presets and labels cannot drift between the chart, table,
 * assistant and export paths.
 */
import { fieldDefinitionByKey, type FieldKey, type NumericFieldKey } from "../../lib/upgrades/field-catalog.ts";
import type { PlotOmittedReason, PlotResult, PlotSpec } from "../../lib/upgrades/plot.ts";
import type { RunScope } from "../../lib/upgrades/scope.ts";

export type PlotPresetId = "diameter-time" | "oxygen-rate" | "selected-runs";

export type PlotPreset = {
  readonly id: PlotPresetId;
  readonly label: string;
  readonly kind: PlotSpec["kind"];
  readonly x: NumericFieldKey | null;
  readonly y: NumericFieldKey;
};

/** The approved review presets. A manual axis change leaves every preset unselected. */
export const plotPresets: readonly PlotPreset[] = [
  { id: "diameter-time", label: "Diameter / time", kind: "scatter", x: "diameter", y: "burn_time" },
  { id: "oxygen-rate", label: "O₂ / burning rate", kind: "scatter", x: "oxygen", y: "burning_rate" },
  { id: "selected-runs", label: "Selected runs", kind: "point-comparison", x: null, y: "burn_time" },
];

export function fieldLabelFor(key: string): string {
  return isCatalogKey(key) ? fieldDefinitionByKey[key].label : key;
}

export function fieldUnitFor(key: string): string | null {
  return isCatalogKey(key) ? fieldDefinitionByKey[key].nativeUnit : null;
}

function isCatalogKey(key: string): key is FieldKey {
  return Object.prototype.hasOwnProperty.call(fieldDefinitionByKey, key);
}

/** Every reviewed numeric field that can define an axis, in catalog order. */
export const plotAxisFields: readonly NumericFieldKey[] = (Object.keys(fieldDefinitionByKey) as FieldKey[])
  .filter((key): key is NumericFieldKey => {
    const definition = fieldDefinitionByKey[key];
    return definition.dataType === "numeric" && definition.axisEligible && definition.nativeUnit !== null;
  });

export function axisTitle(key: NumericFieldKey): string {
  const definition = fieldDefinitionByKey[key];
  return `${definition.label} (${definition.nativeUnit ?? "unitless"})`;
}

export function axisShortTitle(key: NumericFieldKey): string {
  const definition = fieldDefinitionByKey[key];
  return definition.nativeUnit ? `${definition.label} · ${definition.nativeUnit}` : definition.label;
}

export function scatterPlotSpec(x: NumericFieldKey, y: NumericFieldKey, scope: RunScope): PlotSpec {
  return {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: x }, y: { field: y } },
    grouping: "none",
    scope,
  };
}

export function pointComparisonPlotSpec(y: NumericFieldKey, runIds: readonly string[]): PlotSpec {
  return {
    version: "plot-spec-1",
    kind: "point-comparison",
    axes: { y: { field: y } },
    grouping: "none",
    scope: { kind: "explicit-runs", runIds: [...runIds] },
  };
}

export type PlotScopeChoice = "all" | "filtered" | "selected";

export function hasPlotFilters(search: { query?: string; filters?: readonly unknown[] } | undefined): boolean {
  return Boolean(search?.query?.trim() || search?.filters?.length);
}

/**
 * Map a scope choice to a `run-scope-1` value. `selected` returns null when the
 * shared selection is empty: `explicit-runs` requires at least one run.
 */
export function scopeForChoice(
  choice: PlotScopeChoice,
  search: { query?: string; investigation?: string; filters?: { key: string; value: number | string | null }[] } | undefined,
  selectedRunIds: readonly string[],
): RunScope | null {
  if (choice === "all") return { kind: "all-reviewed-runs" };
  if (choice === "filtered") {
    if (!hasPlotFilters(search)) return { kind: "all-reviewed-runs" };
    return { kind: "filtered-results", search: search ?? {} };
  }
  return selectedRunIds.length ? { kind: "explicit-runs", runIds: [...selectedRunIds] } : null;
}

export function plotScopeChoice(spec: PlotSpec): PlotScopeChoice {
  return spec.scope.kind === "filtered-results" ? "filtered"
    : spec.scope.kind === "explicit-runs" ? "selected" : "all";
}

export function plotPresetForSpec(spec: PlotSpec): PlotPresetId | null {
  if (spec.kind === "point-comparison") return "selected-runs";
  if (spec.axes.x.field === "diameter" && spec.axes.y.field === "burn_time") return "diameter-time";
  if (spec.axes.x.field === "oxygen" && spec.axes.y.field === "burning_rate") return "oxygen-rate";
  return null;
}

export function plotSpecForPreset(
  id: PlotPresetId,
  options: {
    selectedRunIds: readonly string[];
    search?: { query?: string; investigation?: string; filters?: { key: string; value: number | string | null }[] };
    y?: NumericFieldKey;
  },
): PlotSpec | null {
  if (id === "diameter-time") {
    const scope = scopeForChoice("all", options.search, options.selectedRunIds);
    return scope ? scatterPlotSpec("diameter", "burn_time", scope) : null;
  }
  if (id === "oxygen-rate") {
    const scope = scopeForChoice("all", options.search, options.selectedRunIds);
    return scope ? scatterPlotSpec("oxygen", "burning_rate", scope) : null;
  }
  if (!options.selectedRunIds.length) return null;
  return pointComparisonPlotSpec(options.y ?? "burn_time", options.selectedRunIds);
}

export function plotXField(spec: PlotSpec): NumericFieldKey | null {
  return spec.kind === "scatter" ? spec.axes.x.field : null;
}

export function plotYField(spec: PlotSpec): NumericFieldKey {
  return spec.axes.y.field;
}

export function omissionReasonText(reasons: readonly PlotOmittedReason[], spec: PlotSpec): string {
  const parts: string[] = [];
  for (const reason of reasons) {
    const xField = plotXField(spec);
    if (reason === "missing-x" && xField) parts.push(`${fieldLabelFor(xField)} unknown`);
    if (reason === "missing-y") parts.push(`${fieldLabelFor(plotYField(spec))} unknown`);
    if (reason === "non-numeric-x" && xField) parts.push(`${fieldLabelFor(xField)} not numeric`);
    if (reason === "non-numeric-y") parts.push(`${fieldLabelFor(plotYField(spec))} not numeric`);
  }
  return parts.length ? `${parts.join(" and ")}.` : "Required axis value unavailable.";
}

export type PlotCoverageSummary = {
  resolved: number;
  included: number;
  omitted: number;
  emptyScope: boolean;
  allOmitted: boolean;
};

export function plotCoverage(result: PlotResult): PlotCoverageSummary {
  return {
    resolved: result.resolvedRunIds.length,
    included: result.includedCount,
    omitted: result.omittedCount,
    emptyScope: result.resolvedRunIds.length === 0,
    allOmitted: result.resolvedRunIds.length > 0 && result.includedCount === 0,
  };
}

export function plotExportFilename(spec: PlotSpec, datasetVersion: string): string {
  const axes = spec.kind === "scatter"
    ? `${spec.axes.x.field}-${spec.axes.y.field}`
    : `${spec.axes.y.field}-by-run`;
  const safeVersion = datasetVersion.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `fire-evidence-plot-${axes}-${safeVersion}.json`;
}

/** Human label for the canonical scope recorded in a plot result. */
export function scopeSummaryText(spec: PlotSpec, resolvedCount: number): string {
  if (spec.scope.kind === "explicit-runs") {
    return `Selected runs · ${spec.scope.runIds.length} of ${resolvedCount} resolved`;
  }
  if (spec.scope.kind === "filtered-results") {
    return `Filtered results · ${resolvedCount} reviewed run${resolvedCount === 1 ? "" : "s"}`;
  }
  return `All reviewed runs · ${resolvedCount}`;
}
