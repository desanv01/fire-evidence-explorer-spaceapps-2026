import type provenance from "../../data/flex.sources.json";
import { formatEvidenceValue } from "./evidence-format.ts";
import {
  runSearchSchema,
  type ComparisonRequest,
  type Dataset,
  type RunSearchRequest,
} from "./evidence.ts";
import { selectEvidenceSnapshot, type ExportExplanation } from "./evidence-packet.ts";

type EvidenceExportInput = {
  dataset: Dataset;
  selection: ComparisonRequest;
  search?: RunSearchRequest;
  question?: string;
};

/** Takes a snapshot of a validated dataset and its selected evidence. */
export function buildEvidenceExport({ dataset, selection, search, question }: EvidenceExportInput) {
  const comparison = selectEvidenceSnapshot(dataset, selection.runIds);
  const runsById = new Map(dataset.runs.map((run) => [run.id, run]));
  const runs = comparison.runIds.map((id) => {
    const run = runsById.get(id);
    if (!run) throw new RangeError(`Unknown run ID: ${id}`);
    return run;
  });
  const sourceIds = new Set(runs.flatMap((run) => run.fields.map((field) => field.sourceId)));

  return structuredClone({
    exportVersion: 1 as const,
    question: question ?? null,
    search: search === undefined ? null : runSearchSchema.parse(search),
    comparison,
    runs,
    sources: dataset.sources.filter(({ id }) => sourceIds.has(id)),
  });
}

export type EvidenceExport = ReturnType<typeof buildEvidenceExport> & {
  datasetSha256?: string;
  datasetProvenance?: DatasetProvenance;
  ai?: ExportExplanation;
};

export type DatasetProvenance = typeof provenance;

export function exportEvidenceJson(evidence: EvidenceExport): string {
  const { comparison } = evidence;
  const output = comparison.runIds.length === 1 ? {
    ...evidence,
    scope: "selected-runs",
    datasetVersion: comparison.datasetVersion,
    comparisonRuleVersion: comparison.comparisonRuleVersion,
    runIds: comparison.runIds,
    comparison: null,
  } : evidence;
  return JSON.stringify(output, null, 2) + "\n";
}

const csvTextPrefix = "Text: ";
const spreadsheetFormula = /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u;
const leadingControl = /^[\s\p{Cf}]*[\p{Cc}]/u;

function csvCell(value: string | number | null | undefined): string {
  if (typeof value === "number") return String(value);
  const text = value ?? "";
  const needsPrefix = spreadsheetFormula.test(text)
    || leadingControl.test(text)
    || text.startsWith(csvTextPrefix);
  const safeText = needsPrefix ? csvTextPrefix + text : text;
  return '"' + safeText.replaceAll('"', '""') + '"';
}

/** Long-form evidence with one row per field and selected run. */
export function exportEvidenceCsv(evidence: EvidenceExport): string {
  const { comparison, runs } = evidence;
  const singleRun = runs.length === 1;
  const header = [
    "export_version", "dataset_version", "comparison_rule_version", "question", "search_json",
    "selection_index", "run_id", "investigation", "field_key", "comparison_label",
    "comparison_status", "comparison_reason", "field_label", "field_kind", "value_type",
    "value", "unit", "original", "original_present", "source_locator", "source_id", "source_title",
    "source_url", "source_version", "source_license", "source_doi", "differences_from_run_json",
    "dataset_sha256", "dataset_provenance_json", "ai_json",
  ];
  const records = [header.map(csvCell).join(",")];
  const searchJson = evidence.search === null ? null : JSON.stringify(evidence.search);
  for (const [index, run] of runs.entries()) {
    const identity = [
      evidence.exportVersion, comparison.datasetVersion, comparison.comparisonRuleVersion,
      evidence.question, searchJson, index + 1, run.id, run.investigation,
    ];
    const rows = comparison.rows.length ? comparison.rows : [null];
    for (const row of rows) {
      const cell = row?.cells[index];
      const field = cell?.field;
      const source = cell?.source;
      const valueType = field ? (field.value === null ? "null" : typeof field.value) : "absent";
      const differences = row?.differences.filter(({ fromRunId }) => fromRunId === run.id);
      records.push([
        ...identity, row?.key, row?.label, singleRun && row?.status === "same" ? "reported" : row?.status,
        row?.reason, field?.label, field?.kind,
        valueType, field?.value, field?.unit, field?.original, field?.original != null ? 1 : 0,
        field?.locator, field?.sourceId,
        source?.title, source?.url, source?.version, source?.license, source?.doi,
        differences === undefined ? null : JSON.stringify(differences), evidence.datasetSha256,
        records.length === 1 && evidence.datasetProvenance ? JSON.stringify(evidence.datasetProvenance) : null,
        records.length === 1 && evidence.ai ? JSON.stringify(evidence.ai) : null,
      ].map(csvCell).join(","));
    }
  }
  return records.join("\r\n") + "\r\n";
}

/** Plain text for download or printing. Values and locators use JSON quoting. */
export function exportEvidenceBrief(evidence: EvidenceExport): string {
  const { comparison, runs, sources } = evidence;
  const singleRun = runs.length === 1;
  const lines = [
    "Fire Evidence Explorer evidence brief",
    "",
    `Export format ${evidence.exportVersion}`,
    `Dataset version ${JSON.stringify(comparison.datasetVersion)}`,
    ...(evidence.datasetSha256 ? [`Dataset SHA-256 ${evidence.datasetSha256}`] : []),
    `Comparison rule version ${JSON.stringify(comparison.comparisonRuleVersion)}`,
    `Question ${JSON.stringify(evidence.question)}`,
    `Applied search ${JSON.stringify(evidence.search)}`,
    "",
    "Selected runs",
    ...runs.map(({ id, investigation }) => `- ${JSON.stringify(id)} (${JSON.stringify(investigation)})`),
    "",
    ...(singleRun ? ["Recorded run evidence"] : ["Comparison", "Unrecorded conditions may affect comparability."]),
  ];
  if (!comparison.rows.length) lines.push("The selected runs have no recorded fields.");
  for (const row of comparison.rows) {
    const status = singleRun && row.status === "same" ? "reported" : row.status;
    lines.push("", `${JSON.stringify(row.label)} [${JSON.stringify(row.key)}] · ${status}`, row.reason);
    for (const { runId, field } of row.cells) {
      const run = JSON.stringify(runId);
      if (!field) {
        lines.push(`- Run ${run} has no such field.`);
        continue;
      }
      const value = typeof field.value === "string" ? JSON.stringify(field.value)
        : formatEvidenceValue(field.value, { original: field.original });
      const unit = field.unit === null ? "" : ` ${JSON.stringify(field.unit)}`;
      lines.push(
        `- Run ${run} · ${field.kind} · ${value}${unit}`,
        `  Original ${JSON.stringify(field.original)}`,
        `  Source ${JSON.stringify(field.sourceId)} at ${JSON.stringify(field.locator)}`,
      );
    }
    for (const { fromRunId, toRunId, delta } of row.differences) {
      const unit = row.cells.find(({ runId }) => runId === fromRunId)?.field?.unit;
      lines.push(`- Run ${JSON.stringify(toRunId)} minus run ${JSON.stringify(fromRunId)} = ${formatEvidenceValue(delta, { signed: true })}${unit ? ` ${unit}` : ""}`);
    }
  }
  lines.push("", "Sources");
  if (!sources.length) lines.push("No sources are attached to these runs.");
  for (const source of sources) {
    lines.push(
      `- ${JSON.stringify(source.id)} · ${JSON.stringify(source.title)}`,
      `  URL ${source.url}`,
      `  Revision ${JSON.stringify(source.version)} · License ${JSON.stringify(source.license)}`,
    );
    if (source.doi !== undefined) lines.push(`  DOI ${JSON.stringify(source.doi)}`);
  }
  if (evidence.datasetProvenance) {
    const { source, interpretationReference, transforms } = evidence.datasetProvenance;
    lines.push("", "Dataset provenance",
      `Source file ${source.fileName} · revision ${source.fileVersion}`,
      `Source file SHA-256 ${source.sha256}`,
      `Interpretation reference ${interpretationReference.reportNumber} · ${interpretationReference.url}`,
      ...interpretationReference.locations.map(({ section, printedPage, pdfPage }) =>
        `- ${section}, printed page ${printedPage}, PDF page ${pdfPage}`),
      ...Object.values(transforms).map((transform) => `- ${transform}`),
    );
  }
  if (evidence.ai) {
    const { explanation, citations, packet, packetVersion } = evidence.ai;
    const provenance = explanation.provenance;
    const heading = provenance ? "Evidence-only fallback"
      : explanation.model ? "Evidence explanation" : "Evidence-only result";
    lines.push("", heading, `Status ${explanation.status}`, `Packet version ${packetVersion}`);
    if (provenance) lines.push(`Evidence rule version ${provenance.ruleVersion}`);
    if (explanation.withheldClaims !== undefined) {
      const count = explanation.withheldClaims;
      const detail = count === 1 ? "claim was" : "claims were";
      lines.push(`Partial explanation. ${count} ${detail} withheld because the prose contained quantities.`);
    }
    if (explanation.model) {
      const { requested, returned, promptVersion, configVersion } = explanation.model;
      if (provenance) lines.push(`Attempted model ${requested}`, `Model returned by attempt ${JSON.stringify(returned)}`);
      else lines.push(`Requested model ${requested}`, `Returned model ${JSON.stringify(returned)}`);
      lines.push(
        `Prompt version ${promptVersion}`, `Configuration version ${configVersion}`);
    }
    const references = new Map<string, { index: number; label: string }>();
    for (const claim of explanation.claims) {
      lines.push(`- ${claim.status} · ${claim.text}`);
      const { citationTargets } = claim;
      const claimReferences = new Set<number>();
      for (const id of claim.citationIds) {
        const citation = citations[id];
        const sources = citationTargets || provenance?.kind === "deterministic-evidence"
          ? citation.sources.filter(({ runId }) => citationTargets?.some(
            (target) => target.citationId === id && target.runId === runId,
          ))
          : citation.sources;
        for (const { runId, sourceId, locator } of sources) {
          const key = JSON.stringify([runId, citation.fieldKey, sourceId, locator]);
          let reference = references.get(key);
          if (!reference) {
            reference = { index: references.size + 1, label: `${runId} · ${citation.fieldKey} · ${sourceId} · ${locator}` };
            references.set(key, reference);
          }
          claimReferences.add(reference.index);
        }
      }
      if (claimReferences.size) lines.push(`  Sources ${[...claimReferences].map((index) => `[${index}]`).join(", ")}`);
      for (const { label, value, unit } of claim.measurements) {
        lines.push(`  ${label} = ${formatEvidenceValue(value)} ${unit}`.trimEnd());
      }
    }
    if (references.size) {
      lines.push("", "Explanation source references");
      for (const { index, label } of references.values()) lines.push(`[${index}] ${label}`);
    }
    lines.push("", "Explanation limits", ...(packet.limitations ?? []).map((limit) => `- ${limit}`));
  }
  return lines.join("\n") + "\n";
}

export function exportPrintableBrief(evidence: EvidenceExport): string {
  const text = exportEvidenceBrief(evidence)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fire Evidence Explorer evidence brief</title>
<style>
  body { color: #111; margin: 2rem auto; max-width: 80ch; padding: 0 1rem; }
  pre { font: 1rem/1.5 system-ui, sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media print { body { margin: 0; padding: 0; } pre { font-size: 10pt; } }
</style>
</head>
<body><main><pre>${text}</pre></main></body>
</html>`;
}
