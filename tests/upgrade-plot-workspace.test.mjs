import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { buildPlotResult } from "../src/lib/upgrades/plot-engine.ts";
import { resolveStableFieldReference } from "../src/lib/upgrades/provenance.ts";
import {
  PlotWorkspaceError,
  buildPlotExportPayload,
  canLaunchPlotComparison,
  clearPlotRunSelection,
  createPlotRunSelection,
  isPlotWorkspaceError,
  plotExportContractVersions,
  plotExportPayloadSchema,
  plotRunSelectionMode,
  plotRunSelectionSchema,
  plotRunSelectionScope,
  replacePlotRunSelection,
  togglePlotRunSelection,
} from "../src/lib/upgrades/plot-workspace.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;

function scatterSpec(xField, yField, scope) {
  return {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: xField }, y: { field: yField } },
    grouping: "none",
    scope,
  };
}

function realPlot() {
  const spec = scatterSpec("diameter", "burn_time", { kind: "all-reviewed-runs" });
  return { spec, result: buildPlotResult(dataset, spec) };
}

function selectionFailure(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PlotWorkspaceError, `Expected PlotWorkspaceError, received: ${error}`);
    return error;
  }
  assert.fail("Expected the selection helper to fail");
}

function exportFailure(spec, result, datasetArg = dataset) {
  try {
    buildPlotExportPayload(datasetArg, spec, result);
  } catch (error) {
    assert.ok(error instanceof PlotWorkspaceError, `Expected PlotWorkspaceError, received: ${error}`);
    return error;
  }
  assert.fail("Expected buildPlotExportPayload to fail");
}

test("ordered selection supports empty, inspection and comparison modes without mutation", () => {
  const empty = createPlotRunSelection(dataset);
  assert.deepEqual(empty, { datasetVersion, runIds: [], revision: 0 });
  assert.doesNotThrow(() => plotRunSelectionSchema.parse(empty));
  assert.equal(plotRunSelectionMode(empty), "empty");
  assert.equal(canLaunchPlotComparison(empty), false);
  assert.equal(plotRunSelectionScope(empty), null);

  const one = togglePlotRunSelection(empty, dataset, "FLEX-003");
  assert.equal(one.status, "added");
  assert.deepEqual(one.selection, { datasetVersion, runIds: ["FLEX-003"], revision: 1 });
  assert.equal(plotRunSelectionMode(one.selection), "inspection");
  assert.equal(canLaunchPlotComparison(one.selection), false);
  assert.deepEqual(plotRunSelectionScope(one.selection), {
    kind: "explicit-runs",
    runIds: ["FLEX-003"],
  });

  const two = togglePlotRunSelection(one.selection, dataset, "FLEX-001");
  assert.equal(two.status, "added");
  assert.deepEqual(two.selection.runIds, ["FLEX-003", "FLEX-001"]);
  assert.equal(two.selection.revision, 2);
  assert.equal(plotRunSelectionMode(two.selection), "comparison");
  assert.equal(canLaunchPlotComparison(two.selection), true);
  assert.deepEqual(plotRunSelectionScope(two.selection), {
    kind: "explicit-runs",
    runIds: ["FLEX-003", "FLEX-001"],
  });

  const removed = togglePlotRunSelection(two.selection, dataset, "FLEX-003");
  assert.equal(removed.status, "removed");
  assert.deepEqual(removed.selection.runIds, ["FLEX-001"]);
  assert.equal(removed.selection.revision, 3);
  assert.equal(plotRunSelectionMode(removed.selection), "inspection");

  const cleared = clearPlotRunSelection(two.selection);
  assert.deepEqual(cleared.runIds, []);
  assert.equal(cleared.revision, 3);
  assert.equal(plotRunSelectionMode(cleared), "empty");
  assert.equal(clearPlotRunSelection(cleared), cleared, "clearing an empty selection is a no-op");

  // The input array and prior states are not mutated by any helper.
  const input = ["FLEX-001", "FLEX-003"];
  const inputSnapshot = [...input];
  const state = createPlotRunSelection(dataset, input);
  const appended = togglePlotRunSelection(state, dataset, "FLEX-007");
  assert.equal(appended.status, "added");
  assert.deepEqual(appended.selection.runIds, ["FLEX-001", "FLEX-003", "FLEX-007"]);
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(state.runIds, ["FLEX-001", "FLEX-003"]);
  assert.equal(state.revision, 0);
});

test("a fourth run returns an explicit replace-or-cancel choice and replacement retains the slot", () => {
  const three = createPlotRunSelection(dataset, ["FLEX-001", "FLEX-003", "FLEX-007"]);
  assert.equal(plotRunSelectionMode(three), "comparison");
  assert.equal(canLaunchPlotComparison(three), true);

  const refusal = togglePlotRunSelection(three, dataset, "FLEX-009");
  assert.equal(refusal.status, "replacement-required");
  assert.deepEqual(refusal.selection, three, "refusal leaves the selection unchanged");
  assert.deepEqual(refusal.choice, {
    datasetVersion,
    incomingRunId: "FLEX-009",
    selectionRunIds: ["FLEX-001", "FLEX-003", "FLEX-007"],
    selectionRevision: 0,
  });

  // Cancel is simply not calling replace: the selection stays at three runs.
  assert.equal(refusal.selection.runIds.length, 3);
  assert.equal(refusal.selection.revision, 0);

  const replaced = replacePlotRunSelection(three, dataset, refusal.choice, "FLEX-001");
  assert.deepEqual(replaced, {
    datasetVersion,
    runIds: ["FLEX-009", "FLEX-003", "FLEX-007"],
    revision: 1,
  }, "the incoming run takes the replaced run's slot and order");
  assert.deepEqual(three.runIds, ["FLEX-001", "FLEX-003", "FLEX-007"]);
  assert.equal(three.revision, 0);

  const middle = replacePlotRunSelection(three, dataset,
    { ...refusal.choice, incomingRunId: "FLEX-010" }, "FLEX-003");
  assert.deepEqual(middle.runIds, ["FLEX-001", "FLEX-010", "FLEX-007"]);
});

test("stale replacement choices, canonical IDs and corpus checks fail safely", () => {
  const base = createPlotRunSelection(dataset, ["FLEX-001", "FLEX-003", "FLEX-007"]);
  const refusal = togglePlotRunSelection(base, dataset, "FLEX-009");
  assert.equal(refusal.status, "replacement-required");

  const changed = togglePlotRunSelection(base, dataset, "FLEX-003");
  assert.equal(changed.status, "removed");
  const stale = selectionFailure(() => replacePlotRunSelection(
    changed.selection,
    dataset,
    refusal.choice,
    "FLEX-001",
  ));
  assert.equal(stale.code, "stale-selection");
  assert.equal(stale.details.choiceRevision, 0);
  assert.equal(stale.details.selectionRevision, 1);

  const freshChoice = togglePlotRunSelection(base, dataset, "FLEX-009").choice;
  const missingSlot = selectionFailure(() => replacePlotRunSelection(
    base,
    dataset,
    freshChoice,
    "FLEX-009",
  ));
  assert.equal(missingSlot.code, "run-not-selected");

  const duplicateIncoming = selectionFailure(() => replacePlotRunSelection(
    base,
    dataset,
    { ...freshChoice, incomingRunId: "FLEX-001" },
    "FLEX-003",
  ));
  assert.equal(duplicateIncoming.code, "duplicate-run");

  assert.equal(selectionFailure(() => createPlotRunSelection(dataset, ["FLEX-001", "FLEX-001"])).code, "duplicate-run");
  assert.equal(selectionFailure(() =>
    createPlotRunSelection(dataset, ["FLEX-001", "FLEX-002", "FLEX-003", "FLEX-004"])).code, "selection-limit");
  assert.equal(selectionFailure(() => createPlotRunSelection(dataset, ["FLEX-1"])).code, "invalid-run-id");
  assert.equal(selectionFailure(() => createPlotRunSelection(dataset, ["FLEX-999"])).code, "unknown-run");
  assert.equal(selectionFailure(() => createPlotRunSelection(null)).code, "invalid-dataset");

  const staleDataset = structuredClone(dataset);
  staleDataset.version = "flex-old-version";
  const versionFailure = selectionFailure(() => togglePlotRunSelection(base, staleDataset, "FLEX-002"));
  assert.equal(versionFailure.code, "dataset-version-mismatch");
  assert.equal(versionFailure.details.expectedDatasetVersion, datasetVersion);
  assert.equal(isPlotWorkspaceError(versionFailure), true);
  assert.equal(isPlotWorkspaceError(new Error("x")), false);
});

test("real FLEX export retains displayed rows, raw source values and omission counts", () => {
  const { spec, result } = realPlot();
  const payload = buildPlotExportPayload(dataset, spec, result);

  assert.doesNotThrow(() => plotExportPayloadSchema.parse(payload));
  assert.equal(payload.version, "plot-export-1");
  assert.deepEqual(payload.contracts, plotExportContractVersions);
  assert.deepEqual(payload.dataset, { version: datasetVersion });
  assert.deepEqual(payload.spec, spec);
  assert.deepEqual(payload.axes, {
    kind: "scatter",
    x: { field: "diameter", label: "Initial droplet diameter", nativeUnit: "mm" },
    y: { field: "burn_time", label: "Burn time", nativeUnit: "s" },
  });
  assert.deepEqual(payload.scope, result.scope);
  assert.deepEqual(payload.resolvedRunIds, result.resolvedRunIds);
  assert.deepEqual(payload.counts, { resolved: 31, included: 28, omitted: 3 });
  assert.equal(payload.rows.length, 28);
  assert.equal(payload.omitted.length, 3);
  assert.deepEqual(payload.omitted, result.omitted);
  assert.deepEqual(payload.omitted.map(({ runId }) => runId), ["FLEX-009", "FLEX-012", "FLEX-024"]);
  assert.deepEqual(payload.limitations, result.limitations);
  assert.deepEqual(payload.rows.map(({ runId }) => runId), result.points.map(({ runId }) => runId));

  // Every displayed row matches the source cell and stable reference exactly.
  for (const row of payload.rows) {
    const point = result.points.find(({ runId }) => runId === row.runId);
    assert.ok(point);
    assert.equal(row.sourceReferences.length, 2);
    assert.deepEqual(row.sourceReferences.map(({ axis }) => axis), ["x", "y"]);
    assert.deepEqual(
      row.sourceReferences.map(({ reference }) => reference),
      point.sourceReferences,
      "export retains the result's stable source references",
    );
    for (const source of row.sourceReferences) {
      assert.equal(source.reference.runId, row.runId);
      assert.equal(source.reference.datasetVersion, datasetVersion);
      assert.match(source.reference.runId, /^FLEX-\d{3}$/);
      const resolution = resolveStableFieldReference(dataset, source.reference);
      assert.equal(resolution.status, "resolved");
      assert.equal(source.value, resolution.field.value);
      assert.equal(source.original, resolution.field.original);
      assert.equal(source.unit, resolution.field.unit);
      assert.equal(source.locator, resolution.field.locator);
      assert.equal(source.label, resolution.field.label);
      assert.equal(source.value, source.axis === "x" ? row.x : row.y);
    }
  }

  // The payload schema rejects a payload whose counts no longer match its rows.
  const tampered = structuredClone(payload);
  tampered.counts.included -= 1;
  assert.throws(() => plotExportPayloadSchema.parse(tampered));

  const first = payload.rows[0];
  assert.equal(first.runId, "FLEX-001");
  assert.deepEqual(first.sourceReferences.map(({ reference }) => reference.fieldKey), ["diameter", "burn_time"]);
  assert.deepEqual(first.sourceReferences.map(({ value }) => value), [1.69, 4.3]);
  assert.deepEqual(first.sourceReferences.map(({ original }) => original), ["1.69", "4.3"]);
  assert.ok(first.sourceReferences[0].locator.includes("PSI-69_Experimental table_FLEX.csv"));

  // Omissions remain distinct from plotted measurements.
  const rowIds = new Set(payload.rows.map(({ runId }) => runId));
  for (const omitted of payload.omitted) {
    assert.equal(rowIds.has(omitted.runId), false);
  }
});

test("zero values and zero-row or all-omitted results export distinctly", () => {
  const zeroSpec = scatterSpec("carbon_dioxide", "helium", {
    kind: "explicit-runs",
    runIds: ["FLEX-010", "FLEX-001"],
  });
  const zeroResult = buildPlotResult(dataset, zeroSpec);
  const zeroPayload = buildPlotExportPayload(dataset, zeroSpec, zeroResult);
  assert.doesNotThrow(() => plotExportPayloadSchema.parse(zeroPayload));
  assert.deepEqual(zeroPayload.counts, { resolved: 2, included: 2, omitted: 0 });
  const zeroRow = zeroPayload.rows.find(({ runId }) => runId === "FLEX-001");
  assert.ok(zeroRow);
  assert.equal(zeroRow.x, 0);
  assert.equal(zeroRow.y, 0);
  assert.deepEqual(zeroRow.sourceReferences.map(({ value }) => value), [0, 0]);
  assert.deepEqual(zeroRow.sourceReferences.map(({ original }) => original), ["0", "0"]);
  assert.equal(zeroPayload.rows.find(({ runId }) => runId === "FLEX-010").x, 0.7);

  // A valid filtered scope with no matching runs is a zero-row result, not an
  // omission and not an error.
  const emptySpec = scatterSpec("diameter", "burn_time", {
    kind: "filtered-results",
    search: { filters: [{ key: "fuel", value: "Kerosene" }] },
  });
  const emptyResult = buildPlotResult(dataset, emptySpec);
  const emptyPayload = buildPlotExportPayload(dataset, emptySpec, emptyResult);
  assert.doesNotThrow(() => plotExportPayloadSchema.parse(emptyPayload));
  assert.deepEqual(emptyPayload.rows, []);
  assert.deepEqual(emptyPayload.omitted, []);
  assert.deepEqual(emptyPayload.resolvedRunIds, []);
  assert.deepEqual(emptyPayload.counts, { resolved: 0, included: 0, omitted: 0 });
  assert.deepEqual(emptyPayload.scope, {
    kind: "filtered-results",
    search: { filters: [{ key: "fuel", value: "Kerosene" }] },
    activeFilters: [{ key: "fuel", value: "Kerosene" }],
  });
  assert.deepEqual(emptyPayload.spec, emptySpec);
  assert.equal(emptyPayload.limitations.length, 4);

  // A nonempty scope whose runs all lack a required measurement keeps resolved
  // run IDs and omission records; rows stay empty.
  const omittedSpec = scatterSpec("diameter", "burn_time", {
    kind: "explicit-runs",
    runIds: ["FLEX-009", "FLEX-012", "FLEX-024"],
  });
  const omittedResult = buildPlotResult(dataset, omittedSpec);
  const omittedPayload = buildPlotExportPayload(dataset, omittedSpec, omittedResult);
  assert.doesNotThrow(() => plotExportPayloadSchema.parse(omittedPayload));
  assert.deepEqual(omittedPayload.rows, []);
  assert.deepEqual(omittedPayload.resolvedRunIds, ["FLEX-009", "FLEX-012", "FLEX-024"]);
  assert.deepEqual(omittedPayload.counts, { resolved: 3, included: 0, omitted: 3 });
  assert.deepEqual(omittedPayload.omitted.map(({ runId }) => runId), ["FLEX-009", "FLEX-012", "FLEX-024"]);
  assert.deepEqual(omittedPayload.omitted[0].reasons, ["missing-x", "missing-y"]);
});

test("point-comparison export keeps x categorical and one measurement source", () => {
  const spec = {
    version: "plot-spec-1",
    kind: "point-comparison",
    axes: { y: { field: "burning_rate" } },
    grouping: "fuel",
    scope: { kind: "explicit-runs", runIds: ["FLEX-007", "FLEX-009", "FLEX-001"] },
  };
  const result = buildPlotResult(dataset, spec);
  const payload = buildPlotExportPayload(dataset, spec, result);

  assert.doesNotThrow(() => plotExportPayloadSchema.parse(payload));
  assert.deepEqual(payload.spec, spec);
  assert.deepEqual(payload.axes, {
    kind: "point-comparison",
    y: { field: "burning_rate", label: "Burning rate", nativeUnit: "mm²/s" },
  });
  assert.deepEqual(payload.counts, { resolved: 3, included: 2, omitted: 1 });
  assert.deepEqual(payload.rows.map(({ runId }) => runId), ["FLEX-007", "FLEX-001"]);
  assert.deepEqual(payload.rows.map(({ group }) => group), ["Heptane", "Methanol"]);
  assert.deepEqual(payload.omitted, [{ runId: "FLEX-009", reasons: ["missing-y"] }]);
  for (const row of payload.rows) {
    assert.equal(row.x, null);
    assert.equal(row.sourceReferences.length, 1);
    assert.equal(row.sourceReferences[0].axis, "y");
    assert.equal(row.sourceReferences[0].reference.fieldKey, "burning_rate");
    assert.equal(row.sourceReferences[0].value, row.y);
    assert.equal(row.sourceReferences[0].original, String(row.y));
  }
});

test("export rejects mismatched specs, results, dataset versions and units", () => {
  const { spec, result } = realPlot();

  const otherSpec = scatterSpec("oxygen", "burning_rate", { kind: "all-reviewed-runs" });
  const otherResult = buildPlotResult(dataset, otherSpec);
  assert.equal(exportFailure(spec, otherResult).code, "axes-mismatch");

  const filteredSpec = scatterSpec("diameter", "burn_time", {
    kind: "filtered-results",
    search: { filters: [{ key: "fuel", value: "Methanol" }] },
  });
  const filteredResult = buildPlotResult(dataset, filteredSpec);
  assert.equal(exportFailure(spec, filteredResult).code, "scope-mismatch");

  const groupedSpec = { ...spec, grouping: "fuel" };
  const groupedResult = buildPlotResult(dataset, groupedSpec);
  assert.equal(exportFailure(spec, groupedResult).code, "spec-result-mismatch");

  const staleDataset = structuredClone(dataset);
  staleDataset.version = "flex-old-version";
  assert.equal(exportFailure(spec, result, staleDataset).code, "dataset-version-mismatch");

  const badValue = structuredClone(result);
  badValue.points[0].x += 1;
  assert.equal(exportFailure(spec, badValue).code, "source-mismatch");

  const invalidResult = { ...result, includedCount: 27 };
  assert.equal(exportFailure(spec, invalidResult).code, "invalid-result");

  const wrongUnit = structuredClone(dataset);
  for (const fixture of wrongUnit.runs) {
    const burnTime = fixture.fields.find(({ key }) => key === "burn_time");
    if (burnTime) burnTime.unit = "min";
  }
  assert.equal(exportFailure(spec, result, wrongUnit).code, "unit-mismatch");

  const invalidSpec = { ...spec, axes: { x: { field: "fuel" }, y: { field: "burn_time" } } };
  assert.equal(exportFailure(invalidSpec, result).code, "invalid-spec");
});
