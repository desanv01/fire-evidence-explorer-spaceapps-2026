import type { DeepSeekClaim, DeepSeekExplanation } from "./deepseek.ts";
import type { buildExplanationPacket } from "./evidence-packet.ts";
import type { ComparisonResult } from "./evidence.ts";

type Context = ReturnType<typeof buildExplanationPacket>;
type Cell = ComparisonResult["rows"][number]["cells"][number];
type Claim = Omit<DeepSeekClaim, "scope">;

function citedField(comparison: ComparisonResult, context: Context, fieldKey: string) {
  const row = comparison.rows.find(({ key }) => key === fieldKey);
  const entry = Object.entries(context.citations).find(([id, citation]) =>
    id.startsWith("field:") && citation.fieldKey === fieldKey);
  if (!row || !entry) return null;
  const [id, citation] = entry;
  if (!context.packet.evidence.some((item) => item.id === id)) return null;
  const cells = row.cells.filter(({ runId, field, source }) => field && source?.id === field.sourceId
    && citation.sources.some((anchor) => anchor.runId === runId
      && anchor.sourceId === field.sourceId && anchor.locator === field.locator));
  return { id, cells };
}

function measurements(citationId: string, cells: Cell[]): DeepSeekClaim["measurements"] {
  return cells.flatMap(({ runId, field }) => typeof field?.value === "number"
    ? [{ citationId, label: `${field.label} (${runId})`, value: field.value, unit: field.unit ?? "" }]
    : []);
}

function targets(citationId: string, cells: Cell[]) {
  return cells.map(({ runId }) => ({ citationId, runId }));
}

function explanation(scope: DeepSeekExplanation["scope"], claims: Claim[]): DeepSeekExplanation {
  return {
    status: claims.some(({ status }) => status !== "insufficient") ? "supported" : "insufficient",
    scope,
    claims: claims.map((claim) => ({ ...claim, scope })),
    model: null,
    provenance: { kind: "deterministic-evidence", ruleVersion: "flex-evidence-1" },
  };
}

export function explainSelectedFlexEvidence(
  question: string,
  comparison: ComparisonResult,
  context: Context,
): DeepSeekExplanation | null {
  if (!comparison.runIds.every((id) => /^FLEX-[0-9]{3}$/.test(id))) return null;
  const query = question.trim().replaceAll("’", "'").replace(/\s+/g, " ");

  const burnTime = /^Did (FLEX-[0-9]{3}) burn for (?:zero|0) seconds\??$/i.exec(query)
    ?? /^Was (FLEX-[0-9]{3})'s burn (?:time|duration) (?:zero|0)(?: seconds)?\??$/i.exec(query);
  if (burnTime) {
    const runId = burnTime[1].toUpperCase();
    const evidence = citedField(comparison, context, "burn_time");
    const cell = evidence?.cells.find((candidate) => candidate.runId === runId);
    if (!evidence || cell?.field?.value !== null || cell.field.original !== null) return null;
    return explanation(context.packet.scope, [{
      status: "insufficient",
      text: `The burn time for ${runId} is unreported. The blank entry gives no burn-duration measurement.`,
      citationIds: [evidence.id],
      citationTargets: targets(evidence.id, [cell]),
      measurements: [],
    }]);
  }

  const causal = /^Do (FLEX-[0-9]{3}) and (FLEX-[0-9]{3}) prove that initial droplet (?:size|diameter) caused the outcome difference\??$/i.exec(query)
    ?? /^Can we conclude that (?:the )?initial droplet (?:size|diameter) caused the (?:outcome )?difference between (FLEX-[0-9]{3}) and (FLEX-[0-9]{3})\??$/i.exec(query);
  if (causal && comparison.runIds.length === 2) {
    const asked = new Set(causal.slice(1).map((id) => id.toUpperCase()));
    if (!comparison.runIds.every((id) => asked.has(id))) return null;
    const size = citedField(comparison, context, "diameter");
    const extinction = citedField(comparison, context, "extinction_diameter");
    if (size?.cells.length !== 2 || extinction?.cells.length !== 2) return null;
    const sizes = measurements(size.id, size.cells);
    const extinctions = measurements(extinction.id, extinction.cells);
    const missing = extinction.cells.find(({ field }) => field?.value === null && field.original === null);
    const observed = extinction.cells.find(({ field }) => typeof field?.value === "number");
    if (sizes.length !== 2 || sizes.some(({ unit }) => unit !== "mm") || sizes[0].value === sizes[1].value
      || !missing || !observed || extinctions.length !== 1 || extinctions[0].unit !== "mm") return null;
    return explanation(context.packet.scope, [{
      status: "reported",
      text: "The recorded initial droplet diameters differ.",
      citationIds: [size.id],
      citationTargets: targets(size.id, size.cells),
      measurements: sizes,
    }, {
      status: "reported",
      text: `The visible flame extinction diameter is unreported for ${missing.runId} and recorded for ${observed.runId}.`,
      citationIds: [extinction.id],
      citationTargets: targets(extinction.id, extinction.cells),
      measurements: extinctions,
    }, {
      status: "insufficient",
      text: "This comparison cannot establish that initial droplet size caused the outcome difference. The missing extinction measurement also limits direct comparison.",
      citationIds: [size.id, extinction.id],
      citationTargets: [...targets(size.id, size.cells), ...targets(extinction.id, extinction.cells)],
      measurements: [],
    }]);
  }

  const cessation = /^Does visible (?:flame )?extinction alone prove (?:that )?all combustion (?:stopped|ceased) in (FLEX-[0-9]{3})\??$/i.exec(query)
    ?? /^Does (FLEX-[0-9]{3})'s visible (?:flame )?extinction (?:mean|prove) (?:that )?all combustion (?:stopped|ceased)\??$/i.exec(query);
  if (!cessation) return null;
  const runId = cessation[1].toUpperCase();
  const extinction = citedField(comparison, context, "extinction_diameter");
  const end = citedField(comparison, context, "test_end");
  const outcome = end?.cells.find((cell) => cell.runId === runId);
  if (!extinction || !end || outcome?.field?.value !== "Extinction") return null;
  const cells = extinction.cells.filter((cell) => cell.runId === runId);
  const observed = measurements(extinction.id, cells);
  if (observed.length !== 1 || observed[0].unit !== "mm") return null;
  const citationTargets = [...targets(extinction.id, cells), ...targets(end.id, [outcome])];
  return explanation(context.packet.scope, [{
    status: "reported",
    text: `The selected record reports visible flame extinction and the droplet diameter at that point for ${runId}.`,
    citationIds: [extinction.id, end.id],
    citationTargets,
    measurements: observed,
  }, {
    status: "insufficient",
    text: "Visible flame extinction alone cannot establish that all combustion stopped. Whether burning continued remains unresolved by these measurements.",
    citationIds: [extinction.id, end.id],
    citationTargets,
    measurements: [],
  }]);
}
