import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRuns, parseDataset, readEvidenceSearch, searchRuns, writeEvidenceSearch } from "../src/lib/evidence.ts";

const source = {
  id: "fixture-source",
  title: "Synthetic fixture table",
  url: "https://example.test/fixture",
  version: "fixture-1",
  license: "Synthetic test data",
};

function field(key, value, unit = null, kind = "condition") {
  return {
    key, label: key, kind, value, unit,
    original: value === null ? null : String(value),
    sourceId: source.id,
    locator: `Synthetic fixture, column ${key}`,
  };
}

const fixture = {
  version: "synthetic-fixture-1",
  sources: [source],
  runs: [
    { id: "fixture-a", investigation: "Fixture A", fields: [
      field("fuel", "Example fuel"), field("pressure", 100, "kPa"),
      field("diameter", null, "mm"), field("time", 2, "s", "outcome"),
      field("temperature", 25, "°C"),
    ] },
    { id: "fixture-b", investigation: "Fixture A", fields: [
      field("fuel", "Example fuel"), field("pressure", 105, "kPa"),
      field("diameter", 2, "mm"), field("time", 3, "s", "outcome"),
      field("temperature", 298, "K"),
    ] },
    { id: "fixture-c", investigation: "Fixture B", fields: [
      field("fuel", "Example fuel"), field("pressure", 98, "kPa"),
      field("time", 4, "s", "outcome"),
    ] },
  ],
};

const dataset = parseDataset(fixture);

test("rejects duplicate identifiers, dangling source references and blank values", () => {
  const invalid = structuredClone(fixture);
  invalid.sources.push(source);
  invalid.runs[0].fields.push(field("fuel", " "));
  invalid.runs[0].fields[0].sourceId = "missing";
  invalid.runs.push(invalid.runs[1]);

  assert.throws(() => parseDataset(invalid), (error) => {
    assert.deepEqual(error.issues.map(({ path }) => path.join(".")).sort(), [
      "runs.0.fields.0.sourceId",
      "runs.0.fields.5.key",
      "runs.0.fields.5.value",
      "runs.3.id",
      "sources.1.id",
    ]);
    return true;
  });
});

test("searches case-insensitively and combines exact, typed filters in catalog order", () => {
  const findIds = (request) => searchRuns(dataset, request).map(({ id }) => id);
  assert.deepEqual(findIds({ query: "  FUEL  TABLE  " }), ["fixture-a", "fixture-b", "fixture-c"]);
  assert.deepEqual(findIds({
    query: "example kpa", investigation: "Fixture A",
    filters: [{ key: "pressure", value: 105 }, { key: "fuel", value: "Example fuel" }],
  }), ["fixture-b"]);
  assert.deepEqual(findIds({ filters: [{ key: "pressure", value: "105" }] }), []);
  assert.deepEqual(findIds({ filters: [{ key: "diameter", value: null }] }), ["fixture-a"]);
  assert.throws(() => findIds({ filters: [{ key: "diameter", value: true }] }));
});

test("compares two runs and preserves source, units and selection order", () => {
  const result = compareRuns(dataset, { runIds: ["fixture-b", "fixture-a"] });
  assert.equal(result.datasetVersion, fixture.version);
  assert.equal(result.comparisonRuleVersion, "1");
  assert.deepEqual(result.runIds, ["fixture-b", "fixture-a"]);
  const rows = new Map(result.rows.map((row) => [row.key, row]));
  assert.equal(rows.get("fuel").status, "same");
  assert.equal(rows.get("pressure").status, "different");
  assert.deepEqual(rows.get("pressure").differences, [
    { fromRunId: "fixture-b", toRunId: "fixture-a", delta: -5 },
  ]);
  assert.equal(rows.get("diameter").status, "unknown");
  assert.deepEqual(rows.get("diameter").cells[1].source, source);
  assert.equal(rows.get("temperature").status, "incompatible");
  assert.deepEqual(rows.get("temperature").differences, []);
});

test("compares three runs with pairwise differences and absent fields", () => {
  const { rows } = compareRuns(dataset, { runIds: ["fixture-a", "fixture-b", "fixture-c"] });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get("pressure").differences, [
    { fromRunId: "fixture-a", toRunId: "fixture-b", delta: 5 },
    { fromRunId: "fixture-a", toRunId: "fixture-c", delta: -2 },
    { fromRunId: "fixture-b", toRunId: "fixture-c", delta: -7 },
  ]);
  assert.deepEqual(byKey.get("diameter").cells[2], { runId: "fixture-c", field: null, source: null });
  assert.equal(byKey.get("time").status, "incompatible");
  assert.deepEqual(byKey.get("time").differences, []);
});

test("rejects invalid run selections", () => {
  assert.throws(() => compareRuns(dataset, { runIds: ["fixture-a"] }));
  assert.throws(() => compareRuns(dataset, { runIds: ["fixture-a", "fixture-a"] }));
  assert.throws(() => compareRuns(dataset, { runIds: ["fixture-a", "fixture-b", "fixture-c", "unknown"] }));
  assert.throws(() => compareRuns(dataset, { runIds: ["fixture-a", "unknown"] }), /Unknown run ID: unknown/);
});

test("share URLs restore typed search without changing the ordered comparison", () => {
  const legacy = new URL("https://example.test/?run=FLEX-005&run=FLEX-001#evidence");
  const search = {
    query: "methanol & O₂",
    investigation: "FLEX",
    filters: [{ key: "pressure", value: 760 }, { key: "diameter", value: null }],
  };
  const shared = writeEvidenceSearch(legacy, search);
  assert.deepEqual(readEvidenceSearch(shared), search);
  assert.deepEqual(shared.searchParams.getAll("run"), ["FLEX-005", "FLEX-001"]);
  assert.equal(shared.hash, "#evidence");
  assert.equal(readEvidenceSearch(legacy), undefined);
  assert.equal(writeEvidenceSearch(shared).href, legacy.href);

  shared.searchParams.append("search", "{}");
  assert.equal(readEvidenceSearch(shared), undefined);
  shared.searchParams.set("search", "{");
  assert.equal(readEvidenceSearch(shared), undefined);
  shared.searchParams.set("search", '{"filters":[{"key":"pressure","value":true}]}');
  assert.equal(readEvidenceSearch(shared), undefined);
});
