import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import {
  plotAxisUnits,
  plotLimitationsForSpec,
  plotResultSchema,
  validatePlotResultAgainstDataset,
} from "../src/lib/upgrades/plot.ts";
import { resolveStableFieldReference } from "../src/lib/upgrades/provenance.ts";
import {
  PlotEngineError,
  buildPlotResult,
  isPlotEngineError,
  plotEngineErrorCodes,
  plotEngineLimits,
  plotEngineRuleVersions,
} from "../src/lib/upgrades/plot-engine.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;
const sourceId = "psi-69-flex-table-v1";

const scatterSpec = (xField, yField, scope) => ({
  version: "plot-spec-1",
  kind: "scatter",
  axes: { x: { field: xField }, y: { field: yField } },
  grouping: "none",
  scope,
});

const pointComparisonSpec = (yField, scope, grouping = "none") => ({
  version: "plot-spec-1",
  kind: "point-comparison",
  axes: { y: { field: yField } },
  grouping,
  scope,
});

function run(runId) {
  const found = dataset.runs.find(({ id }) => id === runId);
  assert.ok(found, `Fixture run ${runId} should exist in data/flex.json`);
  return found;
}

function recordedValue(runId, fieldKey) {
  const field = run(runId).fields.find(({ key }) => key === fieldKey);
  assert.ok(field, `Fixture run ${runId} should record ${fieldKey}`);
  return field.value;
}

function reference(runId, fieldKey) {
  return { datasetVersion, runId, fieldKey, sourceId };
}

function plotFailure(spec, datasetArg = dataset) {
  try {
    buildPlotResult(datasetArg, spec);
  } catch (error) {
    assert.ok(error instanceof PlotEngineError, `Expected PlotEngineError, received: ${error}`);
    return error;
  }
  assert.fail("Expected buildPlotResult to reject the input");
}

function assertSourcesMatchPoints(datasetArg, result, expectedX = null) {
  for (const point of result.points) {
    assert.equal(point.sourceReferences.length, expectedX === null ? 1 : 2);
    const expected = expectedX === null
      ? [["y", point.y]]
      : [["x", point.x], ["y", point.y]];
    for (const [index, reference] of point.sourceReferences.entries()) {
      const [axis, value] = expected[index];
      assert.equal(reference.datasetVersion, datasetArg.version);
      assert.equal(reference.runId, point.runId);
      assert.equal(reference.sourceId, sourceId);
      const resolution = resolveStableFieldReference(datasetArg, reference);
      assert.equal(resolution.status, "resolved", `${point.runId}/${reference.fieldKey} should resolve`);
      assert.equal(resolution.field.value, value, `${point.runId} ${axis} value should match the corpus`);
      assert.equal(resolution.source.id, sourceId);
      assert.ok(resolution.field.locator.includes("PSI-69_Experimental table_FLEX.csv"));
    }
  }
}

test("engine metadata exposes frozen rule versions, bounds and typed failure codes", () => {
  assert.equal(plotEngineRuleVersions.scope, "plot-scope-1");
  assert.equal(plotEngineRuleVersions.omissionAccounting, "plot-omission-1");
  assert.deepEqual(plotEngineLimits, { resolvedRunCount: 128, activeFilterCount: 16 });
  assert.ok(plotEngineErrorCodes.includes("unknown-runs"));
  assert.equal(plotEngineErrorCodes.includes("empty-scope"), false);
  assert.equal(isPlotEngineError(new PlotEngineError("unknown-runs", "x")), true);
  assert.equal(isPlotEngineError(new Error("x")), false);
});

test("real diameter x burn-time plot includes 28 runs and accounts for FLEX-009/012/024", () => {
  const spec = scatterSpec("diameter", "burn_time", { kind: "all-reviewed-runs" });
  const result = buildPlotResult(dataset, spec);

  assert.doesNotThrow(() => plotResultSchema.parse(result));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, result), []);
  assert.equal(result.version, "plot-result-1");
  assert.equal(result.specVersion, "plot-spec-1");
  assert.equal(result.datasetVersion, datasetVersion);
  assert.equal(result.kind, "scatter");
  assert.deepEqual(result.axes, { kind: "scatter", x: "diameter", y: "burn_time" });
  assert.deepEqual(plotAxisUnits(spec), { x: "mm", y: "s" });
  assert.equal(result.grouping, "none");
  assert.deepEqual(result.scope, { kind: "all-reviewed-runs", search: null, activeFilters: [] });
  assert.deepEqual(result.resolvedRunIds, dataset.runs.map(({ id }) => id));
  assert.equal(result.resolvedRunIds.length, 31);
  assert.equal(result.includedCount, 28);
  assert.equal(result.omittedCount, 3);
  assert.equal(result.includedCount + result.omittedCount, result.resolvedRunIds.length);
  assert.equal(result.points.length, 28);
  assert.equal(result.omitted.length, 3);
  assert.deepEqual(result.omitted, [
    { runId: "FLEX-009", reasons: ["missing-x", "missing-y"] },
    { runId: "FLEX-012", reasons: ["missing-y"] },
    { runId: "FLEX-024", reasons: ["missing-x", "missing-y"] },
  ]);
  assert.deepEqual(result.limitations, plotLimitationsForSpec(spec));
  assert.equal(result.limitations.length, 4);

  // Every included point carries the corpus value, dataset version and source
  // reference for both axes; points follow the resolved catalog order.
  assert.deepEqual(
    result.points.map(({ runId }) => runId),
    result.resolvedRunIds.filter((runId) => !result.omitted.some((omitted) => omitted.runId === runId)),
  );
  for (const point of result.points) {
    assert.equal(point.x, recordedValue(point.runId, "diameter"));
    assert.equal(point.y, recordedValue(point.runId, "burn_time"));
    assert.equal(point.group, null);
  }
  assertSourcesMatchPoints(dataset, result, "diameter");
});

test("filtered scopes keep search semantics, catalog order and omission accounting", () => {
  const search = { filters: [{ key: "fuel", value: "Heptane" }] };
  const spec = scatterSpec("diameter", "burn_time", { kind: "filtered-results", search });
  const result = buildPlotResult(dataset, spec);

  assert.doesNotThrow(() => plotResultSchema.parse(result));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, result), []);
  const expectedRunIds = dataset.runs
    .filter((fixture) => fixture.fields.some(({ key, value }) => key === "fuel" && value === "Heptane"))
    .map(({ id }) => id);
  assert.equal(expectedRunIds.length, 11);
  assert.deepEqual(result.resolvedRunIds, expectedRunIds);
  assert.deepEqual(result.scope, {
    kind: "filtered-results",
    search,
    activeFilters: [{ key: "fuel", value: "Heptane" }],
  });
  assert.equal(result.includedCount, 8);
  assert.equal(result.omittedCount, 3);
  assert.deepEqual(result.omitted.map(({ runId }) => runId), ["FLEX-009", "FLEX-012", "FLEX-024"]);
  assert.deepEqual(
    result.points.map(({ runId }) => runId),
    ["FLEX-007", "FLEX-008", "FLEX-018", "FLEX-019", "FLEX-023", "FLEX-027", "FLEX-028", "FLEX-031"],
  );
  for (const point of result.points) {
    assert.equal(point.x, recordedValue(point.runId, "diameter"));
    assert.equal(point.y, recordedValue(point.runId, "burn_time"));
  }
});

test("zero is a plotted value, not an omission, and explicit scope keeps caller order", () => {
  const spec = scatterSpec("carbon_dioxide", "helium", {
    kind: "explicit-runs",
    runIds: ["FLEX-010", "FLEX-001"],
  });
  const result = buildPlotResult(dataset, spec);

  assert.doesNotThrow(() => plotResultSchema.parse(result));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, result), []);
  assert.deepEqual(result.resolvedRunIds, ["FLEX-010", "FLEX-001"]);
  assert.deepEqual(result.scope, { kind: "explicit-runs", search: null, activeFilters: [] });
  assert.equal(result.includedCount, 2);
  assert.equal(result.omittedCount, 0);
  assert.deepEqual(result.points, [
    {
      runId: "FLEX-010",
      x: 0.7,
      y: 0,
      group: null,
      sourceReferences: [reference("FLEX-010", "carbon_dioxide"), reference("FLEX-010", "helium")],
    },
    {
      runId: "FLEX-001",
      x: 0,
      y: 0,
      group: null,
      sourceReferences: [reference("FLEX-001", "carbon_dioxide"), reference("FLEX-001", "helium")],
    },
  ]);
  assertSourcesMatchPoints(dataset, result, "carbon_dioxide");
});

test("point comparison uses run identity on x, one measurement on y and fuel grouping", () => {
  const spec = pointComparisonSpec("burning_rate", {
    kind: "explicit-runs",
    runIds: ["FLEX-007", "FLEX-009", "FLEX-001"],
  }, "fuel");
  const result = buildPlotResult(dataset, spec);

  assert.doesNotThrow(() => plotResultSchema.parse(result));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, result), []);
  assert.equal(result.kind, "point-comparison");
  assert.deepEqual(result.axes, { kind: "point-comparison", y: "burning_rate" });
  assert.equal(result.grouping, "fuel");
  assert.deepEqual(result.resolvedRunIds, ["FLEX-007", "FLEX-009", "FLEX-001"]);
  assert.equal(result.includedCount, 2);
  assert.equal(result.omittedCount, 1);
  assert.deepEqual(result.points, [
    {
      runId: "FLEX-007",
      x: null,
      y: 0.67,
      group: "Heptane",
      sourceReferences: [reference("FLEX-007", "burning_rate")],
    },
    {
      runId: "FLEX-001",
      x: null,
      y: 0.52,
      group: "Methanol",
      sourceReferences: [reference("FLEX-001", "burning_rate")],
    },
  ]);
  assert.deepEqual(result.omitted, [{ runId: "FLEX-009", reasons: ["missing-y"] }]);
  assertSourcesMatchPoints(dataset, result);

  const allRuns = buildPlotResult(dataset, pointComparisonSpec("burning_rate", { kind: "all-reviewed-runs" }));
  assert.doesNotThrow(() => plotResultSchema.parse(allRuns));
  assert.equal(allRuns.includedCount, 25);
  assert.equal(allRuns.omittedCount, 6);
  assert.deepEqual(allRuns.omitted, [
    { runId: "FLEX-009", reasons: ["missing-y"] },
    { runId: "FLEX-012", reasons: ["missing-y"] },
    { runId: "FLEX-014", reasons: ["missing-y"] },
    { runId: "FLEX-015", reasons: ["missing-y"] },
    { runId: "FLEX-017", reasons: ["missing-y"] },
    { runId: "FLEX-024", reasons: ["missing-y"] },
  ]);
  assert.ok(allRuns.points.every((point) => point.group === null && point.x === null));
  assert.equal(allRuns.points[0].sourceReferences.length, 1);
});

test("unknown explicit run IDs and malformed specs fail with actionable typed errors", () => {
  const unknown = plotFailure(scatterSpec("diameter", "burn_time", {
    kind: "explicit-runs",
    runIds: ["FLEX-001", "FLEX-999"],
  }));
  assert.equal(unknown.code, "unknown-runs");
  assert.deepEqual(unknown.details.runIds, ["FLEX-999"]);
  assert.match(unknown.message, /FLEX-999/);
  assert.ok(unknown.details.issues.some(({ code }) => code === "unknown-run"));

  const categoricalAxis = plotFailure(scatterSpec("fuel", "burn_time", { kind: "all-reviewed-runs" }));
  assert.equal(categoricalAxis.code, "invalid-spec");
  assert.ok(categoricalAxis.details.specIssues.length > 0);

  const duplicateAxes = plotFailure(scatterSpec("oxygen", "oxygen", { kind: "all-reviewed-runs" }));
  assert.equal(duplicateAxes.code, "invalid-spec");

  const invalidDataset = plotFailure(scatterSpec("diameter", "burn_time", { kind: "all-reviewed-runs" }), { version: "x" });
  assert.equal(invalidDataset.code, "invalid-dataset");
});

test("missing axis values, absent axis fields and non-native units are reported, never plotted", () => {
  const mixed = buildPlotResult(dataset, scatterSpec("burn_time", "diameter", {
    kind: "explicit-runs",
    runIds: ["FLEX-012", "FLEX-001"],
  }));
  assert.deepEqual(mixed.omitted, [{ runId: "FLEX-012", reasons: ["missing-x"] }]);
  assert.equal(mixed.points[0].runId, "FLEX-001");

  const withoutHelium = structuredClone(dataset);
  for (const fixture of withoutHelium.runs) {
    fixture.fields = fixture.fields.filter(({ key }) => key !== "helium");
  }
  const unavailable = plotFailure(scatterSpec("helium", "diameter", { kind: "all-reviewed-runs" }), withoutHelium);
  assert.equal(unavailable.code, "axis-unavailable");
  assert.deepEqual(unavailable.details.fieldKeys, ["helium"]);
  assert.match(unavailable.message, /Available numeric axis fields/);

  const wrongUnit = structuredClone(dataset);
  for (const fixture of wrongUnit.runs) {
    const burnTime = fixture.fields.find(({ key }) => key === "burn_time");
    if (burnTime) burnTime.unit = "min";
  }
  const unitFailure = plotFailure(scatterSpec("diameter", "burn_time", {
    kind: "explicit-runs",
    runIds: ["FLEX-001"],
  }), wrongUnit);
  assert.equal(unitFailure.code, "axis-unit-mismatch");
  assert.deepEqual(unitFailure.details.units, [
    { runId: "FLEX-001", fieldKey: "burn_time", recordedUnit: "min", nativeUnit: "s" },
  ]);
  assert.match(unitFailure.message, /native unit/);
});

test("non-numeric or absent axis readings are omitted with frozen incompatibility reasons", () => {
  const mutated = structuredClone(dataset);
  const mutate = (runId, fieldKey, value) => {
    const field = mutated.runs.find(({ id }) => id === runId).fields.find(({ key }) => key === fieldKey);
    field.value = value;
  };
  mutate("FLEX-002", "diameter", "unknown");
  mutate("FLEX-004", "diameter", Number.NaN);
  mutate("FLEX-005", "diameter", "not recorded");
  mutate("FLEX-005", "burn_time", null);
  const withoutBurnTime = mutated.runs.find(({ id }) => id === "FLEX-003");
  withoutBurnTime.fields = withoutBurnTime.fields.filter(({ key }) => key !== "burn_time");

  const result = buildPlotResult(mutated, scatterSpec("diameter", "burn_time", {
    kind: "explicit-runs",
    runIds: ["FLEX-001", "FLEX-002", "FLEX-003", "FLEX-004", "FLEX-005"],
  }));
  assert.doesNotThrow(() => plotResultSchema.parse(result));
  assert.equal(result.includedCount, 1);
  assert.equal(result.omittedCount, 4);
  assert.deepEqual(result.omitted, [
    { runId: "FLEX-002", reasons: ["non-numeric-x"] },
    { runId: "FLEX-003", reasons: ["missing-y"] },
    { runId: "FLEX-004", reasons: ["non-numeric-x"] },
    { runId: "FLEX-005", reasons: ["non-numeric-x", "missing-y"] },
  ]);
  assert.deepEqual(result.points.map(({ runId }) => runId), ["FLEX-001"]);
});

test("fuel grouping without a recorded fuel value fails instead of inventing a group", () => {
  const withoutFuel = structuredClone(dataset);
  for (const fixture of withoutFuel.runs) {
    fixture.fields = fixture.fields.filter(({ key }) => key !== "fuel");
  }
  const failure = plotFailure(pointComparisonSpec("burning_rate", {
    kind: "explicit-runs",
    runIds: ["FLEX-001"],
  }, "fuel"), withoutFuel);
  assert.equal(failure.code, "grouping-unavailable");
  assert.deepEqual(failure.details.runIds, ["FLEX-001"]);
  assert.match(failure.message, /grouping "none"/);

  // The same scope plots fine without grouping, so the failure is grouping-specific.
  const ungrouped = buildPlotResult(withoutFuel, pointComparisonSpec("burning_rate", {
    kind: "explicit-runs",
    runIds: ["FLEX-001"],
  }));
  assert.equal(ungrouped.includedCount, 1);
  assert.equal(ungrouped.points[0].group, null);
});

test("a valid empty scope returns a schema-valid zero-row result while bounds still fail", () => {
  const search = { filters: [{ key: "fuel", value: "Kerosene" }] };
  const emptySpec = scatterSpec("diameter", "burn_time", { kind: "filtered-results", search });
  const empty = buildPlotResult(dataset, emptySpec);

  assert.doesNotThrow(() => plotResultSchema.parse(empty));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, empty), []);
  assert.equal(empty.version, "plot-result-1");
  assert.equal(empty.specVersion, "plot-spec-1");
  assert.equal(empty.datasetVersion, datasetVersion);
  assert.equal(empty.kind, "scatter");
  assert.deepEqual(empty.axes, { kind: "scatter", x: "diameter", y: "burn_time" });
  assert.equal(empty.grouping, "none");
  assert.deepEqual(empty.scope, {
    kind: "filtered-results",
    search,
    activeFilters: [{ key: "fuel", value: "Kerosene" }],
  });
  assert.deepEqual(empty.resolvedRunIds, []);
  assert.deepEqual(empty.points, []);
  assert.deepEqual(empty.omitted, []);
  assert.equal(empty.includedCount, 0);
  assert.equal(empty.omittedCount, 0);
  assert.deepEqual(empty.limitations, plotLimitationsForSpec(emptySpec));
  assert.equal(empty.limitations.length, 4);

  // Zero matching runs is distinct from a nonempty scope whose runs all lack
  // measurements: the latter keeps resolved IDs and counts its omissions.
  const allOmitted = buildPlotResult(dataset, scatterSpec("diameter", "burn_time", {
    kind: "explicit-runs",
    runIds: ["FLEX-009", "FLEX-012", "FLEX-024"],
  }));
  assert.doesNotThrow(() => plotResultSchema.parse(allOmitted));
  assert.deepEqual(allOmitted.resolvedRunIds, ["FLEX-009", "FLEX-012", "FLEX-024"]);
  assert.equal(allOmitted.includedCount, 0);
  assert.equal(allOmitted.omittedCount, 3);
  assert.deepEqual(allOmitted.points, []);
  assert.equal(allOmitted.omitted.length, 3);

  // The active-filter bound still applies even when no run matches the filters.
  const tooManyFilters = Array.from({ length: 17 }, () => ({ key: "fuel", value: "Kerosene" }));
  const filterLimited = plotFailure(scatterSpec("diameter", "burn_time", {
    kind: "filtered-results",
    search: { filters: tooManyFilters },
  }));
  assert.equal(filterLimited.code, "scope-limit");
  assert.equal(filterLimited.details.filterCount, 17);
  assert.equal(filterLimited.details.filterLimit, 16);

  // The frozen result bounds rows at 128; all-reviewed scope on a larger corpus
  // must fail explicitly rather than drop rows.
  const largeDataset = structuredClone(dataset);
  largeDataset.runs = Array.from({ length: 129 }, (_, index) => ({
    ...structuredClone(dataset.runs[0]),
    id: `FLEX-${String(100 + index).padStart(3, "0")}`,
  }));
  const rowLimited = plotFailure(scatterSpec("diameter", "burn_time", { kind: "all-reviewed-runs" }), largeDataset);
  assert.equal(rowLimited.code, "scope-limit");
  assert.equal(rowLimited.details.rowCount, 129);
  assert.equal(rowLimited.details.rowLimit, 128);
});

test("the engine is pure, deterministic and returns an isolated JSON-safe result", () => {
  const spec = scatterSpec("diameter", "extinction_diameter", { kind: "all-reviewed-runs" });
  const specSnapshot = JSON.stringify(spec);
  const datasetSnapshot = JSON.stringify(dataset);

  const first = buildPlotResult(dataset, spec);
  const second = buildPlotResult(dataset, spec);

  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(JSON.stringify(spec), specSnapshot);
  assert.equal(JSON.stringify(dataset), datasetSnapshot);
  assert.doesNotThrow(() => structuredClone(first));
  assert.equal(first.limitations.length, 5, "extinction_diameter keeps the frozen extra limitation");
  assert.ok(first.limitations.some((text) => /estimated from burning history/.test(text)));
});
