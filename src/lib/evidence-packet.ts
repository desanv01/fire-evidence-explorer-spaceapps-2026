import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DeepSeekEvidencePacket, DeepSeekExplanation } from "./deepseek.ts";
import { compareRuns, comparisonRuleVersion, type ComparisonResult, type Dataset } from "./evidence.ts";

type EvidenceItem = DeepSeekEvidencePacket["evidence"][number];

export function selectEvidenceSnapshot(dataset: Dataset, runIds: string[]): ComparisonResult {
  if (runIds.length !== 1) return compareRuns(dataset, { runIds });
  const run = dataset.runs.find(({ id }) => id === runIds[0]);
  if (!run) throw new RangeError("Unknown evidence run");
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  return {
    datasetVersion: dataset.version, comparisonRuleVersion, runIds,
    rows: run.fields.map((field) => ({
      key: field.key, label: field.label,
      status: field.value === null ? "unknown" : "same",
      reason: field.value === null ? "The selected run does not report this value." : "The selected run reports this value.",
      cells: [{ runId: run.id, field, source: sources.get(field.sourceId) ?? null }],
      differences: [],
    })),
  };
}

export function buildExplanationPacket(comparison: ComparisonResult) {
  const evidence: EvidenceItem[] = [];
  const citations: Record<string, {
    fieldKey: string;
    sources: { runId: string; sourceId: string; locator: string }[];
  }> = {};
  const derived: EvidenceItem[] = [];
  for (const [index, row] of comparison.rows.slice(0, 16).entries()) {
    const id = `field:${index + 1}`;
    const observed = row.cells.filter(({ field }) => field && field.value !== null);
    const numbers = observed.flatMap(({ runId, field }) =>
      typeof field?.value === "number"
        ? [{ label: `${row.label} (${runId})`, value: field.value, unit: field.unit ?? "" }]
        : []);
    evidence.push({
      id,
      status: observed.length ? "reported" : "unknown",
      text: `${row.label}. ${row.cells.map(({ runId, field }) => {
        const value = field?.value == null ? "unknown" : `${field.value} ${field.unit ?? ""}`.trim();
        return `${runId}: ${value}`;
      }).join("; ")}.`,
      ...(numbers.length ? { numbers } : {}),
    });
    citations[id] = {
      fieldKey: row.key,
      sources: row.cells.flatMap(({ runId, field }) => field
        ? [{ runId, sourceId: field.sourceId, locator: field.locator }]
        : []),
    };
    const differences = row.differences.filter(({ delta }) => delta !== 0);
    if (differences.length) {
      const unit = row.cells.find(({ field }) => field)?.field?.unit ?? "";
      const deltaId = `delta:${index + 1}`;
      derived.push({
        id: deltaId,
        status: "derived",
        text: `${row.label}. Differences in shared recorded units, later selection minus earlier selection.`,
        numbers: differences.map(({ toRunId, fromRunId, delta }) => ({
          label: `${row.label} (${toRunId} minus ${fromRunId})`, value: delta, unit,
        })),
      });
      citations[deltaId] = {
        fieldKey: row.key,
        sources: citations[id].sources.filter(({ runId }) =>
          differences.some(({ fromRunId, toRunId }) => fromRunId === runId || toRunId === runId)),
      };
    }
  }
  const limitations = [
    "The packet covers the selected runs in the curated FLEX subset.",
    "Matching recorded values cannot establish scientific equivalence. Unrecorded conditions may affect outcomes.",
    "Some visible flame extinction diameters were estimated from the burning history. The PSI table does not identify individual estimates.",
    "The deterministic comparison uses exact equality in compatible recorded units.",
  ];
  if (evidence.length < comparison.rows.length || evidence.length + derived.length > 16) {
    limitations.push("The packet size limit can omit fields or computed differences. The deterministic comparison contains the complete result.");
  }
  evidence.push(...derived.slice(0, 16 - evidence.length));
  const packet: DeepSeekEvidencePacket = {
    scope: comparison.runIds.length === 1 ? "selected-runs" : "selected-comparison", evidence, limitations,
  };
  return {
    packetVersion: 1,
    packet,
    citations: Object.fromEntries(evidence.map(({ id }) => [id, citations[id]])),
  };
}

export type ExportExplanation = ReturnType<typeof buildExplanationPacket> & {
  explanation: DeepSeekExplanation;
};

export function explanationIdentity(
  datasetHash: string, question: string, comparison: ComparisonResult,
  context: ReturnType<typeof buildExplanationPacket>,
) {
  return createHash("sha256").update(JSON.stringify([
    datasetHash, question, comparison.datasetVersion, comparison.comparisonRuleVersion,
    comparison.runIds, context,
  ])).digest("hex");
}

// The provider key stays server-side. Derive a purpose-specific key for portable receipts.
function signature(encoded: string, secret: string) {
  const key = createHmac("sha256", secret).update("fire-evidence-explorer:export-key:v1").digest();
  return createHmac("sha256", key).update(encoded).digest();
}

export function createExplanationReceipt(identity: string, explanation: DeepSeekExplanation, secret: string) {
  const encoded = Buffer.from(JSON.stringify({ identity, explanation })).toString("base64url");
  return `${encoded}.${signature(encoded, secret).toString("base64url")}`;
}

export function readExplanationReceipt(
  receipt: string, identity: string, secret: string,
): DeepSeekExplanation | null {
  const [encoded, tokenSignature] = receipt.split(".");
  const actual = Buffer.from(tokenSignature, "base64url");
  const expected = signature(encoded, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    identity: string;
    explanation: DeepSeekExplanation;
  };
  return payload.identity === identity ? payload.explanation : null;
}
