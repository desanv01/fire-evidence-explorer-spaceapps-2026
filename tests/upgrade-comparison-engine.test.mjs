import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import {
  buildSelectedRunsContext,
  ComparisonEngineError,
  searchComparators,
} from "../src/lib/upgrades/comparison-engine.ts";
import {
  comparatorSearchResultSchema,
  selectedRunsContextResultSchema,
} from "../src/lib/upgrades/index.ts";

const dataset = parseDataset(JSON.parse(
  await readFile(new URL("../data/flex.json", import.meta.url), "utf8"),
));
const sourceId = "psi-69-flex-table-v1";

const selectedRequest = (runIds, focusCondition) => ({
  version: "comparison-context-request-1",
  kind: "selected-runs",
  runIds,
  ...(focusCondition === undefined ? {} : { focusCondition }),
});

const comparatorRequest = (overrides = {}) => ({
  version: "comparison-context-request-1",
  kind: "comparator",
  referenceRunId: "FLEX-001",
  focusCondition: "diameter",
  candidateScope: { kind: "explicit-runs", runIds: ["FLEX-002", "FLEX-005"] },
  ...overrides,
});

function field(result, key) {
  return [...result.conditions, ...result.outcomes].find((entry) => entry.key === key);
}

function reference(runId, fieldKey) {
  return { datasetVersion: dataset.version, runId, fieldKey, sourceId };
}

test("selected-run context keeps order, native units and the FLEX-001 → FLEX-004 delta", () => {
  const request = selectedRequest(["FLEX-001", "FLEX-004"], "pressure");
  const result = buildSelectedRunsContext(dataset, request);
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(result));

  assert.equal(result.kind, "selected-runs-context");
  assert.equal(result.datasetVersion, dataset.version);
  assert.equal(result.comparisonRuleVersion, "1");
  assert.equal(result.contextRuleVersion, "comparison-context-1");
  assert.deepEqual(result.runIds, ["FLEX-001", "FLEX-004"]);
  assert.deepEqual(result.request, request);

  assert.deepEqual(result.conditions.map(({ key }) => key), [
    "fuel", "pressure", "oxygen", "nitrogen", "carbon_dioxide", "helium", "diameter",
  ]);
  assert.deepEqual(result.outcomes.map(({ key }) => key), [
    "extinction_diameter", "burning_rate", "burn_time", "test_end",
  ]);

  const burnTime = field(result, "burn_time");
  assert.equal(burnTime.kind, "outcome");
  assert.equal(burnTime.status, "different");
  assert.equal(burnTime.unit, "s");
  assert.deepEqual(burnTime.cells, [
    {
      runId: "FLEX-001",
      value: 4.3,
      original: "4.3",
      reference: reference("FLEX-001", "burn_time"),
    },
    {
      runId: "FLEX-004",
      value: 7.64,
      original: "7.64",
      reference: reference("FLEX-004", "burn_time"),
    },
  ]);
  assert.deepEqual(burnTime.deltas, [{
    fromRunId: "FLEX-001",
    toRunId: "FLEX-004",
    delta: 3.34,
    unit: "s",
    provenanceClass: "deterministic-derived",
    ruleVersion: "native-delta-1",
  }]);

  const pressure = field(result, "pressure");
  assert.equal(pressure.status, "different");
  assert.equal(pressure.unit, "mmHg");
  assert.equal(pressure.cells[0].value, 757.7);
  assert.equal(pressure.cells[1].value, 760);
  assert.equal(Math.abs(pressure.deltas[0].delta - 2.3) < 1e-9, true);

  assert.equal(field(result, "fuel").unit, null);
  assert.equal(field(result, "fuel").status, "same");
  assert.equal(field(result, "test_end").status, "different");
  assert.equal(field(result, "test_end").unit, null);
  assert.deepEqual(field(result, "test_end").deltas, []);

  // FLEX-004 has no recorded visible-extinction diameter. It stays unknown and
  // keeps its stable source reference; unknown is not a match and gets no delta.
  const extinction = field(result, "extinction_diameter");
  assert.equal(extinction.status, "unknown");
  assert.equal(extinction.cells[0].value, 0.89);
  assert.equal(extinction.cells[1].value, null);
  assert.equal(extinction.cells[1].original, null);
  assert.deepEqual(extinction.cells[1].reference, reference("FLEX-004", "extinction_diameter"));
  assert.deepEqual(extinction.deltas, []);
  assert.match(extinction.reason, /FLEX-004/);
  assert.match(extinction.reason, /never counts as a match/);

  const gas = result.gasComposition;
  assert.deepEqual(gas.fieldKeys, ["oxygen", "nitrogen", "carbon_dioxide", "helium"]);
  assert.equal(gas.complete, true);
  assert.deepEqual(gas.values.map(({ runId }) => runId), ["FLEX-001", "FLEX-004"]);
  for (const { values } of gas.values) {
    assert.equal(values.oxygen, 0.21);
    assert.equal(values.nitrogen, 0.79);
    assert.equal(values.carbon_dioxide, 0);
    assert.equal(values.helium, 0);
  }
  assert.equal(gas.differences.length, 1);
  assert.deepEqual(gas.differences[0].values.map(({ key }) => key),
    ["oxygen", "nitrogen", "carbon_dioxide", "helium"]);
  assert.deepEqual(gas.differences[0].values.map(({ delta }) => delta), [0, 0, 0, 0]);
  assert.equal(gas.limitation, "Gas fractions are linked. Inspect the complete recorded composition; a difference in oxygen alone does not establish an isolated oxygen effect.");

  assert.deepEqual(result.evidence.map(({ category }) => category), [
    "recorded-observation", "computed-comparison", "computed-comparison", "not-established",
  ]);
  for (const entry of result.evidence) {
    if (entry.category === "computed-comparison") assert.equal(typeof entry.ruleVersion, "string");
    else assert.equal(entry.ruleVersion, undefined);
  }
  assert.match(result.limitations.join(" "), /unknown value never counts as a match/);
  assert.match(result.limitations.join(" "), /no isolated oxygen effect is established/);
  assert.match(result.limitations.join(" "), /visible-extinction/);
});

test("three-run context keeps pairwise delta direction and complete gas differences", () => {
  const result = buildSelectedRunsContext(
    dataset,
    selectedRequest(["FLEX-001", "FLEX-002", "FLEX-005"]),
  );
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(result));
  assert.deepEqual(result.runIds, ["FLEX-001", "FLEX-002", "FLEX-005"]);

  const burnTime = field(result, "burn_time");
  assert.deepEqual(burnTime.cells.map(({ runId }) => runId), ["FLEX-001", "FLEX-002", "FLEX-005"]);
  assert.deepEqual(burnTime.deltas.map(({ fromRunId, toRunId }) => [fromRunId, toRunId]), [
    ["FLEX-001", "FLEX-002"],
    ["FLEX-001", "FLEX-005"],
    ["FLEX-002", "FLEX-005"],
  ]);
  assert.equal(burnTime.deltas[0].delta, 0.7000000000000002);
  assert.equal(burnTime.deltas[1].delta, 2.04);
  assert.equal(burnTime.deltas[2].delta, 1.3399999999999999);

  assert.equal(result.gasComposition.complete, true);
  assert.equal(result.gasComposition.differences.length, 3);
  for (const difference of result.gasComposition.differences) {
    assert.equal(difference.values.length, 4);
    assert.deepEqual(difference.values.map(({ delta }) => delta), [0, 0, 0, 0]);
  }

  // Request order is authoritative, including delta direction.
  const reversed = buildSelectedRunsContext(dataset, selectedRequest(["FLEX-004", "FLEX-001"]));
  assert.deepEqual(reversed.runIds, ["FLEX-004", "FLEX-001"]);
  assert.deepEqual(field(reversed, "burn_time").deltas, [{
    fromRunId: "FLEX-004",
    toRunId: "FLEX-001",
    delta: -3.34,
    unit: "s",
    provenanceClass: "deterministic-derived",
    ruleVersion: "native-delta-1",
  }]);
});

test("comparator focus is excluded and tolerance matching is inclusive at the boundary", () => {
  const exactRequest = comparatorRequest();
  const exact = searchComparators(dataset, exactRequest);
  assert.doesNotThrow(() => comparatorSearchResultSchema.parse(exact));
  assert.equal(exact.kind, "comparator-search");
  assert.deepEqual(exact.matching, { mode: "exact" });
  assert.deepEqual(exact.request, exactRequest);
  assert.deepEqual(exact.candidateScope, exactRequest.candidateScope);
  assert.deepEqual(exact.resolvedCandidateRunIds, ["FLEX-002", "FLEX-005"]);
  assert.equal(exact.evaluatedCount, 2);
  assert.equal(exact.outcome.kind, "no-eligible-match");
  assert.deepEqual(exact.outcome.nearestCandidates.map(({ runId }) => runId), ["FLEX-005", "FLEX-002"]);
  for (const candidate of exact.outcome.nearestCandidates) {
    assert.equal(candidate.disposition, "nearest");
    assert.deepEqual(candidate.context.runIds, ["FLEX-001", candidate.runId]);
    assert.deepEqual(candidate.mismatchedFieldKeys, ["pressure"]);
    assert.deepEqual(candidate.unknownFieldKeys, []);
    assert.deepEqual(candidate.incompatibleFieldKeys, []);
    assert.match(candidate.limitations[0], /Not an eligible match/);
  }

  // 760 - 757.7 = 2.2999999999999545; the inclusive 2.3 mmHg rule matches it.
  const boundary = searchComparators(dataset, comparatorRequest({
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 2.3 }] },
  }));
  assert.doesNotThrow(() => comparatorSearchResultSchema.parse(boundary));
  assert.deepEqual(boundary.matching, {
    mode: "tolerance",
    tolerances: [{ field: "pressure", tolerance: 2.3 }],
  });
  assert.equal(boundary.outcome.kind, "eligible-match");
  assert.deepEqual(boundary.outcome.candidates.map(({ runId }) => runId), ["FLEX-005"]);
  assert.equal(boundary.outcome.candidates[0].disposition, "eligible");
  assert.deepEqual(boundary.outcome.candidates[0].mismatchedFieldKeys, []);
  // A tolerance is a search rule, not an equivalence result: the recorded
  // pressure values still differ in the candidate context.
  assert.equal(field(boundary.outcome.candidates[0].context, "pressure").status, "different");

  const justBelow = searchComparators(dataset, comparatorRequest({
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 2.29 }] },
  }));
  assert.equal(justBelow.outcome.kind, "no-eligible-match");

  const wider = searchComparators(dataset, comparatorRequest({
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 4.3 }] },
  }));
  assert.equal(wider.outcome.kind, "eligible-match");
  assert.deepEqual(wider.outcome.candidates.map(({ runId }) => runId), ["FLEX-002", "FLEX-005"]);

  // A tolerance declared on the excluded focus field is disclosed, not applied
  // as a hidden required rule: exact diameter still blocks FLEX-002.
  const focusTolerance = searchComparators(dataset, comparatorRequest({
    focusCondition: "pressure",
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-002"] },
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 5 }] },
  }));
  assert.equal(focusTolerance.outcome.kind, "no-eligible-match");
  assert.match(focusTolerance.limitations.join(" "), /focus condition is excluded/);
});

test("missing values never match and an empty scope is not a failure", () => {
  // FLEX-009 records a null initial droplet diameter. With pressure as the
  // focus, diameter is a required condition, so FLEX-001 cannot be eligible.
  const missing = searchComparators(dataset, {
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-009",
    focusCondition: "pressure",
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-001"] },
  });
  assert.doesNotThrow(() => comparatorSearchResultSchema.parse(missing));
  assert.equal(missing.outcome.kind, "no-eligible-match");
  assert.equal(missing.outcome.nearestCandidates.length, 1);
  const nearest = missing.outcome.nearestCandidates[0];
  assert.deepEqual(nearest.mismatchedFieldKeys, ["fuel"]);
  assert.deepEqual(nearest.unknownFieldKeys, ["diameter"]);
  assert.match(nearest.limitations.join(" "), /unknown value never counts as a match/);
  assert.equal(field(nearest.context, "diameter").status, "unknown");

  // A scope containing only the reference resolves to zero candidates; it is a
  // valid empty result, not an engine failure.
  const empty = searchComparators(dataset, {
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-001",
    focusCondition: "diameter",
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-001"] },
  });
  assert.doesNotThrow(() => comparatorSearchResultSchema.parse(empty));
  assert.equal(empty.outcome.kind, "no-eligible-match");
  assert.deepEqual(empty.outcome.nearestCandidates, []);
  assert.deepEqual(empty.resolvedCandidateRunIds, []);
  assert.equal(empty.evaluatedCount, 0);
  assert.match(empty.limitations.join(" "), /Empty candidate scope/);

  // Filtered scope follows existing search semantics, excludes the reference
  // and reports the applied filters.
  const filtered = searchComparators(dataset, {
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-001",
    focusCondition: "diameter",
    candidateScope: {
      kind: "filtered-results",
      search: { filters: [{ key: "fuel", value: "Methanol" }] },
    },
  });
  assert.doesNotThrow(() => comparatorSearchResultSchema.parse(filtered));
  assert.deepEqual(filtered.activeFilters, [{ key: "fuel", value: "Methanol" }]);
  assert.equal(filtered.resolvedCandidateRunIds.includes("FLEX-001"), false);
  assert.equal(filtered.evaluatedCount, filtered.resolvedCandidateRunIds.length);
  assert.equal(filtered.outcome.kind, "no-eligible-match");
  assert.equal(filtered.outcome.nearestCandidates.length, 5);

  // Typed failures are distinct from valid empty/no-eligible outcomes.
  assert.throws(
    () => searchComparators(dataset, {
      version: "comparison-context-request-1",
      kind: "comparator",
      referenceRunId: "FLEX-999",
      focusCondition: "pressure",
      candidateScope: { kind: "all-reviewed-runs" },
    }),
    (error) => error instanceof ComparisonEngineError && error.code === "invalid-corpus",
  );
  assert.throws(
    () => searchComparators(dataset, {
      version: "comparison-context-request-1",
      kind: "comparator",
      referenceRunId: "FLEX-001",
      focusCondition: "pressure",
      candidateScope: { kind: "explicit-runs", runIds: ["FLEX-999"] },
    }),
    (error) => error instanceof ComparisonEngineError && error.code === "invalid-corpus",
  );
  assert.throws(
    () => buildSelectedRunsContext(dataset, selectedRequest(["FLEX-001", "FLEX-001"])),
    (error) => error instanceof ComparisonEngineError && error.code === "invalid-request",
  );
});

test("incomplete gas composition is marked and zeros are preserved", () => {
  const incomplete = structuredClone(dataset);
  const helium = incomplete.runs
    .find(({ id }) => id === "FLEX-004")
    .fields.find(({ key }) => key === "helium");
  helium.value = null;
  helium.original = null;

  const result = buildSelectedRunsContext(incomplete, selectedRequest(["FLEX-001", "FLEX-004"]));
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(result));
  assert.equal(result.gasComposition.complete, false);
  assert.equal(result.gasComposition.values[0].values.carbon_dioxide, 0);
  assert.equal(result.gasComposition.values[0].values.helium, 0);
  assert.equal(result.gasComposition.values[1].values.helium, null);
  // A four-value difference row cannot be emitted for an incomplete pair.
  assert.deepEqual(result.gasComposition.differences, []);
  assert.match(result.evidence[2].text, /unknown/);
  assert.match(result.limitations.join(" "), /complete composition cannot be reconstructed/);
  assert.equal(field(result, "helium").status, "unknown");
  assert.equal(field(result, "helium").cells[0].value, 0);
});
