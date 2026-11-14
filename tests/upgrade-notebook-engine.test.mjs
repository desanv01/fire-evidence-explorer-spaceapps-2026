import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { notebookLimits } from "../src/lib/upgrades/notebook.ts";
import {
  appendNotebookStep,
  appendRerunStep,
  createBrowserNotebookStorage,
  createComparisonNotebookStep,
  createEvidenceAnswerNotebookStep,
  createNotebook,
  createNotebookImportEnvelope,
  createNotebookStorage,
  createPlotNotebookStep,
  importNotebookFromBytes,
  importNotebookFromText,
  loadNotebookFromStorage,
  measureNotebookBytes,
  notebookStorageKey,
  reportNotebookVersionMismatch,
  saveNotebookToStorage,
  snapshotEvidenceAnswer,
} from "../src/lib/upgrades/notebook-engine.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;
const historicalVersion = "flex-psi69-v5-table-v1-subset-0";
const sourceId = "psi-69-flex-table-v1";
const createdAt = "2026-11-12T19:00:00+08:00";
const updatedAt = "2026-11-12T19:30:00+08:00";
const paddedQuestion = "  What was the burn time?  ";

const versionContext = {
  activeDatasetVersion: datasetVersion,
  availableDatasetVersions: [historicalVersion],
};

function reference(runId, fieldKey, version = datasetVersion) {
  return { datasetVersion: version, runId, fieldKey, sourceId };
}

function scatterSpec(runIds = ["FLEX-001", "FLEX-002"], version = datasetVersion) {
  return {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: "oxygen" }, y: { field: "burning_rate" } },
    grouping: "none",
    scope: { kind: "explicit-runs", runIds },
  };
}

function scatterResult(runIds = ["FLEX-001", "FLEX-002"], version = datasetVersion) {
  return {
    version: "plot-result-1",
    specVersion: "plot-spec-1",
    kind: "scatter",
    datasetVersion: version,
    axes: { kind: "scatter", x: "oxygen", y: "burning_rate" },
    grouping: "none",
    scope: { kind: "explicit-runs", search: null, activeFilters: [] },
    resolvedRunIds: runIds,
    includedCount: runIds.length,
    omittedCount: 0,
    points: runIds.map((runId) => ({
      runId,
      x: 0.21,
      y: runId === "FLEX-001" ? 0.52 : 0.6,
      group: null,
      sourceReferences: [reference(runId, "oxygen", version), reference(runId, "burning_rate", version)],
    })),
    omitted: [],
    limitations: ["Only finite recorded values are plotted."],
  };
}

function plotStepInput({ stepId = "step-plot-1", version = datasetVersion, runIds = ["FLEX-001", "FLEX-002"] } = {}) {
  return {
    stepId,
    title: "Oxygen and burning rate",
    createdAt,
    plotSpec: scatterSpec(runIds, version),
    plotResult: scatterResult(runIds, version),
  };
}

function comparisonContext(version = datasetVersion) {
  const runIds = ["FLEX-001", "FLEX-010"];
  return {
    version: "comparison-context-result-1",
    kind: "selected-runs-context",
    datasetVersion: version,
    comparisonRuleVersion: "1",
    contextRuleVersion: "comparison-context-1",
    request: {
      version: "comparison-context-request-1",
      kind: "selected-runs",
      runIds,
      focusCondition: "oxygen",
    },
    runIds,
    conditions: [
      {
        key: "oxygen",
        label: "Initial ambient oxygen",
        kind: "condition",
        status: "same",
        unit: "mole fraction",
        cells: [
          { runId: "FLEX-001", value: 0.21, original: "0.21", reference: reference("FLEX-001", "oxygen", version) },
          { runId: "FLEX-010", value: 0.21, original: "0.21", reference: reference("FLEX-010", "oxygen", version) },
        ],
        deltas: [],
        reason: "Recorded values match exactly.",
      },
      {
        key: "nitrogen",
        label: "Initial ambient nitrogen",
        kind: "condition",
        status: "different",
        unit: "mole fraction",
        cells: [
          { runId: "FLEX-001", value: 0.79, original: "0.79", reference: reference("FLEX-001", "nitrogen", version) },
          { runId: "FLEX-010", value: 0.09, original: "0.09", reference: reference("FLEX-010", "nitrogen", version) },
        ],
        deltas: [{
          fromRunId: "FLEX-001", toRunId: "FLEX-010", delta: -0.7, unit: "mole fraction",
          provenanceClass: "deterministic-derived", ruleVersion: "native-delta-1",
        }],
        reason: "Recorded values differ.",
      },
    ],
    outcomes: [{
      key: "burn_time",
      label: "Burn time",
      kind: "outcome",
      status: "different",
      unit: "s",
      cells: [
        { runId: "FLEX-001", value: 4.3, original: "4.3", reference: reference("FLEX-001", "burn_time", version) },
        { runId: "FLEX-010", value: 13.6, original: "13.6", reference: reference("FLEX-010", "burn_time", version) },
      ],
      deltas: [{
        fromRunId: "FLEX-001", toRunId: "FLEX-010", delta: 9.3, unit: "s",
        provenanceClass: "deterministic-derived", ruleVersion: "native-delta-1",
      }],
      reason: "Recorded values differ.",
    }],
    gasComposition: {
      fieldKeys: ["oxygen", "nitrogen", "carbon_dioxide", "helium"],
      complete: true,
      values: [
        { runId: "FLEX-001", values: { oxygen: 0.21, nitrogen: 0.79, carbon_dioxide: 0, helium: 0 } },
        { runId: "FLEX-010", values: { oxygen: 0.21, nitrogen: 0.09, carbon_dioxide: 0.7, helium: 0 } },
      ],
      differences: [{
        fromRunId: "FLEX-001", toRunId: "FLEX-010",
        values: [
          { key: "oxygen", delta: 0, unit: "mole fraction" },
          { key: "nitrogen", delta: -0.7, unit: "mole fraction" },
          { key: "carbon_dioxide", delta: 0.7, unit: "mole fraction" },
          { key: "helium", delta: 0, unit: "mole fraction" },
        ],
      }],
      limitation: "Gas fractions are linked. Inspect the complete recorded composition; a difference in oxygen alone does not establish an isolated oxygen effect.",
    },
    evidence: [{
      category: "recorded-observation",
      text: "The selected runs report the same ambient oxygen fraction.",
      fieldKeys: ["oxygen"],
      sourceReferences: [reference("FLEX-001", "oxygen", version), reference("FLEX-010", "oxygen", version)],
    }],
    limitations: ["Recorded differences cannot establish a causal conclusion."],
  };
}

function evidenceExplanation(overrides = {}) {
  const citationId = "field:1";
  return {
    datasetVersion,
    datasetSha256: "a".repeat(64),
    comparisonRuleVersion: "1",
    requestQuestion: paddedQuestion,
    question: "What was the burn time?",
    runIds: ["FLEX-001"],
    packetVersion: 1,
    packet: {
      scope: "selected-runs",
      evidence: [{
        id: citationId,
        status: "reported",
        text: "Burn time for FLEX-001.",
        numbers: [{ label: "Burn time (FLEX-001)", value: 4.3, unit: "s" }],
      }],
      limitations: ["Matching values cannot establish scientific equivalence."],
    },
    citations: {
      [citationId]: {
        fieldKey: "burn_time",
        sources: [{ runId: "FLEX-001", sourceId, locator: "Synthetic locator for the fixture" }],
      },
    },
    explanation: {
      status: "supported",
      scope: "selected-runs",
      claims: [{
        text: "The selected record reports a burn time.",
        citationIds: [citationId],
        citationTargets: [{ citationId, runId: "FLEX-001" }],
        status: "reported",
        scope: "selected-runs",
        measurements: [{ label: "Burn time (FLEX-001)", value: 4.3, unit: "s", citationId }],
      }],
      model: null,
    },
    explanationReceipt: `abc.${"a".repeat(43)}`,
    ...overrides,
  };
}

function note() {
  return {
    noteId: "note-1",
    text: "The gas composition must be inspected together.",
    classification: "personal-note",
    verifiedEvidence: false,
    createdAt,
    updatedAt,
  };
}

function createMemoryStorage() {
  const values = new Map();
  return {
    values,
    read(key) {
      return values.has(key) ? values.get(key) : null;
    },
    write(key, value) {
      values.set(key, value);
    },
    remove(key) {
      values.delete(key);
    },
  };
}

function populatedNotebook({ id = "notebook-flex-1" } = {}) {
  const base = createNotebook({
    id,
    title: "Oxygen and burn time",
    question: "How does recorded oxygen relate to burn time?",
    datasetVersions: [datasetVersion],
    createdAt,
    updatedAt: createdAt,
  });
  const withNote = { ...base, notes: [note()], updatedAt };
  const steps = [
    createPlotNotebookStep(plotStepInput()),
    createComparisonNotebookStep({
      stepId: "step-comparison-1",
      title: "Composition context",
      createdAt,
      context: comparisonContext(),
    }),
    createEvidenceAnswerNotebookStep({
      stepId: "step-answer-1",
      title: "Validated burn-time answer",
      createdAt,
      answer: evidenceExplanation(),
    }),
  ];
  let notebook = withNote;
  for (const step of steps) {
    const appended = appendNotebookStep(notebook, step, { now: updatedAt });
    assert.equal(appended.ok, true, appended.ok ? "" : JSON.stringify(appended));
    notebook = appended.notebook;
  }
  return notebook;
}

function historicalNotebook() {
  const base = createNotebook({
    id: "notebook-historical-1",
    title: "Historical oxygen plot",
    question: "Which oxygen values were recorded?",
    datasetVersions: [historicalVersion],
    createdAt,
    updatedAt: createdAt,
  });
  const appended = appendNotebookStep(base, createPlotNotebookStep(plotStepInput({
    stepId: "step-old-1",
    version: historicalVersion,
  })), { now: updatedAt });
  assert.equal(appended.ok, true, appended.ok ? "" : JSON.stringify(appended));
  return appended.notebook;
}

test("creates immutable step snapshots and appends without mutating inputs", () => {
  const base = createNotebook({
    id: "notebook-flex-1",
    title: "Oxygen and burn time",
    question: "How does recorded oxygen relate to burn time?",
    datasetVersions: [datasetVersion],
    createdAt,
    updatedAt: createdAt,
  });
  const notebookWithNote = { ...base, notes: [note()], updatedAt };

  const plotResult = scatterResult();
  const plotSpec = scatterSpec();
  const plotStep = createPlotNotebookStep({
    stepId: "step-plot-1",
    title: "Oxygen and burning rate",
    createdAt,
    plotSpec,
    plotResult,
  });

  plotResult.resolvedRunIds.push("FLEX-003");
  plotResult.points[0].x = 999;
  plotSpec.axes.x.field = "pressure";
  assert.deepEqual(plotStep.plotResult.resolvedRunIds, ["FLEX-001", "FLEX-002"]);
  assert.equal(plotStep.plotResult.points[0].x, 0.21);
  assert.equal(plotStep.plotSpec.axes.x.field, "oxygen");
  assert.equal(plotStep.datasetVersion, datasetVersion);
  assert.equal(plotStep.query.search, null);
  assert.equal(plotStep.sourceReferences.length, 4);
  assert.ok(Object.isFrozen(plotStep));
  assert.ok(Object.isFrozen(plotStep.plotResult.points[0]));

  const context = comparisonContext();
  const comparisonStep = createComparisonNotebookStep({
    stepId: "step-comparison-1",
    title: "Composition context",
    createdAt,
    context,
  });
  context.runIds.push("FLEX-003");
  context.request.runIds.push("FLEX-003");
  assert.deepEqual(comparisonStep.resolvedRunIds, ["FLEX-001", "FLEX-010"]);
  assert.deepEqual(comparisonStep.request.runIds, ["FLEX-001", "FLEX-010"]);
  assert.equal(comparisonStep.sourceReferences.length, 6);

  const explanation = evidenceExplanation();
  const answerStep = createEvidenceAnswerNotebookStep({
    stepId: "step-answer-1",
    title: "Validated burn-time answer",
    createdAt,
    answer: explanation,
  });
  explanation.packet.evidence[0].text = "mutated";
  assert.equal(answerStep.answer.packet.evidence[0].text, "Burn time for FLEX-001.");
  assert.equal(answerStep.answer.requestQuestion, paddedQuestion);
  assert.equal(answerStep.answer.question, "What was the burn time?");
  assert.equal(answerStep.answer.receiptVerification, "not-verified");
  assert.equal(snapshotEvidenceAnswer(evidenceExplanation()).requestQuestion, paddedQuestion);
  assert.throws(() => snapshotEvidenceAnswer(evidenceExplanation({ requestQuestion: "   " })));

  let appendedNotebook = notebookWithNote;
  for (const step of [plotStep, comparisonStep, answerStep]) {
    const result = appendNotebookStep(appendedNotebook, step, { now: updatedAt });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
    appendedNotebook = result.notebook;
    assert.ok(Object.isFrozen(result.step));
  }

  assert.equal(notebookWithNote.steps.length, 0);
  assert.deepEqual(appendedNotebook.steps.map(({ stepId }) => stepId), [
    "step-plot-1", "step-comparison-1", "step-answer-1",
  ]);
  assert.deepEqual(appendedNotebook.steps.map(({ datasetVersion: version }) => version), [
    datasetVersion, datasetVersion, datasetVersion,
  ]);
  assert.deepEqual(appendedNotebook.notes, notebookWithNote.notes);
  assert.notEqual(appendedNotebook.notes, notebookWithNote.notes);
  assert.equal(appendedNotebook.steps[2].answer.requestQuestion, paddedQuestion);

  const duplicate = appendNotebookStep(appendedNotebook, plotStep, { now: updatedAt });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate-step-id");
});

test("saves and loads one notebook round trip through injected storage", () => {
  const storage = createMemoryStorage();
  const notebook = populatedNotebook();
  const saved = saveNotebookToStorage(storage, notebook);
  assert.equal(saved.ok, true, saved.ok ? "" : JSON.stringify(saved));
  assert.equal(saved.key, notebookStorageKey(notebook.id));
  assert.equal(saved.serializedBytes, measureNotebookBytes(storage.values.get(saved.key)));
  assert.deepEqual(JSON.parse(storage.values.get(saved.key)), notebook);

  const loaded = loadNotebookFromStorage(storage, notebook.id, {
    versionContext: { activeDatasetVersion: datasetVersion },
  });
  assert.equal(loaded.ok, true, loaded.ok ? "" : JSON.stringify(loaded));
  assert.deepEqual(loaded.notebook, notebook);
  assert.equal(loaded.serializedBytes, saved.serializedBytes);
  assert.deepEqual(loaded.versionReport.map(({ status }) => status), ["same-version"]);
  assert.equal(loaded.notebook.steps[2].answer.requestQuestion, paddedQuestion);
  assert.ok(Object.isFrozen(loaded.notebook.steps[0]));

  const missing = loadNotebookFromStorage(storage, "notebook-other-1");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not-found");

  assert.equal(createBrowserNotebookStorage(), null);

  const backing = new Map();
  const adapter = createNotebookStorage({
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  });
  assert.notEqual(adapter, null);
  assert.equal(saveNotebookToStorage(adapter, notebook).ok, true);
  assert.equal(loadNotebookFromStorage(adapter, notebook.id).ok, true);
  assert.equal(createNotebookStorage(null), null);
});

test("import rejects oversized and invalid documents without touching stored data", () => {
  const storage = createMemoryStorage();
  const storedNotebook = populatedNotebook();
  const saved = saveNotebookToStorage(storage, storedNotebook);
  assert.equal(saved.ok, true);
  const storedKey = saved.key;
  const before = storage.values.get(storedKey);
  const unchanged = () => assert.equal(storage.values.get(storedKey), before);
  const importOptions = { versionContext };

  const oversizedText = JSON.stringify(storedNotebook) + " ".repeat(notebookLimits.importMaxBytes);
  const oversized = importNotebookFromText(oversizedText, importOptions);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, "too-large");
  assert.ok(oversized.byteLength > notebookLimits.importMaxBytes);
  unchanged();

  const multibyte = "é".repeat(Math.ceil(notebookLimits.importMaxBytes / 2) + 1);
  assert.ok(multibyte.length < notebookLimits.importMaxBytes);
  assert.ok(measureNotebookBytes(multibyte) > notebookLimits.importMaxBytes);
  assert.equal(importNotebookFromText(multibyte, importOptions).reason, "too-large");
  unchanged();

  const oversizedBytes = new Uint8Array(notebookLimits.importMaxBytes + 1);
  assert.equal(importNotebookFromBytes(oversizedBytes, importOptions).reason, "too-large");
  unchanged();

  const invalidJson = importNotebookFromText("{not json", importOptions);
  assert.equal(invalidJson.reason, "invalid-json");
  unchanged();

  const invalidUtf8 = importNotebookFromBytes(new Uint8Array([0x7b, 0xff, 0x7d]), importOptions);
  assert.equal(invalidUtf8.reason, "invalid-utf8");
  unchanged();

  const invalidContent = importNotebookFromText(JSON.stringify({ schemaVersion: "notebook-1" }), importOptions);
  assert.equal(invalidContent.reason, "invalid-content");
  assert.ok(invalidContent.issues.length > 0);
  unchanged();

  const importedNotebook = populatedNotebook({ id: "notebook-imported-1" });
  const imported = importNotebookFromText(JSON.stringify(importedNotebook), importOptions);
  assert.equal(imported.ok, true, imported.ok ? "" : JSON.stringify(imported));
  assert.equal(imported.verification, "not-verified");
  assert.equal(imported.source, "notebook");
  assert.equal(imported.notebook.id, "notebook-imported-1");
  assert.equal(imported.notebook.steps[2].answer.requestQuestion, paddedQuestion);
  unchanged();

  const envelope = createNotebookImportEnvelope(importedNotebook, { importedAt: updatedAt });
  assert.equal(envelope.verification, "not-verified");
  const importedEnvelope = importNotebookFromText(JSON.stringify(envelope), importOptions);
  assert.equal(importedEnvelope.ok, true, importedEnvelope.ok ? "" : JSON.stringify(importedEnvelope));
  assert.equal(importedEnvelope.source, "import-envelope");
  assert.equal(importedEnvelope.verification, "not-verified");
  unchanged();

  const withCorpus = importNotebookFromText(JSON.stringify(importedNotebook), {
    versionContext,
    datasets: [dataset],
  });
  assert.equal(withCorpus.ok, true);
  assert.equal(withCorpus.corpusChecks.length, 1);
  assert.equal(withCorpus.corpusChecks[0].status, "checked");
  assert.deepEqual(withCorpus.corpusChecks[0].issues, []);

  const tampered = structuredClone(importedNotebook);
  tampered.steps[0].sourceReferences[0].sourceId = "unknown-source";
  const rejected = importNotebookFromText(JSON.stringify(tampered), {
    versionContext,
    datasets: [dataset],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid-corpus");
  assert.ok(rejected.issues.length >= 1);
  unchanged();
});

test("retains a historical snapshot with a version report and appends a separate re-run", () => {
  const original = historicalNotebook();
  const context = { activeDatasetVersion: datasetVersion, availableDatasetVersions: [historicalVersion] };

  const report = reportNotebookVersionMismatch(original, context);
  assert.equal(report.hasMismatch, true);
  assert.deepEqual(report.historicalVersions, [historicalVersion]);
  assert.deepEqual(report.unavailableVersions, []);
  assert.match(report.message, /re-run/i);
  assert.equal(original.steps[0].datasetVersion, historicalVersion);

  const imported = importNotebookFromText(JSON.stringify(original), { versionContext: context });
  assert.equal(imported.ok, true, imported.ok ? "" : JSON.stringify(imported));
  assert.equal(imported.verification, "not-verified");
  assert.deepEqual(imported.notebook.steps[0], original.steps[0]);
  assert.deepEqual(imported.notebook.datasetVersions, [historicalVersion]);
  assert.deepEqual(imported.versionReport.map(({ status }) => status), ["historical-version"]);
  assert.deepEqual(imported.versionReport[0].stepIds, ["step-old-1"]);

  const unavailable = importNotebookFromText(JSON.stringify(original), {
    versionContext: { activeDatasetVersion: datasetVersion },
  });
  assert.equal(unavailable.ok, true);
  assert.deepEqual(unavailable.versionReport.map(({ status }) => status), ["unavailable-version"]);
  assert.deepEqual(unavailable.notebook.steps[0], original.steps[0]);

  const withDataset = importNotebookFromText(JSON.stringify(original), {
    versionContext: context,
    datasets: [dataset],
  });
  assert.equal(withDataset.ok, true);
  assert.deepEqual(withDataset.corpusChecks, []);

  const currentStep = createPlotNotebookStep(plotStepInput({ stepId: "step-rerun-1" }));
  const rerun = appendRerunStep(imported.notebook, currentStep, {
    activeDatasetVersion: datasetVersion,
    now: updatedAt,
  });
  assert.equal(rerun.ok, true, rerun.ok ? "" : JSON.stringify(rerun));
  assert.equal(rerun.notebook.steps.length, 2);
  assert.deepEqual(rerun.notebook.steps[0], imported.notebook.steps[0]);
  assert.equal(rerun.notebook.steps[1].datasetVersion, datasetVersion);
  assert.deepEqual(rerun.notebook.datasetVersions, [historicalVersion, datasetVersion]);
  assert.equal(imported.notebook.steps.length, 1);

  const updatedReport = reportNotebookVersionMismatch(rerun.notebook, context);
  assert.deepEqual(updatedReport.entries.map(({ status }) => status), ["historical-version", "same-version"]);
  assert.deepEqual(updatedReport.historicalVersions, [historicalVersion]);

  const wrongVersion = appendRerunStep(imported.notebook, original.steps[0], {
    activeDatasetVersion: datasetVersion,
  });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.reason, "version-mismatch");
  assert.equal(imported.notebook.steps.length, 1);
});

test("returns structured storage failures and preserves prior data", () => {
  const notebook = populatedNotebook();
  assert.equal(saveNotebookToStorage(null, notebook).reason, "unavailable-storage");
  assert.equal(loadNotebookFromStorage(undefined, notebook.id).reason, "unavailable-storage");

  const key = notebookStorageKey(notebook.id);
  const prior = JSON.stringify(notebook);
  const quotaStorage = {
    values: new Map([[key, prior]]),
    read(storageKey) {
      return this.values.get(storageKey) ?? null;
    },
    write(storageKey, value) {
      if (value !== prior) {
        this.values.set(storageKey, "{corrupt");
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      this.values.set(storageKey, value);
    },
    remove(storageKey) {
      this.values.delete(storageKey);
    },
  };
  const invalidSave = saveNotebookToStorage(quotaStorage, { schemaVersion: "notebook-1" });
  assert.equal(invalidSave.ok, false);
  assert.equal(invalidSave.reason, "invalid-notebook");
  assert.ok(invalidSave.issues.length > 0);
  assert.equal(quotaStorage.values.get(key), prior);

  const changed = { ...notebook, title: "Changed title", updatedAt: "2026-11-12T20:00:00+08:00" };
  const quotaFailure = saveNotebookToStorage(quotaStorage, changed);
  assert.equal(quotaFailure.ok, false);
  assert.equal(quotaFailure.reason, "quota-exceeded");
  assert.equal(quotaStorage.values.get(key), prior);

  const corruptStorage = createMemoryStorage();
  corruptStorage.values.set(key, "{not notebook json");
  const corrupt = loadNotebookFromStorage(corruptStorage, notebook.id);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, "invalid-stored-data");
  assert.equal(corruptStorage.values.get(key), "{not notebook json");

  const shapeStorage = createMemoryStorage();
  shapeStorage.values.set(key, JSON.stringify({ schemaVersion: "notebook-1" }));
  const shape = loadNotebookFromStorage(shapeStorage, notebook.id);
  assert.equal(shape.ok, false);
  assert.equal(shape.reason, "invalid-stored-data");
  assert.ok(shape.issues.length > 0);
  assert.equal(shapeStorage.values.get(key), JSON.stringify({ schemaVersion: "notebook-1" }));
});
