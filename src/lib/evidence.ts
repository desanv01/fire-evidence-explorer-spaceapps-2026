import { z } from "zod";

const nonBlank = z.string().min(1).refine((text) => text.trim().length > 0);
const recordedValue = z.union([z.number(), nonBlank, z.null()]);

const sourceSchema = z.strictObject({
  id: nonBlank,
  title: nonBlank,
  url: z.url({ protocol: /^https?$/ }),
  version: nonBlank,
  license: nonBlank,
  doi: nonBlank.optional(),
});

const fieldSchema = z.strictObject({
  key: nonBlank,
  label: nonBlank,
  kind: z.enum(["condition", "outcome"]),
  value: recordedValue,
  unit: nonBlank.nullable(),
  original: z.string().nullable(),
  locator: nonBlank,
  sourceId: nonBlank,
});

const runSchema = z.strictObject({
  id: nonBlank,
  investigation: nonBlank,
  fields: z.array(fieldSchema),
});

export const datasetSchema = z.strictObject({
  version: nonBlank,
  sources: z.array(sourceSchema),
  runs: z.array(runSchema),
}).superRefine((dataset, context) => {
  const sourceIds = new Set<string>();
  for (const [index, source] of dataset.sources.entries()) {
    if (sourceIds.has(source.id)) {
      context.addIssue({ code: "custom", path: ["sources", index, "id"], message: "Duplicate source ID" });
    }
    sourceIds.add(source.id);
  }

  const runIds = new Set<string>();
  for (const [index, run] of dataset.runs.entries()) {
    if (runIds.has(run.id)) {
      context.addIssue({ code: "custom", path: ["runs", index, "id"], message: "Duplicate run ID" });
    }
    runIds.add(run.id);

    const keys = new Set<string>();
    for (const [fieldIndex, field] of run.fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({ code: "custom", path: ["runs", index, "fields", fieldIndex, "key"], message: "Duplicate field key in run" });
      }
      keys.add(field.key);
      if (!sourceIds.has(field.sourceId)) {
        context.addIssue({ code: "custom", path: ["runs", index, "fields", fieldIndex, "sourceId"], message: "Field references an unknown source" });
      }
    }
  }
});

export const runSearchSchema = z.strictObject({
  query: z.string().optional(),
  investigation: nonBlank.optional(),
  filters: z.array(z.strictObject({ key: nonBlank, value: recordedValue })).optional(),
});

export const comparisonRequestSchema = z.strictObject({
  runIds: z.array(nonBlank).min(2).max(3)
    .refine((ids) => new Set(ids).size === ids.length, "Select distinct runs"),
});

export type Dataset = z.infer<typeof datasetSchema>;
export type EvidenceSource = z.infer<typeof sourceSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunField = z.infer<typeof fieldSchema>;
export type RunSearchRequest = z.infer<typeof runSearchSchema>;
export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>;

/** Old links omit search; malformed or repeated search parameters fall back to the default. */
export function readEvidenceSearch(url: URL): RunSearchRequest | undefined {
  const [value, duplicate] = url.searchParams.getAll("search");
  if (value === undefined || duplicate !== undefined) return undefined;
  try {
    const search = runSearchSchema.safeParse(JSON.parse(value));
    return search.success ? search.data : undefined;
  } catch {
    return undefined;
  }
}

/** Write the explorer request only, preserving the ordered comparison and other URL parameters. */
export function writeEvidenceSearch(url: URL, search?: RunSearchRequest): URL {
  const updated = new URL(url);
  if (search === undefined) updated.searchParams.delete("search");
  else updated.searchParams.set("search", JSON.stringify(runSearchSchema.parse(search)));
  return updated;
}

export const comparisonRuleVersion = "1";

type ComparisonCell = { runId: string; field: RunField | null; source: EvidenceSource | null };
// A delta is toRunId minus fromRunId, in the unit shared by the row's fields.
type Difference = { fromRunId: string; toRunId: string; delta: number };
type ComparisonRow = {
  key: string;
  label: string;
  status: "same" | "different" | "unknown" | "incompatible";
  reason: string;
  cells: ComparisonCell[];
  differences: Difference[];
};

export type ComparisonResult = {
  datasetVersion: string;
  comparisonRuleVersion: string;
  runIds: string[];
  rows: ComparisonRow[];
};

export function parseDataset(input: unknown): Dataset {
  return datasetSchema.parse(input);
}

/** Catalog order is preserved. Filters use typed equality and match null only on an existing field. */
export function searchRuns(dataset: Dataset, request: RunSearchRequest = {}): Run[] {
  const { query, investigation, filters = [] } = runSearchSchema.parse(request);
  const terms = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));

  return dataset.runs.filter((run) => {
    if (investigation !== undefined && investigation !== run.investigation) return false;
    if (!filters.every(({ key, value }) => run.fields.some((field) => field.key === key && field.value === value))) return false;
    if (!terms.length) return true;

    const text = [run.id, run.investigation, ...run.fields.flatMap((field) => [
      field.key, field.label, field.value, field.unit, field.original, field.locator,
      sources.get(field.sourceId)?.title,
    ])].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function numericDifferences(cells: ComparisonCell[]): Difference[] {
  const differences: Difference[] = [];
  for (const [index, from] of cells.entries()) {
    const fromValue = from.field?.value;
    if (typeof fromValue !== "number") continue;
    for (const to of cells.slice(index + 1)) {
      const toValue = to.field?.value;
      if (typeof toValue !== "number") continue;
      const delta = toValue - fromValue;
      if (Number.isFinite(delta)) differences.push({ fromRunId: from.runId, toRunId: to.runId, delta });
    }
  }
  return differences;
}

function compareFields(cells: ComparisonCell[], runs: Run[]): Pick<ComparisonRow, "status" | "reason" | "differences"> {
  const present = cells.flatMap(({ field }) => field ? [field] : []);
  const knownValues = present.map(({ value }) => value).filter((value) => value !== null);
  const kinds = new Set(present.map(({ kind }) => kind));
  const units = new Set(present.map(({ unit }) => unit));
  const valueTypes = new Set(knownValues.map((value) => typeof value));
  const outcomeStudies = new Set(runs.filter((_, index) => cells[index].field?.kind === "outcome")
    .map(({ investigation }) => investigation));

  if (kinds.size > 1) return { status: "incompatible", reason: "Field kinds differ.", differences: [] };
  if (units.size > 1) return { status: "incompatible", reason: "Recorded units differ.", differences: [] };
  if (outcomeStudies.size > 1) return { status: "incompatible", reason: "Outcome definitions are investigation-specific.", differences: [] };
  if (valueTypes.size > 1) return { status: "incompatible", reason: "Value representations differ.", differences: [] };

  const differences = numericDifferences(cells);
  if (knownValues.length < cells.length) return { status: "unknown", reason: "At least one value is missing.", differences };
  if (new Set(knownValues).size === 1) return { status: "same", reason: "Recorded values match exactly.", differences };
  return { status: "different", reason: "Recorded values differ.", differences };
}

export function compareRuns(dataset: Dataset, request: ComparisonRequest): ComparisonResult {
  const { runIds } = comparisonRequestSchema.parse(request);
  const catalog = new Map(dataset.runs.map((run) => [run.id, run]));
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  const runs = runIds.map((id) => {
    const run = catalog.get(id);
    if (!run) throw new RangeError(`Unknown run ID: ${id}`);
    return run;
  });

  const labels = new Map<string, string>();
  const fieldsByRun = runs.map((run) => new Map(run.fields.map((field) => {
    if (!labels.has(field.key)) labels.set(field.key, field.label);
    return [field.key, field];
  })));

  const rows = Array.from(labels, ([key, label]) => {
    const cells = runIds.map((runId, index) => {
      const field = fieldsByRun[index].get(key) ?? null;
      const source = field ? sources.get(field.sourceId) ?? null : null;
      return { runId, field, source };
    });
    return { key, label, cells, ...compareFields(cells, runs) };
  });

  return { datasetVersion: dataset.version, comparisonRuleVersion, runIds, rows };
}
