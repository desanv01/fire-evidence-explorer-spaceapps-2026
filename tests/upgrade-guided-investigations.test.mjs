import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { importNotebookFromText } from "../src/lib/upgrades/notebook-engine.ts";
import {
  notebookSchema,
  validateNotebookAgainstDataset,
} from "../src/lib/upgrades/notebook.ts";
import { resolveStableFieldReference } from "../src/lib/upgrades/provenance.ts";
import {
  exportGuidedInvestigation,
  getGuidedInvestigation,
  guidedInvestigationDatasetReport,
  guidedInvestigations,
  guidedInvestigationsDatasetVersion,
  guidedInvestigationsSourceId,
  listGuidedInvestigations,
  openGuidedInvestigation,
} from "../src/lib/upgrades/guided-investigations.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;
const sourceId = "psi-69-flex-table-v1";
const openedAt = "2026-11-13T09:00:00+08:00";

const guideIds = [
  "burn-time-condition-differences",
  "missing-burning-rate",
  "visible-flame-extinction",
];

function open(guideId, options = {}) {
  return openGuidedInvestigation(dataset, guideId, {
    notebookId: "guide-test-notebook",
    openedAt,
    ...options,
  });
}

function expectOk(result) {
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) assert.fail(result.message);
  return result;
}

function close(actual, expected, tolerance = 1e-9) {
  assert.equal(typeof actual, "number", `Expected a number, received ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function stepById(result, stepId) {
  const step = result.notebook.steps.find((candidate) => candidate.stepId === stepId);
  assert.ok(step, `Notebook step ${stepId} should exist`);
  return step;
}

function factById(result, stepId) {
  const fact = result.facts.find((candidate) => candidate.stepId === stepId);
  assert.ok(fact, `Step fact ${stepId} should exist`);
  return fact;
}

function comparisonFact(result, stepId) {
  const fact = factById(result, stepId);
  assert.equal(fact.stepType, "comparison");
  return fact;
}

function plotFact(result, stepId) {
  const fact = factById(result, stepId);
  assert.equal(fact.stepType, "plot");
  return fact;
}

function fieldFacts(comparison, key) {
  const field = [...comparison.conditions, ...comparison.outcomes].find((candidate) => candidate.key === key);
  assert.ok(field, `Comparison field ${key} should exist`);
  return field;
}

function values(field) {
  return field.values.map(({ value }) => value);
}

function anchor(result, runId, fieldKey) {
  return result.sourceAnchors.find(({ reference }) => (
    reference.runId === runId && reference.fieldKey === fieldKey
  ));
}

test("guide listing exposes three frozen, corpus-pinned investigations", () => {
  const listed = listGuidedInvestigations();
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map(({ guideId }) => guideId), guideIds);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(guidedInvestigations, listed);

  for (const guide of listed) {
    assert.equal(guide.version, "guided-investigation-1");
    assert.equal(guide.datasetVersion, guidedInvestigationsDatasetVersion);
    assert.equal(guide.datasetVersion, datasetVersion);
    assert.equal(guide.sourceId, guidedInvestigationsSourceId);
    assert.equal(guide.sourceId, sourceId);
    assert.ok(guide.title.trim().length > 0);
    assert.ok(guide.question.trim().length > 0);
    assert.equal(guide.limitations.length >= 3, true);
    assert.equal(guide.steps.length >= 2, true);
    assert.equal(Object.isFrozen(guide), true);
    assert.equal(Object.isFrozen(guide.steps), true);
    assert.equal(new Set(guide.steps.map(({ stepId }) => stepId)).size, guide.steps.length);
    for (const step of guide.steps) {
      assert.equal(step.stepId.length <= 64, true);
      assert.ok(step.title.trim().length > 0);
      if (step.kind === "plot") {
        assert.equal(step.plotSpec.scope.kind, "explicit-runs");
      } else {
        assert.equal(step.request.kind, "selected-runs");
        assert.equal(step.request.runIds.length >= 2, true);
      }
    }
  }

  assert.equal(getGuidedInvestigation(guideIds[1])?.guideId, guideIds[1]);
  assert.equal(getGuidedInvestigation("missing-guide"), undefined);

  const report = guidedInvestigationDatasetReport(dataset);
  assert.equal(report.compatible, true);
  assert.equal(report.message, null);
  assert.equal(report.versionMatches, true);
  assert.equal(report.sourcePresent, true);
});

test("all three guides open as version-bound immutable notebooks with resolving sources", () => {
  for (const guide of listGuidedInvestigations()) {
    const result = expectOk(open(guide.guideId));

    assert.doesNotThrow(() => notebookSchema.parse(result.notebook));
    assert.deepEqual(result.notebook.datasetVersions, [datasetVersion]);
    assert.equal(result.notebook.id, "guide-test-notebook");
    assert.equal(result.notebook.title, guide.title);
    assert.equal(result.notebook.question, guide.question);
    assert.equal(result.notebook.createdAt, openedAt);
    assert.equal(result.notebook.updatedAt, openedAt);
    assert.equal(result.notebook.steps.length, guide.steps.length);
    assert.equal(result.notebook.notes.length, 0);
    assert.equal(Object.isFrozen(result.notebook.steps), true);

    const validation = validateNotebookAgainstDataset(result.notebook, dataset);
    assert.equal(validation.status, "checked");
    assert.deepEqual(validation.issues, []);
    assert.deepEqual(validation.checkedStepIds, guide.steps.map(({ stepId }) => stepId));
    assert.deepEqual(validation.skippedStepIds, []);

    assert.equal(result.corpus.datasetVersion, datasetVersion);
    assert.equal(result.corpus.sourceId, sourceId);
    assert.equal(result.corpus.license, "CC0-1.0");
    assert.equal(result.corpus.doi, "10.60555/mbq8-0451");
    assert.ok(result.corpus.sourceTitle.includes("FLEX"));

    assert.equal(result.facts.length, guide.steps.length);
    assert.equal(result.limitations.length, guide.limitations.length);
    assert.equal(result.sourceReferences.length > 0, true);
    assert.equal(result.sourceAnchors.length, result.sourceReferences.length);
    assert.equal(
      new Set(result.sourceReferences.map((reference) => JSON.stringify(reference))).size,
      result.sourceReferences.length,
    );

    for (const step of result.notebook.steps) {
      assert.equal(step.datasetVersion, datasetVersion);
      assert.equal(step.createdAt, openedAt);
      assert.equal(Object.isFrozen(step), true);
      assert.equal(step.limitations.length <= 12, true);
      for (const limitation of step.limitations) {
        assert.equal(limitation.length <= 500, true);
      }
      for (const reference of step.sourceReferences) {
        assert.equal(reference.datasetVersion, datasetVersion);
        const resolution = resolveStableFieldReference(dataset, reference);
        assert.equal(resolution.status, "resolved", `${guide.guideId}/${step.stepId} source should resolve`);
      }
    }

    for (const entry of result.sourceAnchors) {
      assert.equal(entry.reference.datasetVersion, datasetVersion);
      assert.equal(entry.reference.sourceId, sourceId);
      const run = dataset.runs.find(({ id }) => id === entry.reference.runId);
      assert.ok(run, `Run ${entry.reference.runId} should exist`);
      const field = run.fields.find(({ key }) => key === entry.reference.fieldKey);
      assert.ok(field, `Field ${entry.reference.fieldKey} should exist`);
      assert.equal(entry.value, field.value);
      assert.equal(entry.original, field.original);
      assert.equal(entry.locator, field.locator);
      assert.equal(entry.locator.startsWith("PSI-69_Experimental table_FLEX.csv"), true);
      assert.equal(entry.sourceTitle, dataset.sources[0].title);
      assert.equal(entry.sourceUrl, dataset.sources[0].url);
    }
  }
});

test("burn-time guide computes verified FLEX-001/FLEX-004 values and conditions", () => {
  const result = expectOk(open("burn-time-condition-differences"));

  const plot = plotFact(result, "bt-1-burn-time");
  assert.equal(plot.includedCount, 2);
  assert.equal(plot.omittedCount, 0);
  assert.deepEqual(plot.omitted, []);
  assert.deepEqual(plot.points, [
    { runId: "FLEX-001", x: null, y: 4.3, group: null },
    { runId: "FLEX-004", x: null, y: 7.64, group: null },
  ]);

  const comparison = comparisonFact(result, "bt-2-context");
  assert.deepEqual(comparison.runIds, ["FLEX-001", "FLEX-004"]);
  assert.equal(comparison.gasComposition.complete, true);
  assert.equal(comparison.gasComposition.differenceCount, 1);
  assert.deepEqual(comparison.gasComposition.values, [
    { runId: "FLEX-001", oxygen: 0.21, nitrogen: 0.79, carbon_dioxide: 0, helium: 0 },
    { runId: "FLEX-004", oxygen: 0.21, nitrogen: 0.79, carbon_dioxide: 0, helium: 0 },
  ]);

  const burnTime = fieldFacts(comparison, "burn_time");
  assert.equal(burnTime.status, "different");
  assert.deepEqual(values(burnTime), [4.3, 7.64]);
  assert.equal(burnTime.deltas.length, 1);
  assert.equal(burnTime.deltas[0].fromRunId, "FLEX-001");
  assert.equal(burnTime.deltas[0].toRunId, "FLEX-004");
  close(burnTime.deltas[0].delta, 3.34);
  assert.equal(burnTime.deltas[0].unit, "s");

  const pressure = fieldFacts(comparison, "pressure");
  assert.equal(pressure.status, "different");
  close(pressure.deltas[0].delta, 2.3);
  assert.equal(fieldFacts(comparison, "diameter").status, "different");
  close(fieldFacts(comparison, "diameter").deltas[0].delta, 0.37);
  assert.equal(fieldFacts(comparison, "burning_rate").status, "different");
  close(fieldFacts(comparison, "burning_rate").deltas[0].delta, 0.08);

  const extinction = fieldFacts(comparison, "extinction_diameter");
  assert.equal(extinction.status, "unknown");
  assert.deepEqual(values(extinction), [0.89, null]);
  assert.deepEqual(extinction.deltas, []);

  const testEnd = fieldFacts(comparison, "test_end");
  assert.equal(testEnd.status, "different");
  assert.deepEqual(values(testEnd), ["Disruption", "Extinction"]);

  const burnTimeAnchor = anchor(result, "FLEX-001", "burn_time");
  assert.ok(burnTimeAnchor);
  assert.equal(burnTimeAnchor.value, 4.3);
  assert.match(burnTimeAnchor.locator, /CSV row 2, column N \(Burn time; s\)/);
  const missingAnchor = anchor(result, "FLEX-004", "extinction_diameter");
  assert.ok(missingAnchor);
  assert.equal(missingAnchor.value, null);
  assert.match(missingAnchor.locator, /CSV row 5, column L \(Visible flame extinction diameter; mm\)/);

  const comparisonStep = stepById(result, "bt-2-context");
  assert.equal(
    comparisonStep.limitations.some((text) => text.includes("null cell is unknown")),
    true,
  );
});

test("missing burning rate stays unknown, is omitted from the plot and is never zero", () => {
  const result = expectOk(open("missing-burning-rate"));

  const ratePlot = plotFact(result, "mr-1-burning-rate");
  assert.equal(ratePlot.includedCount, 1);
  assert.equal(ratePlot.omittedCount, 1);
  assert.deepEqual(ratePlot.points, [{ runId: "FLEX-013", x: null, y: 0.49, group: null }]);
  assert.deepEqual(ratePlot.omitted, [{ runId: "FLEX-014", reasons: ["missing-y"] }]);

  const timePlot = plotFact(result, "mr-2-burn-time");
  assert.equal(timePlot.includedCount, 2);
  assert.equal(timePlot.omittedCount, 0);
  assert.deepEqual(timePlot.points.map(({ y }) => y), [10.8, 11.3]);

  const comparison = comparisonFact(result, "mr-3-context");
  assert.deepEqual(comparison.runIds, ["FLEX-013", "FLEX-014"]);
  assert.equal(comparison.gasComposition.complete, true);
  assert.deepEqual(comparison.gasComposition.values, [
    { runId: "FLEX-013", oxygen: 0.21, nitrogen: 0.09, carbon_dioxide: 0.7, helium: 0 },
    { runId: "FLEX-014", oxygen: 0.21, nitrogen: 0.09, carbon_dioxide: 0.7, helium: 0 },
  ]);

  const burningRate = fieldFacts(comparison, "burning_rate");
  assert.equal(burningRate.status, "unknown");
  assert.deepEqual(values(burningRate), [0.49, null]);
  assert.deepEqual(burningRate.deltas, []);

  const burnTime = fieldFacts(comparison, "burn_time");
  assert.equal(burnTime.status, "different");
  assert.deepEqual(values(burnTime), [10.8, 11.3]);
  assert.equal(burnTime.deltas.length, 1);
  close(burnTime.deltas[0].delta, 0.5);
  close(burnTime.deltas[0].delta, 11.3 - 10.8);

  assert.equal(fieldFacts(comparison, "extinction_diameter").status, "unknown");
  assert.deepEqual(values(fieldFacts(comparison, "extinction_diameter")), [null, null]);
  assert.equal(fieldFacts(comparison, "test_end").status, "same");

  const missingAnchor = anchor(result, "FLEX-014", "burning_rate");
  assert.ok(missingAnchor);
  assert.equal(missingAnchor.value, null);
  assert.equal(missingAnchor.original, null);
  assert.match(missingAnchor.locator, /CSV row 15, column M \(Burning rate; mm\)/);

  const comparisonStep = stepById(result, "mr-3-context");
  assert.equal(
    comparisonStep.limitations.some((text) => text.includes("never treated as zero")),
    true,
  );
  assert.equal(
    ratePlot.limitations.some((text) => text.includes("never treated as zero")),
    true,
  );

  // The portable JSON carries the null cell as unknown, not as a zero value.
  const exported = expectOk(exportGuidedInvestigation(dataset, "missing-burning-rate", {
    notebookId: "guide-missing-rate-export",
    openedAt,
  }));
  const document = JSON.parse(exported.json.text);
  const persistedComparison = document.steps.find(({ stepId }) => stepId === "mr-3-context");
  assert.ok(persistedComparison);
  const persistedRate = [...persistedComparison.context.conditions, ...persistedComparison.context.outcomes]
    .find(({ key }) => key === "burning_rate");
  assert.ok(persistedRate);
  assert.equal(persistedRate.status, "unknown");
  assert.deepEqual(persistedRate.cells.map(({ value }) => value), [0.49, null]);
});

test("visible-extinction guide keeps the gas group and both test-end comparisons", () => {
  const result = expectOk(open("visible-flame-extinction"));

  const plot = plotFact(result, "xf-1-extinction");
  assert.equal(plot.includedCount, 4);
  assert.equal(plot.omittedCount, 0);
  assert.deepEqual(
    plot.points.map(({ runId, y }) => [runId, y]),
    [["FLEX-001", 0.89], ["FLEX-002", 0.94], ["FLEX-020", 1.56], ["FLEX-025", 0.59]],
  );

  const differentEnd = comparisonFact(result, "xf-2-different-end");
  assert.deepEqual(differentEnd.runIds, ["FLEX-001", "FLEX-002"]);
  assert.equal(fieldFacts(differentEnd, "test_end").status, "different");
  assert.deepEqual(values(fieldFacts(differentEnd, "test_end")), ["Disruption", "Extinction"]);
  const firstExtinction = fieldFacts(differentEnd, "extinction_diameter");
  assert.equal(firstExtinction.status, "different");
  close(firstExtinction.deltas[0].delta, 0.05);
  assert.equal(differentEnd.gasComposition.complete, true);
  assert.deepEqual(
    differentEnd.gasComposition.values.map(({ oxygen, nitrogen, carbon_dioxide, helium }) => (
      [oxygen, nitrogen, carbon_dioxide, helium]
    )),
    [[0.21, 0.79, 0, 0], [0.21, 0.79, 0, 0]],
  );

  const sameEnd = comparisonFact(result, "xf-3-same-end");
  assert.deepEqual(sameEnd.runIds, ["FLEX-020", "FLEX-025"]);
  assert.equal(fieldFacts(sameEnd, "test_end").status, "same");
  assert.deepEqual(values(fieldFacts(sameEnd, "test_end")), ["Completion", "Completion"]);
  assert.equal(fieldFacts(sameEnd, "oxygen").status, "different");
  close(fieldFacts(sameEnd, "oxygen").deltas[0].delta, -0.04);
  close(fieldFacts(sameEnd, "nitrogen").deltas[0].delta, 0.04);
  const extinction = fieldFacts(sameEnd, "extinction_diameter");
  assert.equal(extinction.status, "different");
  close(extinction.deltas[0].delta, -0.97);
  assert.equal(sameEnd.gasComposition.complete, true);
  assert.equal(sameEnd.gasComposition.differenceCount, 1);
  assert.deepEqual(
    sameEnd.gasComposition.values.map(({ oxygen, nitrogen, carbon_dioxide, helium }) => (
      [oxygen, nitrogen, carbon_dioxide, helium]
    )),
    [[0.34, 0.66, 0, 0], [0.3, 0.7, 0, 0]],
  );

  const flex020Anchor = anchor(result, "FLEX-020", "extinction_diameter");
  assert.ok(flex020Anchor);
  assert.equal(flex020Anchor.value, 1.56);
  assert.match(flex020Anchor.locator, /CSV row 21, column L/);
  const flex025Anchor = anchor(result, "FLEX-025", "extinction_diameter");
  assert.ok(flex025Anchor);
  assert.equal(flex025Anchor.value, 0.59);
  assert.match(flex025Anchor.locator, /CSV row 26, column L/);

  assert.equal(
    plot.limitations.some((text) => text.includes("estimated from burning history")),
    true,
  );
  assert.equal(
    differentEnd.limitations.some((text) => text.includes("not a quality ranking")),
    true,
  );
});

test("dataset mismatch is reported without rebuilding stale facts", () => {
  const otherVersion = { ...dataset, version: "flex-psi69-v5-table-v1-subset-other" };
  const versionMismatch = openGuidedInvestigation(otherVersion, "missing-burning-rate", { openedAt });
  assert.equal(versionMismatch.ok, false);
  assert.equal(versionMismatch.reason, "dataset-mismatch");
  assert.equal(versionMismatch.expectedDatasetVersion, datasetVersion);
  assert.equal(versionMismatch.actualDatasetVersion, otherVersion.version);
  assert.match(versionMismatch.message, /subset-other/);
  assert.match(versionMismatch.message, /flex-psi69-v5-table-v1-subset-1/);
  assert.equal(Object.hasOwn(versionMismatch, "notebook"), false);

  const missingSource = {
    ...dataset,
    sources: dataset.sources.filter(({ id }) => id !== sourceId),
  };
  const sourceMismatch = openGuidedInvestigation(missingSource, "burn-time-condition-differences", { openedAt });
  assert.equal(sourceMismatch.ok, false);
  assert.equal(sourceMismatch.reason, "dataset-mismatch");
  assert.match(sourceMismatch.message, /pinned source/i);
  assert.match(sourceMismatch.message, /psi-69-flex-table-v1/);

  const unknownGuide = openGuidedInvestigation(dataset, "not-a-guide", { openedAt });
  assert.equal(unknownGuide.ok, false);
  assert.equal(unknownGuide.reason, "unknown-guide");
  assert.match(unknownGuide.message, /burn-time-condition-differences/);

  const invalidDataset = openGuidedInvestigation({}, "missing-burning-rate", { openedAt });
  assert.equal(invalidDataset.ok, false);
  assert.equal(invalidDataset.reason, "invalid-dataset");

  const badTimestamp = openGuidedInvestigation(dataset, "missing-burning-rate", { openedAt: "not-a-time" });
  assert.equal(badTimestamp.ok, false);
  assert.equal(badTimestamp.reason, "invalid-options");

  const reversedTimes = openGuidedInvestigation(dataset, "missing-burning-rate", {
    openedAt,
    updatedAt: "2026-11-13T08:00:00+08:00",
  });
  assert.equal(reversedTimes.ok, false);
  assert.equal(reversedTimes.reason, "invalid-options");

  const badId = openGuidedInvestigation(dataset, "missing-burning-rate", {
    openedAt,
    notebookId: "not a valid notebook id",
  });
  assert.equal(badId.ok, false);
  assert.equal(badId.reason, "invalid-options");
  assert.ok(Array.isArray(badId.issues));
});

test("representative JSON export round-trips and the printable report keeps identity and limits", () => {
  const generatedAt = "2026-11-13T10:00:00+08:00";
  const exported = expectOk(exportGuidedInvestigation(dataset, "burn-time-condition-differences", {
    notebookId: "guide-export-notebook",
    openedAt,
    generatedAt,
  }));

  assert.equal(exported.json.mediaType, "application/json");
  assert.equal(exported.json.filename, "fire-evidence-notebook-guide-export-notebook.json");
  assert.equal(exported.json.text.endsWith("\n"), true);
  assert.equal(
    exported.json.byteLength,
    new TextEncoder().encode(exported.json.text).byteLength,
  );

  const document = JSON.parse(exported.json.text);
  assert.equal(document.schemaVersion, "notebook-1");
  assert.deepEqual(document.datasetVersions, [datasetVersion]);
  assert.equal(document.steps.length, 2);
  assert.equal(document.steps[1].stepType, "comparison");
  assert.equal(document.steps[1].request.runIds[0], "FLEX-001");

  const imported = importNotebookFromText(exported.json.text, {
    versionContext: { activeDatasetVersion: datasetVersion },
    datasets: [dataset],
  });
  assert.equal(imported.ok, true, imported.ok ? "" : imported.message);
  if (!imported.ok) assert.fail(imported.message);
  assert.equal(imported.source, "notebook");
  assert.equal(imported.verification, "not-verified");
  assert.equal(imported.byteLength, exported.json.byteLength);
  assert.equal(imported.notebook.id, "guide-export-notebook");
  assert.equal(imported.notebook.steps.length, 2);
  assert.equal(imported.corpusChecks.length, 1);
  assert.deepEqual(imported.corpusChecks[0].issues, []);
  assert.deepEqual(imported.corpusChecks[0].checkedStepIds, ["bt-1-burn-time", "bt-2-context"]);

  const html = exported.printableHtml;
  assert.equal(html.includes("<!doctype html>"), true);
  assert.equal(html.includes(datasetVersion), true);
  assert.equal(html.includes("Burn time and recorded conditions"), true);
  assert.equal(html.includes("Limitations"), true);
  assert.equal(html.includes("PSI-69_Experimental table_FLEX.csv, CSV row 2, column N"), true);
  assert.equal(html.includes("substituted with zero"), true);
  assert.equal(html.includes("Exact corpus not supplied"), false);
  assert.equal(html.toLowerCase().includes("<script"), false);

  const mismatchedExport = exportGuidedInvestigation(
    { ...dataset, version: "flex-other" },
    "burn-time-condition-differences",
    { openedAt },
  );
  assert.equal(mismatchedExport.ok, false);
  assert.equal(mismatchedExport.reason, "dataset-mismatch");
});

test("opening is deterministic with caller identity and safe without one", () => {
  const first = expectOk(open("missing-burning-rate", { notebookId: "guide-stable", openedAt }));
  const second = expectOk(open("missing-burning-rate", { notebookId: "guide-stable", openedAt }));
  assert.equal(JSON.stringify(first.notebook), JSON.stringify(second.notebook));
  assert.deepEqual(first.sourceReferences, second.sourceReferences);
  assert.equal(first.notebook.createdAt, openedAt);
  assert.equal(first.notebook.updatedAt, openedAt);
  assert.deepEqual(
    first.notebook.steps.map(({ createdAt }) => createdAt),
    [openedAt, openedAt, openedAt],
  );

  const laterUpdated = expectOk(open("burn-time-condition-differences", {
    notebookId: "guide-later",
    openedAt,
    updatedAt: "2026-11-13T09:30:00+08:00",
  }));
  assert.equal(laterUpdated.notebook.updatedAt, "2026-11-13T09:30:00+08:00");
  assert.equal(laterUpdated.notebook.steps[0].createdAt, openedAt);

  const generated = expectOk(openGuidedInvestigation(dataset, "visible-flame-extinction"));
  assert.match(generated.notebook.id, /^guide-visible-flame-extinction-[a-z0-9]+$/);
  assert.equal(generated.notebook.id.length <= 64, true);
  assert.equal(Number.isFinite(Date.parse(generated.notebook.createdAt)), true);
  assert.equal(generated.notebook.updatedAt, generated.notebook.createdAt);
  assert.deepEqual(
    generated.notebook.steps.map(({ createdAt }) => createdAt),
    generated.notebook.steps.map(() => generated.notebook.createdAt),
  );
});
