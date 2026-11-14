import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { notebookLimits, notebookSchema } from "../src/lib/upgrades/notebook.ts";
import {
  appendNotebookStep,
  createComparisonNotebookStep,
  createEvidenceAnswerNotebookStep,
  createNotebook,
  createPlotNotebookStep,
  importNotebookFromText,
  measureNotebookBytes,
} from "../src/lib/upgrades/notebook-engine.ts";
import {
  addNotebookNote,
  createNotebookNote,
  editNotebookNote,
  escapeHtml,
  exportNotebookJson,
  notebookJsonFilename,
  removeNotebookNote,
  renderPrintableNotebookHtml,
} from "../src/lib/upgrades/notebook-presentation.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;
const historicalVersion = "flex-psi69-v5-table-v1-subset-0";
const sourceId = "psi-69-flex-table-v1";
const createdAt = "2025-01-15T19:00:00+08:00";
const updatedAt = "2025-01-15T19:30:00+08:00";
const later = "2025-01-15T22:00:00+08:00";

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

function plotStepInput({ stepId = "step-plot-1", version = datasetVersion, title = "Oxygen and burning rate" } = {}) {
  return {
    stepId,
    title,
    createdAt,
    plotSpec: scatterSpec(undefined, version),
    plotResult: scatterResult(undefined, version),
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
    requestQuestion: "  What was the burn time?  ",
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
        sources: [{ runId: "FLEX-001", sourceId, locator: "Stored locator for FLEX-001 burn time" }],
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

function baseNotebook(id = "notebook-flex-1", title = "Oxygen and burn time") {
  return createNotebook({
    id,
    title,
    question: "How does recorded oxygen relate to burn time?",
    datasetVersions: [datasetVersion],
    createdAt,
    updatedAt: createdAt,
  });
}

function appendStep(notebook, step) {
  const appended = appendNotebookStep(notebook, step, { now: updatedAt });
  assert.equal(appended.ok, true, appended.ok ? "" : JSON.stringify(appended));
  return appended.notebook;
}

function populatedNotebook({ id = "notebook-flex-1", title = "Oxygen and burn time" } = {}) {
  let notebook = baseNotebook(id, title);
  notebook = appendStep(notebook, createPlotNotebookStep(plotStepInput()));
  notebook = appendStep(notebook, createComparisonNotebookStep({
    stepId: "step-comparison-1",
    title: "Composition context",
    createdAt,
    context: comparisonContext(),
  }));
  notebook = appendStep(notebook, createEvidenceAnswerNotebookStep({
    stepId: "step-answer-1",
    title: "Validated burn-time answer",
    createdAt,
    answer: evidenceExplanation(),
  }));
  const added = addNotebookNote(notebook, createNotebookNote({
    noteId: "note-1",
    text: "Check the complete gas composition before interpreting oxygen.",
    createdAt,
    updatedAt,
  }), { now: updatedAt });
  assert.equal(added.ok, true, added.ok ? "" : JSON.stringify(added));
  return added.notebook;
}

function historicalNotebook() {
  let notebook = createNotebook({
    id: "notebook-historical-1",
    title: "Historical oxygen plot",
    question: "Which oxygen values were recorded?",
    datasetVersions: [historicalVersion],
    createdAt,
    updatedAt: createdAt,
  });
  notebook = appendStep(notebook, createPlotNotebookStep(plotStepInput({
    stepId: "step-old-1",
    version: historicalVersion,
    title: "Historical oxygen plot",
  })));
  const added = addNotebookNote(notebook, createNotebookNote({
    noteId: "note-old-1",
    text: "Stored note from the historical notebook.",
    createdAt,
    updatedAt,
  }), { now: updatedAt });
  assert.equal(added.ok, true);
  return added.notebook;
}

function historicalDatasetWithMarker() {
  const clone = structuredClone(dataset);
  clone.version = historicalVersion;
  const field = clone.runs
    .find(({ id }) => id === "FLEX-001")
    .fields.find(({ key }) => key === "oxygen");
  field.locator = "historical-locator-marker";
  return parseDataset(clone);
}

function answerStepForSize(receipt) {
  return createEvidenceAnswerNotebookStep({
    stepId: "step-big-0",
    title: "Large answer",
    createdAt,
    answer: evidenceExplanation({ explanationReceipt: receipt }),
  });
}

test("portable JSON export round-trips through the import engine with a saved step and note", () => {
  const notebook = populatedNotebook();
  const exported = exportNotebookJson(notebook);
  assert.equal(exported.ok, true, exported.ok ? "" : JSON.stringify(exported));
  assert.equal(exported.mediaType, "application/json");
  assert.equal(exported.filename, notebookJsonFilename(notebook));
  assert.equal(exported.byteLength, measureNotebookBytes(exported.text));
  assert.ok(exported.byteLength <= notebookLimits.importMaxBytes);
  assert.ok(exported.text.endsWith("\n"));
  assert.deepEqual(JSON.parse(exported.text), notebook);

  const imported = importNotebookFromText(exported.text, {
    versionContext: { activeDatasetVersion: datasetVersion, availableDatasetVersions: [historicalVersion] },
    datasets: [dataset],
  });
  assert.equal(imported.ok, true, imported.ok ? "" : JSON.stringify(imported));
  assert.equal(imported.verification, "not-verified");
  assert.deepEqual(imported.notebook, notebook);
  assert.deepEqual(imported.notebook.steps.map(({ stepId }) => stepId), [
    "step-plot-1", "step-comparison-1", "step-answer-1",
  ]);
  assert.deepEqual(imported.notebook.datasetVersions, [datasetVersion]);
  assert.equal(imported.notebook.notes.length, 1);
  assert.equal(imported.notebook.notes[0].classification, "personal-note");
  assert.equal(imported.notebook.notes[0].verifiedEvidence, false);
  assert.equal(imported.notebook.steps[2].answer.receiptVerification, "not-verified");
  assert.equal(imported.notebook.steps[2].answer.requestQuestion, "  What was the burn time?  ");
  assert.deepEqual(imported.versionReport.map(({ status }) => status), ["same-version"]);
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("printable report escapes injected content and labels personal notes separately", () => {
  const injectedTitle = `"><img src=x onerror=alert(1)>`;
  const injectedQuestion = `<script>alert("question")</script>`;
  const injectedStepTitle = `<script>alert("step")</script>`;
  const injectedNote = `<img src=x onerror=alert(1)>\n<script>alert("note")</script>`;
  let notebook = createNotebook({
    id: "notebook-escape-1",
    title: injectedTitle,
    question: injectedQuestion,
    datasetVersions: [datasetVersion],
    createdAt,
    updatedAt: createdAt,
  });
  notebook = appendStep(notebook, createPlotNotebookStep(plotStepInput({ title: injectedStepTitle })));
  const maliciousAnswer = evidenceExplanation();
  maliciousAnswer.citations = {
    "field:1": {
      fieldKey: "burn_time",
      sources: [{ runId: "FLEX-001", sourceId, locator: "<img src=x onerror=alert(2)>" }],
    },
  };
  notebook = appendStep(notebook, createEvidenceAnswerNotebookStep({
    stepId: "step-answer-1",
    title: "Answer with a receipt",
    createdAt,
    answer: maliciousAnswer,
  }));
  const added = addNotebookNote(notebook, createNotebookNote({
    noteId: "note-1",
    text: injectedNote,
    createdAt,
    updatedAt,
  }), { now: updatedAt });
  assert.equal(added.ok, true);
  notebook = added.notebook;

  const html = renderPrintableNotebookHtml(notebook, { datasets: [dataset], generatedAt: updatedAt });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(!html.includes("<script"), "no script element may be emitted");
  assert.ok(!html.includes("<img"), "no image element may be emitted");
  assert.ok(!html.includes("href="), "no hyperlink may be emitted");
  assert.ok(!html.includes(' src="'), "no resource attribute may be emitted");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;question&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;step&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));

  assert.ok(html.includes("Personal notes"));
  assert.ok(html.includes("not evidence"));
  assert.ok(html.indexOf('class="notes"') > html.indexOf("Evidence steps"));
  assert.ok(html.indexOf("Personal notes") > html.indexOf("Evidence steps"));

  const plain = renderPrintableNotebookHtml(populatedNotebook(), { datasets: [dataset], generatedAt: updatedAt });
  assert.ok(plain.includes("Oxygen and burn time"));
  assert.ok(plain.includes("How does recorded oxygen relate to burn time?"));
  assert.ok(plain.includes("Step 1"));
  assert.ok(plain.includes("Plot snapshot"));
  assert.ok(plain.includes("Axes and native units"));
  assert.ok(plain.includes("mole fraction"));
  assert.ok(plain.includes("mm²/s"));
  assert.ok(plain.includes("Condition differences"));
  assert.ok(plain.includes("Outcome differences"));
  assert.ok(plain.includes("Gas composition (linked group)"));
  assert.ok(plain.includes("Native-unit deltas"));
  assert.ok(plain.includes("Answer citations"));
  assert.ok(plain.includes("Stored locator for FLEX-001 burn time"));
  assert.ok(plain.includes("not-verified"));
  assert.ok(plain.includes("Only finite recorded values are plotted."));
  assert.ok(plain.includes("Recorded differences cannot establish a causal conclusion."));
  assert.ok(plain.includes("Check the complete gas composition before interpreting oxygen."));
  assert.ok(plain.includes("Personal note"));
  assert.ok(plain.includes("not verified"));
});

test("historical snapshots keep their corpus version and resolve locators only from an exact corpus", () => {
  const notebook = historicalNotebook();
  const exported = exportNotebookJson(notebook);
  assert.equal(exported.ok, true);
  const imported = importNotebookFromText(exported.text, { versionContext });
  assert.equal(imported.ok, true, imported.ok ? "" : JSON.stringify(imported));
  assert.deepEqual(imported.notebook.datasetVersions, [historicalVersion]);
  assert.equal(imported.notebook.steps[0].datasetVersion, historicalVersion);
  assert.deepEqual(imported.versionReport.map(({ status }) => status), ["historical-version"]);

  const missing = renderPrintableNotebookHtml(notebook, { versionContext });
  assert.ok(missing.includes(historicalVersion));
  assert.ok(missing.includes("exact corpus not supplied"));
  assert.ok(missing.includes("locators were not re-resolved"));
  assert.ok(missing.includes("historical version"));
  assert.ok(missing.includes("Original snapshots are retained"));
  assert.ok(!missing.includes("historical-locator-marker"));

  const exact = renderPrintableNotebookHtml(notebook, {
    datasets: [historicalDatasetWithMarker()],
    versionContext,
  });
  assert.ok(exact.includes("exact corpus supplied for this report"));
  assert.ok(exact.includes("historical-locator-marker"));
  assert.ok(!exact.includes("locators were not re-resolved"));

  const currentOnly = renderPrintableNotebookHtml(notebook, { datasets: [dataset], versionContext });
  assert.ok(!currentOnly.includes("historical-locator-marker"));
  assert.ok(currentOnly.includes("exact corpus not supplied"));
  assert.equal(imported.notebook.steps[0].datasetVersion, historicalVersion);
  assert.deepEqual(imported.notebook.notes.map(({ noteId }) => noteId), ["note-old-1"]);
});

test("note edits, additions and removals keep snapshots immutable and do not auto-save", () => {
  const notebook = populatedNotebook();
  const before = structuredClone(notebook);
  const beforeSteps = JSON.stringify(notebook.steps);
  const originalNote = notebook.notes[0];

  const edited = editNotebookNote(notebook, "note-1", "Edited personal note text.", { now: later });
  assert.equal(edited.ok, true, edited.ok ? "" : JSON.stringify(edited));
  assert.equal(edited.note.text, "Edited personal note text.");
  assert.equal(edited.note.createdAt, originalNote.createdAt);
  assert.equal(edited.note.updatedAt, later);
  assert.equal(edited.note.classification, "personal-note");
  assert.equal(edited.note.verifiedEvidence, false);
  assert.equal(edited.notebook.updatedAt, later);
  assert.equal(JSON.stringify(edited.notebook.steps), beforeSteps);
  assert.ok(Object.isFrozen(edited.notebook.steps[0]));
  assert.ok(Object.isFrozen(edited.notebook.steps[0].plotResult.points[0]));
  assert.deepEqual(notebook, before);
  assert.deepEqual(edited.notebook.datasetVersions, before.datasetVersions);
  assert.deepEqual(edited.notebook.steps, before.steps);

  const second = createNotebookNote({
    noteId: "note-2",
    text: "A second personal note.",
    createdAt: later,
  });
  const added = addNotebookNote(edited.notebook, second, { now: later });
  assert.equal(added.ok, true);
  assert.equal(added.notebook.notes.length, 2);
  assert.equal(JSON.stringify(added.notebook.steps), beforeSteps);
  assert.equal(added.note.createdAt, later);

  const duplicate = addNotebookNote(added.notebook, second, { now: later });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate-note-id");

  const missing = editNotebookNote(edited.notebook, "note-missing", "text", { now: later });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "note-not-found");

  const tooLong = editNotebookNote(edited.notebook, "note-1", "x".repeat(notebookLimits.maxNoteLength + 1), {
    now: later,
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, "invalid-note");

  const removed = removeNotebookNote(added.notebook, "note-2", { now: later });
  assert.equal(removed.ok, true);
  assert.equal(removed.notebook.notes.length, 1);
  assert.equal(removed.note.noteId, "note-2");
  assert.equal(JSON.stringify(removed.notebook.steps), beforeSteps);

  const removeMissing = removeNotebookNote(removed.notebook, "note-2", { now: later });
  assert.equal(removeMissing.ok, false);
  assert.equal(removeMissing.reason, "note-not-found");

  const fullNotes = Array.from({ length: notebookLimits.maxNotes }, (_, index) => createNotebookNote({
    noteId: `note-bulk-${index}`,
    text: "Bulk note",
    createdAt,
    updatedAt,
  }));
  const fullNotebook = notebookSchema.parse({ ...notebook, notes: fullNotes });
  const noteLimit = addNotebookNote(fullNotebook, createNotebookNote({
    noteId: "note-over-limit",
    text: "Too many notes",
    createdAt: later,
  }), { now: later });
  assert.equal(noteLimit.ok, false);
  assert.equal(noteLimit.reason, "note-limit");
});

test("a notebook beyond the 2 MiB import bound returns a clear export failure", () => {
  const longReceipt = `${"a".repeat(44_000)}.${"a".repeat(43)}`;
  const base = baseNotebook("notebook-big-1");
  const step = answerStepForSize(longReceipt);
  const raw = JSON.parse(JSON.stringify(base));
  raw.steps = Array.from({ length: 50 }, (_, index) => {
    const copy = JSON.parse(JSON.stringify(step));
    copy.stepId = `step-big-${index}`;
    return copy;
  });
  const big = notebookSchema.parse(raw);
  const exported = exportNotebookJson(big);
  assert.equal(exported.ok, false);
  assert.equal(exported.reason, "too-large");
  assert.ok(exported.byteLength > notebookLimits.importMaxBytes);
  assert.ok(exported.message.includes("2 MiB"));
  assert.equal(exported.text, undefined);
});
