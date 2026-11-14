/**
 * U05-B notebook presentation helpers: portable JSON export, a readable
 * printable HTML report and pure personal-note mutations.
 *
 * This module is browser-safe and side-effect free:
 * - no storage, network, provider, filesystem or DOM access;
 * - no ambient `window`, `document`, `localStorage` or clock reads at module
 *   evaluation (the note helpers default to the current time only when called);
 * - the printable report is a standalone static document with inline CSS and no
 *   scripts, images or links;
 * - JSON export produces a `notebook-1` document that the existing U05 import
 *   engine accepts, or a structured `too-large` failure.
 *
 * Personal notes are validated user content. They are not evidence, are never
 * merged into step snapshots, and note helpers never persist anything.
 */
import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import { getFieldDefinition, type FieldKey } from "./field-catalog.ts";
import {
  answerSnapshotProvenanceClass,
  answerSnapshotSourceReferences,
  notebookDatasetVersionReport,
  notebookLimits,
  notebookNoteLabel,
  notebookNoteSchema,
  notebookSchema,
  type ComparisonNotebookStep,
  type EvidenceAnswerNotebookStep,
  type Notebook,
  type NotebookDatasetVersionStatus,
  type NotebookNote,
  type NotebookStep,
  type NotebookVersionContext,
  type PlotNotebookStep,
} from "./notebook.ts";
import { collectComparisonSourceReferences, measureNotebookBytes } from "./notebook-engine.ts";
import { contextEvidenceCategoryLabels } from "./comparison-context.ts";
import { collectPlotSourceReferences, plotAxisUnits } from "./plot.ts";
import {
  resolveStableFieldReference,
  stableFieldReferenceKey,
  type StableFieldReference,
} from "./provenance.ts";

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

/** Escape text for use in HTML text nodes and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function zodIssueStrings(error: z.ZodError): string[] {
  return error.issues.slice(0, 50).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function currentTimestamp(): string {
  return new Date().toISOString();
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as T;
}

/** Note edits must keep pinned step snapshots in their frozen, immutable form. */
function freezeStepSnapshots(notebook: Notebook): Notebook {
  for (const step of notebook.steps) deepFreeze(step);
  return notebook;
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

function safeFilename(value: string, fallback: string): string {
  const cleaned = value.trim().replaceAll(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned || fallback;
}

/* ------------------------------------------------------------------------- */
/* U05.5a — portable JSON export                                             */
/* ------------------------------------------------------------------------- */

export type NotebookJsonExportOptions = {
  /** Override the default `fire-evidence-notebook-<id>.json` name. */
  filename?: string;
};

export type NotebookJsonExportResult =
  | {
    ok: true;
    /** Pretty-printed, portable `notebook-1` JSON accepted by the U05 importer. */
    text: string;
    byteLength: number;
    filename: string;
    mediaType: "application/json";
    notebook: Notebook;
  }
  | {
    ok: false;
    reason: "invalid-notebook" | "too-large";
    message: string;
    issues?: string[];
    byteLength?: number;
  };

export function notebookJsonFilename(notebook: Pick<Notebook, "id">): string {
  return `fire-evidence-notebook-${notebook.id}.json`;
}

/**
 * Serialize a validated notebook as portable JSON. The output is plain
 * `notebook-1` JSON (the existing importer accepts it) and keeps stored step
 * order, exact values, source references, corpus versions, limitations, notes
 * and receipt verification markers unchanged.
 *
 * The real UTF-8 byte length is measured before returning. A document beyond
 * the 2 MiB import bound is a clear structured failure instead of producing a
 * file the application could not re-import.
 */
export function exportNotebookJson(
  notebook: Notebook,
  options: NotebookJsonExportOptions = {},
): NotebookJsonExportResult {
  const parsed = notebookSchema.safeParse(notebook);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook is not valid, so it was not exported.",
      issues: zodIssueStrings(parsed.error),
    };
  }
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const byteLength = measureNotebookBytes(text);
  if (byteLength > notebookLimits.importMaxBytes) {
    return {
      ok: false,
      reason: "too-large",
      byteLength,
      message: "The portable notebook is " + byteLength + " bytes, which exceeds the "
        + notebookLimits.importMaxBytes + "-byte (2 MiB) import limit and could not be re-imported. "
        + "Remove large answer receipts or notes, or split the notebook into smaller notebooks.",
    };
  }
  return {
    ok: true,
    text,
    byteLength,
    filename: safeFilename(options.filename ?? "", notebookJsonFilename(parsed.data)),
    mediaType: "application/json",
    notebook: parsed.data,
  };
}

/* ------------------------------------------------------------------------- */
/* U05.5b — printable HTML report                                            */
/* ------------------------------------------------------------------------- */

export type NotebookPrintOptions = {
  /**
   * Exact corpora known to the caller. A locator is resolved only when a
   * supplied dataset's version exactly equals the stored reference version.
   */
  datasets?: readonly Dataset[];
  /** When supplied, each corpus version gets the contract status label. */
  versionContext?: NotebookVersionContext;
  /** Optional display time; omitted keeps the document deterministic. */
  generatedAt?: string;
};

const printStyles = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { background: #ffffff; }
  body {
    margin: 0 auto;
    max-width: 980px;
    padding: 30px 28px 60px;
    font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    color: #16181d;
    background: #ffffff;
  }
  h1 { margin: 2px 0 8px; font-size: 27px; line-height: 1.2; font-weight: 600; }
  h2 { margin: 30px 0 10px; font-size: 19px; line-height: 1.25; border-bottom: 1px solid #d5d8de; padding-bottom: 5px; }
  h3 { margin: 0 0 6px; font-size: 16px; line-height: 1.3; }
  h4 { margin: 16px 0 6px; font-size: 13px; line-height: 1.3; text-transform: uppercase; letter-spacing: 0.04em; color: #3f4652; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 0.92em; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 13px; }
  caption { text-align: left; font-weight: 600; padding: 4px 0; }
  th, td { border: 1px solid #d5d8de; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; font-weight: 600; }
  .kicker { margin: 0; font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: #596170; }
  .question { font-size: 15px; }
  .meta { color: #4b5360; font-size: 12.5px; }
  .muted { color: #5a6270; }
  .warning { color: #8a4b00; font-weight: 600; }
  .screen-hint { border: 1px solid #d5d8de; background: #f7f8fa; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; }
  .notebook { border-bottom: 2px solid #16181d; padding-bottom: 14px; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 22px; margin: 12px 0 0; }
  .meta-grid div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px; }
  .meta-grid dt { color: #596170; font-size: 12px; }
  .meta-grid dd { margin: 0; overflow-wrap: anywhere; }
  .step { border: 1px solid #c9ced6; border-radius: 8px; padding: 14px 16px 10px; margin: 14px 0; background: #ffffff; }
  .step-header { border-bottom: 1px solid #e1e4e9; padding-bottom: 8px; margin-bottom: 8px; }
  .step-kicker { margin: 0 0 3px; font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: #596170; }
  .badge { display: inline-block; border: 1px solid #9aa3b0; border-radius: 999px; padding: 0 7px; font-size: 11px; color: #3d4551; }
  .source-list li { margin: 5px 0; }
  .note { border: 1px solid #d8c99a; background: #fffaf0; border-radius: 8px; padding: 11px 14px; margin: 10px 0; }
  .note-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .note-warning { border-left: 4px solid #b47a00; background: #fff8e8; padding: 8px 11px; }
  .empty { color: #5a6270; font-style: italic; }
  .footer { margin-top: 34px; border-top: 1px solid #d5d8de; padding-top: 12px; font-size: 12px; color: #4b5360; }
  @media print {
    body { max-width: none; padding: 0; font-size: 10.5pt; }
    .screen-hint { display: none; }
    .step, .note { break-inside: auto; }
    .step-header { break-after: avoid; }
    h1, h2, h3, h4 { break-after: avoid; }
    tr { break-inside: avoid; }
    @page { margin: 14mm; }
  }
`.trim();

function stepTypeLabel(step: NotebookStep): string {
  if (step.stepType === "plot") return "Plot snapshot";
  if (step.stepType === "comparison") return "Comparison snapshot";
  return "Validated answer snapshot";
}

function versionStatusLabel(status: NotebookDatasetVersionStatus): string {
  if (status === "same-version") return "current corpus version";
  if (status === "historical-version") return "historical version";
  return "unavailable version (stored snapshot only)";
}

function omissionReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    "missing-x": "x value unknown or missing",
    "missing-y": "y value unknown or missing",
    "non-numeric-x": "x value is not numeric",
    "non-numeric-y": "y value is not numeric",
  };
  return labels[reason] ?? reason;
}

function formatUnit(unit: string | null): string {
  return unit === null ? "—" : escapeHtml(unit);
}

function formatValue(value: number | string | null, unit: string | null): string {
  if (value === null) return "Unknown";
  if (typeof value === "number") return escapeHtml(unit ? `${value} ${unit}` : String(value));
  return escapeHtml(value);
}

function formatCell(value: number | string | null, original: string | null, unit: string | null): string {
  const rendered = formatValue(value, unit);
  if (original === null) return rendered;
  const plain = value === null ? "" : String(value);
  if (original.trim() === plain.trim()) return rendered;
  return `${rendered} <span class="muted">(recorded text: ${escapeHtml(original)})</span>`;
}

function formatOriginal(original: string | null): string {
  return original === null ? "Unknown" : escapeHtml(original);
}

function fieldLabel(key: FieldKey): string {
  return getFieldDefinition(key).label;
}

function formatFilter(filter: { key: string; value: number | string | null }): string {
  const value = filter.value === null ? "Unknown" : String(filter.value);
  return `${escapeHtml(filter.key)}=${escapeHtml(value)}`;
}

function scopeLabel(scope: PlotNotebookStep["plotResult"]["scope"]): string {
  if (scope.kind === "all-reviewed-runs") return "All reviewed runs";
  if (scope.kind === "explicit-runs") return "Explicit run selection";
  const parts = ["Filtered results"];
  if (scope.search?.query) parts.push(`query "${escapeHtml(scope.search.query)}"`);
  if (scope.search?.investigation) parts.push(`investigation "${escapeHtml(scope.search.investigation)}"`);
  if (scope.activeFilters.length) parts.push(`active filters: ${scope.activeFilters.map(formatFilter).join(", ")}`);
  return parts.join(" · ");
}

function contextStatusLabel(status: string): string {
  return escapeHtml(status);
}

function limitationSection(title: string, lists: readonly (readonly string[])[]): string {
  const limits = uniqueStrings(lists);
  if (!limits.length) return "";
  return `<section class="limitations"><h4>${escapeHtml(title)}</h4><ul>${limits
    .map((text) => `<li>${escapeHtml(text)}</li>`)
    .join("")}</ul></section>`;
}

type ExactCorpora = ReadonlyMap<string, Dataset>;

function exactCorpora(datasets: readonly Dataset[] | undefined): ExactCorpora {
  const byVersion = new Map<string, Dataset>();
  for (const dataset of datasets ?? []) byVersion.set(dataset.version, dataset);
  return byVersion;
}

function renderCorpusSection(notebook: Notebook, corpora: ExactCorpora, versionContext?: NotebookVersionContext): string {
  const report = versionContext
    ? notebookDatasetVersionReport(notebook, {
      activeDatasetVersion: versionContext.activeDatasetVersion,
      availableDatasetVersions: [...new Set([
        ...(versionContext.availableDatasetVersions ?? []),
        ...corpora.keys(),
      ])],
    })
    : null;
  const statusByVersion = new Map(report?.map((entry) => [entry.datasetVersion, entry.status]) ?? []);
  const missing = notebook.datasetVersions.filter((version) => !corpora.has(version));
  const mismatched = report?.filter(({ status, stepIds }) => status !== "same-version" && stepIds.length > 0) ?? [];
  const mismatchedStepCount = mismatched.reduce((count, entry) => count + entry.stepIds.length, 0);
  const mismatchNotice = mismatchedStepCount
    ? `<p class="warning">${mismatchedStepCount} saved step${mismatchedStepCount === 1 ? "" : "s"} use a dataset version that is not current. Original snapshots are retained; re-run to append a separate current-version step.</p>`
    : "";
  const items = notebook.datasetVersions.map((version) => {
    const supplied = corpora.has(version);
    const status = statusByVersion.get(version);
    return `<li><code>${escapeHtml(version)}</code> — ${supplied
      ? "exact corpus supplied for this report"
      : "exact corpus not supplied"}${status ? ` · ${escapeHtml(versionStatusLabel(status))}` : ""}</li>`;
  }).join("");
  const disclosure = missing.length
    ? `<p class="warning">Exact corpus data was not supplied for ${missing.map((version) => `<code>${escapeHtml(version)}</code>`).join(", ")}. Stored provenance is shown for those steps; locators were not re-resolved.</p>`
    : `<p class="muted">Locators below were re-resolved only against the supplied exact corpora.</p>`;
  return `<section class="corpora"><h2>Corpus versions</h2>${mismatchNotice}<ul>${items}</ul>${disclosure}</section>`;
}

function renderAxes(step: PlotNotebookStep): string {
  const units = plotAxisUnits(step.plotSpec);
  const rows = step.plotSpec.kind === "scatter"
    ? [
      `<tr><th scope="row">x</th><td>${escapeHtml(fieldLabel(step.plotSpec.axes.x.field))} <span class="muted">(${escapeHtml(step.plotSpec.axes.x.field)})</span></td><td>${formatUnit(units.x)}</td></tr>`,
      `<tr><th scope="row">y</th><td>${escapeHtml(fieldLabel(step.plotSpec.axes.y.field))} <span class="muted">(${escapeHtml(step.plotSpec.axes.y.field)})</span></td><td>${formatUnit(units.y)}</td></tr>`,
    ]
    : [
      `<tr><th scope="row">y</th><td>${escapeHtml(fieldLabel(step.plotSpec.axes.y.field))} <span class="muted">(${escapeHtml(step.plotSpec.axes.y.field)})</span></td><td>${formatUnit(units.y)}</td></tr>`,
    ];
  return `<h4>Axes and native units</h4><table><thead><tr><th scope="col">Axis</th><th scope="col">Reviewed field</th><th scope="col">Native unit</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderPlotFacts(step: PlotNotebookStep): string {
  const { plotResult, plotSpec } = step;
  const units = plotAxisUnits(plotSpec);
  const groupHeader = plotResult.grouping === "fuel" ? "<th scope=\"col\">Fuel group</th>" : "";
  const points = plotResult.points.map((point) => {
    const group = plotResult.grouping === "fuel" ? `<td>${escapeHtml(point.group ?? "")}</td>` : "";
    return `<tr><td><code>${escapeHtml(point.runId)}</code></td><td>${point.x === null ? "— (run identity axis)" : formatValue(point.x, units.x)}</td><td>${formatValue(point.y, units.y)}</td>${group}</tr>`;
  }).join("");
  const omitted = plotResult.omitted.length
    ? `<h4>Omitted runs</h4><table><thead><tr><th scope="col">Run</th><th scope="col">Reasons</th></tr></thead><tbody>${plotResult.omitted
      .map((record) => `<tr><td><code>${escapeHtml(record.runId)}</code></td><td>${record.reasons.map((reason) => escapeHtml(omissionReasonLabel(reason))).join("; ")}</td></tr>`)
      .join("")}</tbody></table>`
    : `<p class="muted">No runs were omitted from this plot scope.</p>`;
  return `<p class="meta">Plot kind: ${escapeHtml(plotResult.kind)} · Grouping: ${escapeHtml(plotResult.grouping)} · Scope: ${scopeLabel(plotResult.scope)} · Included: ${plotResult.includedCount} · Omitted: ${plotResult.omittedCount}</p>
    ${renderAxes(step)}
    <h4>Plotted runs</h4>
    <table><thead><tr><th scope="col">Run</th><th scope="col">x</th><th scope="col">y</th>${groupHeader}</tr></thead><tbody>${points || `<tr><td colspan="${plotResult.grouping === "fuel" ? 4 : 3}">No plotted points in this scope.</td></tr>`}</tbody></table>
    ${omitted}`;
}

function renderComparativeFields(
  fields: ComparisonNotebookStep["context"]["conditions"],
  runIds: readonly string[],
  heading: string,
): string {
  if (!fields.length) return "";
  const runHeaders = runIds.map((runId) => `<th scope="col"><code>${escapeHtml(runId)}</code></th>`).join("");
  const rows = fields.map((field) => {
    const cells = runIds.map((runId) => {
      const cell = field.cells.find(({ runId: cellRunId }) => cellRunId === runId);
      return `<td>${cell ? formatCell(cell.value, cell.original, field.unit) : "—"}</td>`;
    }).join("");
    return `<tr><th scope="row">${escapeHtml(field.label)} <span class="muted">(${escapeHtml(field.key)})</span></th><td>${formatUnit(field.unit)}</td><td>${contextStatusLabel(field.status)}</td>${cells}<td>${escapeHtml(field.reason)}</td></tr>`;
  }).join("");
  return `<h4>${escapeHtml(heading)}</h4><table><thead><tr><th scope="col">Field</th><th scope="col">Native unit</th><th scope="col">Status</th>${runHeaders}<th scope="col">Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDeltas(fields: readonly ComparisonNotebookStep["context"]["conditions"][number][]): string {
  const items: string[] = [];
  for (const field of fields) {
    for (const delta of field.deltas) {
      items.push(`<li>${escapeHtml(field.label)}: <code>${escapeHtml(delta.fromRunId)}</code> → <code>${escapeHtml(delta.toRunId)}</code> = ${formatValue(delta.delta, delta.unit)} <span class="muted">(${escapeHtml(delta.ruleVersion)}, ${escapeHtml(delta.provenanceClass)})</span></li>`);
    }
  }
  return items.length ? `<h4>Native-unit deltas (later selection minus earlier selection)</h4><ul>${items.join("")}</ul>` : "";
}

function renderGasComposition(step: ComparisonNotebookStep): string {
  const { gasComposition } = step.context;
  const gasFields = [
    ["oxygen", "Oxygen"],
    ["nitrogen", "Nitrogen"],
    ["carbon_dioxide", "Carbon dioxide"],
    ["helium", "Helium"],
  ] as const;
  const headers = gasFields.map(([, label]) => `<th scope="col">${label}<br><span class="muted">mole fraction</span></th>`).join("");
  const rows = gasComposition.values.map(({ runId, values }) => `<tr><td><code>${escapeHtml(runId)}</code></td>${gasFields
    .map(([key]) => `<td>${formatValue(values[key], "mole fraction")}</td>`)
    .join("")}</tr>`).join("");
  return `<h4>Gas composition (linked group)</h4>
    <p class="meta">Complete composition: ${gasComposition.complete ? "all four gas fractions are recorded" : "at least one gas fraction is unknown"}.</p>
    <table><thead><tr><th scope="col">Run</th>${headers}</tr></thead><tbody>${rows}</tbody></table>
    <p class="warning">${escapeHtml(gasComposition.limitation)}</p>`;
}

function renderComparisonFacts(step: ComparisonNotebookStep): string {
  const { context } = step;
  const focus = context.request.focusCondition === undefined
    ? "none recorded"
    : `${escapeHtml(fieldLabel(context.request.focusCondition))} (${escapeHtml(context.request.focusCondition)})`;
  const evidence = context.evidence.map((item) => {
    const category = contextEvidenceCategoryLabels[item.category];
    const fields = item.fieldKeys.map((key) => `${escapeHtml(fieldLabel(key))} (${escapeHtml(key)})`).join(", ");
    const rule = item.ruleVersion ? ` · rule <code>${escapeHtml(item.ruleVersion)}</code>` : "";
    return `<li><span class="badge">${escapeHtml(category)}</span> ${escapeHtml(item.text)}<br><span class="muted">Fields: ${fields || "none recorded"}${rule}</span></li>`;
  }).join("");
  return `<p class="meta">Ordered runs: ${context.runIds.map((runId) => `<code>${escapeHtml(runId)}</code>`).join(" → ")} · Focus condition: ${focus} · Comparison rule: <code>${escapeHtml(context.comparisonRuleVersion)}</code> · Context rule: <code>${escapeHtml(context.contextRuleVersion)}</code></p>
    ${renderComparativeFields(context.conditions, context.runIds, "Condition differences")}
    ${renderComparativeFields(context.outcomes, context.runIds, "Outcome differences")}
    ${renderDeltas([...context.conditions, ...context.outcomes])}
    ${renderGasComposition(step)}
    <h4>Evidence notes</h4><ul>${evidence}</ul>`;
}

function renderModel(step: EvidenceAnswerNotebookStep): string {
  const { model } = step.answer.explanation;
  if (model === null) return `<p class="muted">No provider model was recorded for this answer.</p>`;
  const usage = model.usage === null
    ? "usage not recorded"
    : `${model.usage.inputTokens === null ? "unknown" : model.usage.inputTokens} input / ${model.usage.outputTokens === null ? "unknown" : model.usage.outputTokens} output / ${model.usage.totalTokens === null ? "unknown" : model.usage.totalTokens} total tokens`;
  return `<table><tbody>
    <tr><th scope="row">Requested model</th><td><code>${escapeHtml(model.requested)}</code></td></tr>
    <tr><th scope="row">Returned model</th><td>${model.returned === null ? "Unknown" : `<code>${escapeHtml(model.returned)}</code>`}</td></tr>
    <tr><th scope="row">Prompt / config</th><td><code>${escapeHtml(model.promptVersion)}</code> / <code>${escapeHtml(model.configVersion)}</code></td></tr>
    <tr><th scope="row">Usage</th><td>${escapeHtml(usage)}</td></tr>
  </tbody></table>`;
}

function renderCitations(step: EvidenceAnswerNotebookStep, corpora: ExactCorpora): string {
  const { answer } = step;
  const rows = Object.entries(answer.citations).map(([citationId, citation]) => {
    const sourceItems = citation.sources.map((source) => {
      const reference = {
        datasetVersion: answer.datasetVersion,
        runId: source.runId,
        fieldKey: citation.fieldKey,
        sourceId: source.sourceId,
      };
      const dataset = corpora.get(reference.datasetVersion);
      let resolutionText: string;
      if (!dataset) {
        resolutionText = `<span class="warning">Exact corpus ${escapeHtml(answer.datasetVersion)} not supplied; stored locator retained and not re-resolved.</span>`;
      } else {
        const resolution = resolveStableFieldReference(dataset, reference);
        resolutionText = resolution.status === "resolved"
          ? `Exact-corpus original: ${formatOriginal(resolution.field.original)} · resolved locator: <code>${escapeHtml(resolution.field.locator)}</code> · source ${escapeHtml(resolution.source.title)} (<code>${escapeHtml(resolution.source.id)}</code>)`
          : `<span class="warning">Exact corpus could not resolve this citation (${escapeHtml(resolution.status)}); stored provenance and locator retained.</span>`;
      }
      return `<li><code>${escapeHtml(source.runId)}</code> · source <code>${escapeHtml(source.sourceId)}</code> · stored locator: <code>${escapeHtml(source.locator)}</code><br><span class="muted">${resolutionText}</span></li>`;
    }).join("");
    return `<tr><td><code>${escapeHtml(citationId)}</code></td><td>${escapeHtml(fieldLabel(citation.fieldKey))} <span class="muted">(${escapeHtml(citation.fieldKey)})</span></td><td><ul class="source-list">${sourceItems}</ul></td></tr>`;
  }).join("");
  return `<h4>Answer citations</h4><table><thead><tr><th scope="col">Display ID</th><th scope="col">Field</th><th scope="col">Sources and locators</th></tr></thead><tbody>${rows || `<tr><td colspan="3">No citations were stored.</td></tr>`}</tbody></table>`;
}

function renderAnswerFacts(step: EvidenceAnswerNotebookStep, corpora: ExactCorpora): string {
  const { answer } = step;
  const provenanceClass = answerSnapshotProvenanceClass(answer);
  const provenanceLabel = provenanceClass === "deterministic-derived"
    ? "Deterministic evidence-only answer"
    : "Generated explanation (unverified prose)";
  const question = `<h4>Question</h4><p>${escapeHtml(answer.question)}</p>`;
  const exactQuestion = answer.requestQuestion === answer.question
    ? ""
    : `<p class="muted">Exact submitted text: ${escapeHtml(answer.requestQuestion)}</p>`;
  const packetEvidence = answer.packet.evidence.map((item) => {
    const numbers = item.numbers?.length
      ? ` — ${item.numbers.map((number) => `${escapeHtml(number.label)}: ${formatValue(number.value, number.unit || null)}`).join("; ")}`
      : "";
    return `<li><span class="badge">${escapeHtml(item.status)}</span> <code>${escapeHtml(item.id)}</code> ${escapeHtml(item.text)}${numbers}</li>`;
  }).join("");
  const packetLimitations = answer.packet.limitations?.length
    ? `<h4>Packet limitations</h4><ul>${answer.packet.limitations.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`
    : "";
  const claims = answer.explanation.claims.map((claim, index) => {
    const targets = claim.citationTargets?.length
      ? ` · targets: ${claim.citationTargets.map((target) => `${escapeHtml(target.citationId)} → <code>${escapeHtml(target.runId)}</code>`).join(", ")}`
      : "";
    const measurements = claim.measurements.length
      ? `<ul>${claim.measurements.map((measurement) => `<li>${escapeHtml(measurement.label)}: ${formatValue(measurement.value, measurement.unit || null)} <span class="muted">(${escapeHtml(measurement.citationId)})</span></li>`).join("")}</ul>`
      : "";
    return `<li><p>${escapeHtml(claim.text)}</p><p class="meta">Status: ${escapeHtml(claim.status)} · Scope: ${escapeHtml(claim.scope)} · Citations: ${claim.citationIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}${targets}</p>${measurements}</li>`;
  }).join("");
  const explanationProvenance = answer.explanation.provenance
    ? `<p class="meta">Deterministic provenance rule: <code>${escapeHtml(answer.explanation.provenance.ruleVersion)}</code></p>`
    : "";
  const withheld = answer.explanation.withheldClaims === undefined
    ? ""
    : `<p class="meta">Withheld claim count: ${answer.explanation.withheldClaims}</p>`;
  return `<p class="meta">Answer scope: ${escapeHtml(answer.explanation.scope)} · Packet scope: ${escapeHtml(answer.packet.scope)} · Status: ${escapeHtml(answer.explanation.status)} · Provenance: <span class="badge">${escapeHtml(provenanceLabel)}</span> · Packet version: ${answer.packetVersion} · Receipt: ${answer.explanationReceipt === null ? "not stored" : "stored"} · Receipt verification: <span class="badge">${escapeHtml(answer.receiptVerification)}</span></p>
    <p class="meta">Dataset SHA-256: ${answer.datasetSha256 === null ? "not recorded" : `<code>${escapeHtml(answer.datasetSha256)}</code>`} · Comparison rule: <code>${escapeHtml(answer.comparisonRuleVersion)}</code></p>
    ${question}
    ${exactQuestion}
    <h4>Packet evidence</h4><ul>${packetEvidence || "<li>No packet evidence was stored.</li>"}</ul>
    ${packetLimitations}
    <h4>Explanation claims</h4><ol>${claims}</ol>
    ${explanationProvenance}
    ${withheld}
    <h4>Model and provenance</h4>${renderModel(step)}
    ${renderCitations(step, corpora)}`;
}

function renderSourceReferences(references: readonly StableFieldReference[], corpora: ExactCorpora): string {
  if (!references.length) return `<section class="sources"><h4>Stable source references</h4><p class="muted">No stable source references were stored for this step.</p></section>`;
  const items = references.map((reference) => {
    const label = fieldLabel(reference.fieldKey);
    const unit = getFieldDefinition(reference.fieldKey).nativeUnit;
    const dataset = corpora.get(reference.datasetVersion);
    const stored = `<code>${escapeHtml(reference.datasetVersion)}</code> · run <code>${escapeHtml(reference.runId)}</code> · ${escapeHtml(label)} <span class="muted">(${escapeHtml(reference.fieldKey)}${unit === null ? "" : ` · ${escapeHtml(unit)}`})</span> · source <code>${escapeHtml(reference.sourceId)}</code>`;
    if (!dataset) {
      return `<li>${stored}<br><span class="warning">Exact corpus ${escapeHtml(reference.datasetVersion)} not supplied; stored provenance retained and locator not re-resolved.</span></li>`;
    }
    const resolution = resolveStableFieldReference(dataset, reference);
    if (resolution.status !== "resolved") {
      return `<li>${stored}<br><span class="warning">Exact corpus ${escapeHtml(reference.datasetVersion)} could not resolve this reference (${escapeHtml(resolution.status)}); stored provenance retained.</span></li>`;
    }
    return `<li>${stored}<br><span class="muted">Original: ${formatOriginal(resolution.field.original)} · locator: <code>${escapeHtml(resolution.field.locator)}</code> · source ${escapeHtml(resolution.source.title)} (<code>${escapeHtml(resolution.source.id)}</code>)</span></li>`;
  }).join("");
  return `<section class="sources"><h4>Stable source references</h4><ul class="source-list">${items}</ul></section>`;
}

function payloadLimitations(step: NotebookStep): string[] {
  if (step.stepType === "plot") return [...step.plotResult.limitations];
  if (step.stepType === "comparison") return [...step.context.limitations];
  // Answer packet limitations are rendered with the packet facts. The common
  // limitations section covers the step-level limitations only.
  return [];
}

function collectStepSourceReferences(step: NotebookStep): StableFieldReference[] {
  const embedded = step.stepType === "plot"
    ? collectPlotSourceReferences(step.plotResult)
    : step.stepType === "comparison"
      ? collectComparisonSourceReferences(step.context)
      : answerSnapshotSourceReferences(step.answer);
  const references = new Map<string, StableFieldReference>();
  for (const reference of [...step.sourceReferences, ...embedded]) {
    references.set(stableFieldReferenceKey(reference), reference);
  }
  return [...references.values()];
}

function renderStep(step: NotebookStep, number: number, corpora: ExactCorpora): string {
  const facts = step.stepType === "plot"
    ? renderPlotFacts(step)
    : step.stepType === "comparison"
      ? renderComparisonFacts(step)
      : renderAnswerFacts(step, corpora);
  return `<article class="step">
    <header class="step-header">
      <p class="step-kicker">Step ${number} · ${escapeHtml(stepTypeLabel(step))}</p>
      <h3>${escapeHtml(step.title)}</h3>
      <p class="meta">Saved <time datetime="${escapeHtml(step.createdAt)}">${escapeHtml(step.createdAt)}</time> · Corpus <code>${escapeHtml(step.datasetVersion)}</code> · Runs (ordered): ${step.resolvedRunIds.map((runId) => `<code>${escapeHtml(runId)}</code>`).join(", ")}</p>
    </header>
    ${facts}
    ${renderSourceReferences(collectStepSourceReferences(step), corpora)}
    ${limitationSection("Limitations", [step.limitations, payloadLimitations(step)])}
  </article>`;
}

function renderNotes(notes: readonly NotebookNote[]): string {
  const items = notes.length
    ? notes.map((note) => `<article class="note">
        <p class="note-text">${escapeHtml(note.text)}</p>
        <p class="meta">${escapeHtml(notebookNoteLabel)} · Evidence status: not evidence · Verified evidence: ${note.verifiedEvidence ? "yes" : "no"} · Created <time datetime="${escapeHtml(note.createdAt)}">${escapeHtml(note.createdAt)}</time> · Updated <time datetime="${escapeHtml(note.updatedAt)}">${escapeHtml(note.updatedAt)}</time></p>
      </article>`).join("")
    : `<p class="empty">No personal notes are stored in this notebook.</p>`;
  return `<section class="notes" id="personal-notes">
    <h2>Personal notes</h2>
    <p class="note-warning">Personal notes are user-authored or imported text. They are not evidence, are not verified, and are kept separate from the immutable evidence steps above.</p>
    ${items}
  </section>`;
}

/**
 * Render a standalone printable report. Callers open it in a print view or
 * print it with the browser's standard print controls; no script, remote
 * image, external stylesheet or hyperlink is emitted.
 *
 * Every user/imported string is escaped. Locators are resolved only against a
 * supplied dataset whose `version` exactly equals the stored reference version;
 * otherwise stored provenance is retained and the missing corpus is disclosed.
 */
export function renderPrintableNotebookHtml(
  notebook: Notebook,
  options: NotebookPrintOptions = {},
): string {
  const parsed = notebookSchema.parse(notebook);
  const corpora = exactCorpora(options.datasets);
  const ordered = parsed.steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => Date.parse(left.step.createdAt) - Date.parse(right.step.createdAt) || left.index - right.index)
    .map(({ step }) => step);
  const generated = options.generatedAt === undefined
    ? "Generation time not recorded."
    : `Generated <time datetime="${escapeHtml(options.generatedAt)}">${escapeHtml(options.generatedAt)}</time>.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(parsed.title)} — Fire Evidence Explorer notebook</title>
<style>${printStyles}</style>
</head>
<body>
<p class="screen-hint">This report is static and can be printed with the browser's standard Print command (Ctrl/Cmd+P).</p>
<header class="notebook">
  <p class="kicker">Fire Evidence Explorer · Investigation notebook</p>
  <h1>${escapeHtml(parsed.title)}</h1>
  ${parsed.question ? `<p class="question">${escapeHtml(parsed.question)}</p>` : `<p class="question muted">No notebook question was recorded.</p>`}
  <dl class="meta-grid">
    <div><dt>Notebook</dt><dd><code>${escapeHtml(parsed.id)}</code></dd></div>
    <div><dt>Updated</dt><dd><time datetime="${escapeHtml(parsed.updatedAt)}">${escapeHtml(parsed.updatedAt)}</time></dd></div>
    <div><dt>Created</dt><dd><time datetime="${escapeHtml(parsed.createdAt)}">${escapeHtml(parsed.createdAt)}</time></dd></div>
    <div><dt>Contents</dt><dd>${parsed.steps.length} step${parsed.steps.length === 1 ? "" : "s"} · ${parsed.notes.length} personal note${parsed.notes.length === 1 ? "" : "s"}</dd></div>
  </dl>
</header>
${renderCorpusSection(parsed, corpora, options.versionContext)}
<main>
  <h2>Evidence steps (chronological)</h2>
  ${ordered.length
    ? ordered.map((step, index) => renderStep(step, index + 1, corpora)).join("\n")
    : `<p class="empty">No evidence steps are stored in this notebook.</p>`}
</main>
${renderNotes(parsed.notes)}
<footer class="footer">
  <p>${generated}</p>
  <p>This report is a readable rendering of stored notebook snapshot values. It does not re-run comparisons, interpolate missing values, verify receipt signatures or establish scientific support. Receipt verification marker: <strong>not-verified</strong>.</p>
  <p>Portable JSON export remains authoritative for round-trip import. Personal notes are user content and are not evidence.</p>
</footer>
</body>
</html>`;
}

/* ------------------------------------------------------------------------- */
/* U05.6 — personal-note mutations (pure, non-persistent)                    */
/* ------------------------------------------------------------------------- */

export type NotebookNoteMutationOptions = {
  /** Defaults to the current time; must be an ISO date-time when provided. */
  now?: string;
};

export type NotebookNoteMutationFailureReason =
  | "invalid-notebook"
  | "invalid-note"
  | "duplicate-note-id"
  | "note-limit"
  | "note-not-found";

export type NotebookNoteMutationResult =
  | {
    ok: true;
    notebook: Notebook;
    /** The added, updated or removed validated note. */
    note: NotebookNote;
  }
  | {
    ok: false;
    reason: NotebookNoteMutationFailureReason;
    message: string;
    issues?: string[];
  };

export type CreateNotebookNoteInput = {
  noteId: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Build one validated personal note. Classification and evidence status are
 * fixed by the contract; callers cannot promote a note to verified evidence.
 */
export function createNotebookNote(input: CreateNotebookNoteInput): NotebookNote {
  const createdAt = input.createdAt ?? currentTimestamp();
  return notebookNoteSchema.parse({
    noteId: input.noteId,
    text: input.text,
    classification: "personal-note",
    verifiedEvidence: false,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  });
}

function findNote(notebook: Notebook, noteId: string): NotebookNote | undefined {
  return notebook.notes.find(({ noteId: candidate }) => candidate === noteId);
}

function resolvedNote(notebook: Notebook, noteId: string): NotebookNote {
  const note = findNote(notebook, noteId);
  if (!note) throw new Error(`Note is absent after a successful mutation: ${noteId}`);
  return note;
}

/**
 * Add one validated note without touching any step snapshot. The input
 * notebook is not mutated and nothing is persisted.
 */
export function addNotebookNote(
  notebook: Notebook,
  note: NotebookNote,
  options: NotebookNoteMutationOptions = {},
): NotebookNoteMutationResult {
  const now = options.now === undefined ? currentTimestamp() : requireValidTimestamp(options.now, "now");
  const parsedNotebook = notebookSchema.safeParse(notebook);
  if (!parsedNotebook.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook is not valid, so the note was not added.",
      issues: zodIssueStrings(parsedNotebook.error),
    };
  }
  const parsedNote = notebookNoteSchema.safeParse(note);
  if (!parsedNote.success) {
    return {
      ok: false,
      reason: "invalid-note",
      message: "The note is not valid, so it was not added.",
      issues: zodIssueStrings(parsedNote.error),
    };
  }
  const base = parsedNotebook.data;
  if (findNote(base, parsedNote.data.noteId)) {
    return {
      ok: false,
      reason: "duplicate-note-id",
      message: `A note with this ID already exists: ${parsedNote.data.noteId}`,
    };
  }
  if (base.notes.length >= notebookLimits.maxNotes) {
    return {
      ok: false,
      reason: "note-limit",
      message: `A notebook may contain at most ${notebookLimits.maxNotes} personal notes.`,
    };
  }
  const rawNotebook = {
    ...base,
    notes: [...base.notes, parsedNote.data],
    updatedAt: latestTimestamp(base.updatedAt, parsedNote.data.createdAt, parsedNote.data.updatedAt, now),
  };
  const updated = notebookSchema.safeParse(rawNotebook);
  if (!updated.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook with the added note did not validate.",
      issues: zodIssueStrings(updated.error),
    };
  }
  const frozen = freezeStepSnapshots(updated.data);
  return { ok: true, notebook: frozen, note: resolvedNote(frozen, parsedNote.data.noteId) };
}

/**
 * Replace one note's text and update only that note's `updatedAt` plus the
 * notebook `updatedAt`. Step snapshots keep their stored values; nothing is
 * persisted automatically.
 */
export function editNotebookNote(
  notebook: Notebook,
  noteId: string,
  text: string,
  options: NotebookNoteMutationOptions = {},
): NotebookNoteMutationResult {
  const now = options.now === undefined ? currentTimestamp() : requireValidTimestamp(options.now, "now");
  const parsedNotebook = notebookSchema.safeParse(notebook);
  if (!parsedNotebook.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook is not valid, so the note was not edited.",
      issues: zodIssueStrings(parsedNotebook.error),
    };
  }
  const base = parsedNotebook.data;
  const existing = findNote(base, noteId);
  if (!existing) {
    return {
      ok: false,
      reason: "note-not-found",
      message: `No personal note exists with this ID: ${noteId}`,
    };
  }
  const parsedNote = notebookNoteSchema.safeParse({
    ...existing,
    text,
    updatedAt: latestTimestamp(existing.createdAt, existing.updatedAt, now),
  });
  if (!parsedNote.success) {
    return {
      ok: false,
      reason: "invalid-note",
      message: "The edited note is not valid, so it was not saved.",
      issues: zodIssueStrings(parsedNote.error),
    };
  }
  const rawNotebook = {
    ...base,
    notes: base.notes.map((note) => (note.noteId === noteId ? parsedNote.data : note)),
    updatedAt: latestTimestamp(base.updatedAt, now, parsedNote.data.updatedAt),
  };
  const updated = notebookSchema.safeParse(rawNotebook);
  if (!updated.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook with the edited note did not validate.",
      issues: zodIssueStrings(updated.error),
    };
  }
  const frozen = freezeStepSnapshots(updated.data);
  return { ok: true, notebook: frozen, note: resolvedNote(frozen, noteId) };
}

/** Remove one note. Step snapshots are untouched and nothing is persisted. */
export function removeNotebookNote(
  notebook: Notebook,
  noteId: string,
  options: NotebookNoteMutationOptions = {},
): NotebookNoteMutationResult {
  const now = options.now === undefined ? currentTimestamp() : requireValidTimestamp(options.now, "now");
  const parsedNotebook = notebookSchema.safeParse(notebook);
  if (!parsedNotebook.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook is not valid, so the note was not removed.",
      issues: zodIssueStrings(parsedNotebook.error),
    };
  }
  const base = parsedNotebook.data;
  const existing = findNote(base, noteId);
  if (!existing) {
    return {
      ok: false,
      reason: "note-not-found",
      message: `No personal note exists with this ID: ${noteId}`,
    };
  }
  const rawNotebook = {
    ...base,
    notes: base.notes.filter((note) => note.noteId !== noteId),
    updatedAt: latestTimestamp(base.updatedAt, now),
  };
  const updated = notebookSchema.safeParse(rawNotebook);
  if (!updated.success) {
    return {
      ok: false,
      reason: "invalid-notebook",
      message: "The notebook with the removed note did not validate.",
      issues: zodIssueStrings(updated.error),
    };
  }
  return { ok: true, notebook: freezeStepSnapshots(updated.data), note: existing };
}
