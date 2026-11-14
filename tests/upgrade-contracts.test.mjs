import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import {
  answerSnapshotBindingMatches,
  assertNotebookImportBytes,
  assistantActionOutcomeSchema,
  assistantActionRecordSchema,
  assistantActionRequestSchema,
  checkActionContext,
  comparisonNotebookStepSchema,
  comparatorRequestSchema,
  effectiveMatchingPolicy,
  evidenceAnswerSnapshotSchema,
  explanationReceiptSchema,
  getFieldDefinition,
  isDisplayCitationId,
  isNumericFieldKey,
  isUnknownValue,
  matchingToleranceSchema,
  notebookDatasetVersionReport,
  notebookSchema,
  parseNotebook,
  plotResultSchema,
  plotSpecSchema,
  reviewedFieldCatalog,
  resolveStableFieldReference,
  selectedRunsContextResultSchema,
  stableFieldReferenceSchema,
  validateActionAgainstDataset,
  validateComparisonContextRequestAgainstDataset,
  validateNotebookAgainstDataset,
  validatePlotResultAgainstDataset,
  validatePlotSpecAgainstDataset,
} from "../src/lib/upgrades/index.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));
const datasetVersion = dataset.version;
const sourceId = "psi-69-flex-table-v1";
const createdAt = "2025-01-15T19:00:00+08:00";
const updatedAt = "2025-01-15T19:30:00+08:00";

const reference = (runId, fieldKey) => ({ datasetVersion, runId, fieldKey, sourceId });

function scatterSpec(runIds = ["FLEX-001", "FLEX-002"]) {
  return {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: "oxygen" }, y: { field: "burning_rate" } },
    grouping: "none",
    scope: { kind: "explicit-runs", runIds },
  };
}

function scatterResult(runIds = ["FLEX-001", "FLEX-002"]) {
  return {
    version: "plot-result-1",
    specVersion: "plot-spec-1",
    kind: "scatter",
    datasetVersion,
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
      sourceReferences: [reference(runId, "oxygen"), reference(runId, "burning_rate")],
    })),
    omitted: [],
    limitations: ["Only finite recorded values are plotted."],
  };
}

function plotStep(runIds = ["FLEX-001", "FLEX-002"]) {
  return {
    stepId: "step-plot-1",
    createdAt,
    title: "Oxygen and burning rate",
    datasetVersion,
    resolvedRunIds: runIds,
    query: { search: null },
    sourceReferences: runIds.flatMap((runId) => [reference(runId, "oxygen"), reference(runId, "burning_rate")]),
    limitations: ["A plot does not establish a trend or causation."],
    stepType: "plot",
    plotSpec: scatterSpec(runIds),
    plotResult: scatterResult(runIds),
  };
}

function comparisonContext() {
  const runIds = ["FLEX-001", "FLEX-010"];
  return {
    version: "comparison-context-result-1",
    kind: "selected-runs-context",
    datasetVersion,
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
          { runId: "FLEX-001", value: 0.21, original: "0.21", reference: reference("FLEX-001", "oxygen") },
          { runId: "FLEX-010", value: 0.21, original: "0.21", reference: reference("FLEX-010", "oxygen") },
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
          { runId: "FLEX-001", value: 0.79, original: "0.79", reference: reference("FLEX-001", "nitrogen") },
          { runId: "FLEX-010", value: 0.09, original: "0.09", reference: reference("FLEX-010", "nitrogen") },
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
        { runId: "FLEX-001", value: 4.3, original: "4.3", reference: reference("FLEX-001", "burn_time") },
        { runId: "FLEX-010", value: 13.6, original: "13.6", reference: reference("FLEX-010", "burn_time") },
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
      sourceReferences: [reference("FLEX-001", "oxygen"), reference("FLEX-010", "oxygen")],
    }],
    limitations: ["Recorded differences cannot establish a causal conclusion."],
  };
}

function comparisonStep() {
  return {
    stepId: "step-comparison-1",
    createdAt,
    title: "Composition context",
    datasetVersion,
    resolvedRunIds: ["FLEX-001", "FLEX-010"],
    query: { search: null },
    sourceReferences: [
      reference("FLEX-001", "oxygen"),
      reference("FLEX-010", "oxygen"),
      reference("FLEX-001", "burn_time"),
      reference("FLEX-010", "burn_time"),
    ],
    limitations: ["Unknown values never count as matches."],
    stepType: "comparison",
    request: {
      version: "comparison-context-request-1",
      kind: "selected-runs",
      runIds: ["FLEX-001", "FLEX-010"],
      focusCondition: "oxygen",
    },
    context: comparisonContext(),
  };
}

function threeRunComparisonContext() {
  const context = structuredClone(comparisonContext());
  const runId = "FLEX-004";
  const recorded = { oxygen: 0.21, nitrogen: 0.79, burn_time: 7.64 };
  context.request.runIds = [...context.runIds, runId];
  context.runIds = [...context.runIds, runId];
  for (const field of [...context.conditions, ...context.outcomes]) {
    const value = recorded[field.key];
    field.cells.push({
      runId,
      value,
      original: String(value),
      reference: reference(runId, field.key),
    });
  }
  context.gasComposition.values.push({
    runId,
    values: { oxygen: 0.21, nitrogen: 0.79, carbon_dioxide: 0, helium: 0 },
  });
  return context;
}

function answerSnapshot() {
  const citationId = "field:1";
  return {
    datasetVersion,
    datasetSha256: "a".repeat(64),
    comparisonRuleVersion: "1",
    requestQuestion: "What was the burn time?",
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
    receiptVerification: "not-verified",
  };
}

function answerStep() {
  return {
    stepId: "step-answer-1",
    createdAt,
    title: "Validated burn-time answer",
    datasetVersion,
    resolvedRunIds: ["FLEX-001"],
    query: { search: null },
    sourceReferences: [reference("FLEX-001", "burn_time")],
    limitations: ["A generated explanation is not a substitute for source inspection."],
    stepType: "evidence-answer",
    answer: answerSnapshot(),
  };
}

function notebook() {
  return {
    schemaVersion: "notebook-1",
    id: "notebook-fixture-1",
    title: "Oxygen and burn time",
    question: "How does recorded oxygen relate to burn time?",
    createdAt,
    updatedAt,
    datasetVersions: [datasetVersion],
    steps: [plotStep(), comparisonStep(), answerStep()],
    notes: [{
      noteId: "note-1",
      text: "The gas composition must be inspected together.",
      classification: "personal-note",
      verifiedEvidence: false,
      createdAt,
      updatedAt,
    }],
  };
}

function actionContext(overrides = {}) {
  return {
    workspaceId: "workspace-1",
    turnId: "turn-1",
    datasetVersion,
    selectedRunIds: ["FLEX-001", "FLEX-002"],
    selectionRevision: 3,
    ...overrides,
  };
}

test("field catalog matches the reviewed corpus and separates numeric axes", () => {
  assert.equal(reviewedFieldCatalog.datasetVersion, datasetVersion);
  assert.equal(reviewedFieldCatalog.sourceId, sourceId);
  assert.equal(reviewedFieldCatalog.reviewedRunCount, dataset.runs.length);
  assert.equal(reviewedFieldCatalog.fields.length, 11);
  for (const run of dataset.runs) {
    for (const field of run.fields) {
      const definition = getFieldDefinition(field.key);
      assert.equal(definition.label, field.label);
      assert.equal(definition.kind, field.kind);
      assert.equal(definition.nativeUnit, field.unit);
      assert.equal(definition.axisEligible, definition.dataType === "numeric");
    }
  }
  assert.equal(getFieldDefinition("fuel").dataType, "categorical");
  assert.equal(getFieldDefinition("test_end").dataType, "categorical");
  assert.equal(isNumericFieldKey("pressure"), true);
  assert.equal(isNumericFieldKey("fuel"), false);
  assert.equal(isUnknownValue(0), false);
  assert.equal(isUnknownValue(null), true);
  assert.match(getFieldDefinition("extinction_diameter").interpretationNotes.join(" "), /estimated/);
});

test("plot contracts reject invalid axes, duplicate runs and inconsistent counts", () => {
  assert.doesNotThrow(() => plotSpecSchema.parse(scatterSpec()));
  assert.throws(() => plotSpecSchema.parse({
    ...scatterSpec(),
    axes: { x: { field: "fuel" }, y: { field: "burning_rate" } },
  }));
  assert.throws(() => plotSpecSchema.parse({
    ...scatterSpec(),
    axes: { x: { field: "oxygen" }, y: { field: "oxygen" } },
  }));
  assert.throws(() => plotSpecSchema.parse({
    ...scatterSpec(),
    scope: { kind: "explicit-runs", runIds: ["FLEX-001", "FLEX-001"] },
  }));
  assert.doesNotThrow(() => plotResultSchema.parse(scatterResult()));
  assert.throws(() => plotResultSchema.parse({ ...scatterResult(), includedCount: 1 }));
  assert.throws(() => plotResultSchema.parse({ ...scatterResult(), omitted: [{ runId: "FLEX-002", reasons: ["missing-y"] }] }));
  assert.deepEqual(validatePlotSpecAgainstDataset(dataset, scatterSpec()), []);
  assert.equal(validatePlotSpecAgainstDataset(dataset, {
    ...scatterSpec(),
    scope: { kind: "explicit-runs", runIds: ["FLEX-999"] },
  }).length, 1);
  assert.equal(validatePlotResultAgainstDataset(dataset, scatterResult()).length, 0);
  assert.equal(validatePlotResultAgainstDataset(dataset, { ...scatterResult(), datasetVersion: "old" }).length, 1);
});

test("plot results allow a legitimate zero-row scope but reject inconsistent empty counts", () => {
  const empty = {
    ...scatterResult([]),
    scope: {
      kind: "filtered-results",
      search: { investigation: "NO-SUCH-INVESTIGATION" },
      activeFilters: [],
    },
    resolvedRunIds: [],
    includedCount: 0,
    omittedCount: 0,
    points: [],
    omitted: [],
  };
  assert.doesNotThrow(() => plotResultSchema.parse(empty));
  assert.deepEqual(validatePlotResultAgainstDataset(dataset, empty), []);
  assert.throws(() => plotResultSchema.parse({ ...empty, includedCount: 1 }));
  assert.throws(() => plotResultSchema.parse({ ...empty, omittedCount: 1 }));
  assert.throws(() => plotResultSchema.parse({ ...empty, resolvedRunIds: ["FLEX-001"] }));
});

test("comparator requests default to exact matching and reject invalid tolerances", () => {
  const exact = comparatorRequestSchema.parse({
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-001",
    focusCondition: "oxygen",
    candidateScope: { kind: "all-reviewed-runs" },
  });
  assert.deepEqual(effectiveMatchingPolicy(exact), { mode: "exact" });

  const tolerant = comparatorRequestSchema.parse({
    ...exact,
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 0.5 }] },
  });
  assert.equal(effectiveMatchingPolicy(tolerant).mode, "tolerance");
  assert.throws(() => comparatorRequestSchema.parse({
    ...exact,
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: -1 }] },
  }));
  assert.throws(() => comparatorRequestSchema.parse({
    ...exact,
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: Infinity }] },
  }));
  assert.throws(() => matchingToleranceSchema.parse({ field: "pressure", tolerance: Number.NaN }));
  assert.throws(() => comparatorRequestSchema.parse({
    ...exact,
    matching: { mode: "tolerance", tolerances: [{ field: "fuel", tolerance: 0.5 }] },
  }));
  assert.throws(() => comparatorRequestSchema.parse({
    ...exact,
    matching: {
      mode: "tolerance",
      tolerances: [{ field: "pressure", tolerance: 1 }, { field: "pressure", tolerance: 2 }],
    },
  }));
  assert.equal(validateComparisonContextRequestAgainstDataset(dataset, exact).length, 0);
  assert.equal(validateComparisonContextRequestAgainstDataset(dataset, {
    ...exact,
    referenceRunId: "FLEX-999",
  }).length, 1);

  const context = comparisonContext();
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(context));
  const unknownAsMatch = structuredClone(context);
  unknownAsMatch.conditions[0].cells[0].value = null;
  assert.throws(() => selectedRunsContextResultSchema.parse(unknownAsMatch));
  const incompleteGas = structuredClone(context);
  incompleteGas.gasComposition.complete = false;
  assert.throws(() => selectedRunsContextResultSchema.parse(incompleteGas));
});

test("null and zero stay distinct while stable references resolve raw source values", () => {
  const zero = resolveStableFieldReference(dataset, reference("FLEX-001", "carbon_dioxide"));
  assert.equal(zero.status, "resolved");
  assert.equal(zero.field.value, 0);
  assert.equal(zero.field.original, "0");
  assert.equal(zero.source.id, sourceId);

  const unknown = resolveStableFieldReference(dataset, reference("FLEX-009", "diameter"));
  assert.equal(unknown.status, "resolved");
  assert.equal(unknown.field.value, null);
  assert.equal(unknown.field.original, null);

  const stale = resolveStableFieldReference(dataset, {
    ...reference("FLEX-001", "oxygen"),
    datasetVersion: "flex-old-version",
  });
  assert.equal(stale.status, "dataset-version-mismatch");
  assert.equal(isDisplayCitationId("field:1"), true);
  assert.equal(isDisplayCitationId("FLEX-001"), false);
  assert.doesNotThrow(() => stableFieldReferenceSchema.parse(reference("FLEX-001", "oxygen")));
  assert.throws(() => stableFieldReferenceSchema.parse({
    ...reference("FLEX-001", "oxygen"),
    fieldKey: "field:1",
  }));
});

test("notebook parsing is bounded, preserves historical versions and leaves receipts unverified", () => {
  const valid = notebook();
  const parsed = parseNotebook(valid);
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.notes[0].classification, "personal-note");
  assert.equal(parsed.notes[0].verifiedEvidence, false);
  const currentValidation = validateNotebookAgainstDataset(parsed, dataset);
  assert.equal(currentValidation.status, "checked");
  assert.deepEqual(currentValidation.issues, []);
  assert.doesNotThrow(() => explanationReceiptSchema.parse(`abc.${"a".repeat(43)}`));

  assert.throws(() => notebookSchema.parse({ ...valid, title: "x".repeat(161) }));
  assert.throws(() => notebookSchema.parse({ ...valid, question: "x".repeat(2001) }));
  assert.throws(() => notebookSchema.parse({
    ...valid,
    notes: [{ ...valid.notes[0], text: "x".repeat(4001) }],
  }));
  assert.throws(() => notebookSchema.parse({
    ...valid,
    steps: Array.from({ length: 51 }, (_, index) => ({ ...plotStep(), stepId: `step-${index}` })),
  }));
  assert.doesNotThrow(() => assertNotebookImportBytes(2 * 1024 * 1024));
  assert.throws(() => assertNotebookImportBytes(2 * 1024 * 1024 + 1));

  const current = notebookDatasetVersionReport(parsed, { activeDatasetVersion: datasetVersion });
  assert.deepEqual(current.map(({ status }) => status), ["same-version"]);

  const old = structuredClone(valid);
  old.datasetVersions = ["flex-old-version"];
  old.steps[0].datasetVersion = "flex-old-version";
  old.steps[0].plotResult.datasetVersion = "flex-old-version";
  old.steps[0].resolvedRunIds = ["FLEX-999"];
  old.steps[0].plotSpec.scope = { kind: "explicit-runs", runIds: ["FLEX-999"] };
  old.steps[0].plotResult.resolvedRunIds = ["FLEX-999"];
  old.steps[0].plotResult.includedCount = 0;
  old.steps[0].plotResult.omittedCount = 1;
  old.steps[0].plotResult.points = [];
  old.steps[0].plotResult.omitted = [{ runId: "FLEX-999", reasons: ["missing-y"] }];
  old.steps[0].sourceReferences = [];
  old.steps = [old.steps[0]];
  const historical = parseNotebook(old);
  assert.doesNotThrow(() => parseNotebook(old));
  const report = notebookDatasetVersionReport(historical, {
    activeDatasetVersion: datasetVersion,
    availableDatasetVersions: ["flex-old-version"],
  });
  assert.equal(report[0].status, "historical-version");
  assert.equal(notebookDatasetVersionReport(historical, { activeDatasetVersion: datasetVersion })[0].status,
    "unavailable-version");
  const validation = validateNotebookAgainstDataset(historical, dataset);
  assert.equal(validation.status, "version-mismatch");
  assert.deepEqual(validation.issues, []);

  const answer = parsed.steps[2].answer;
  assert.equal(answer.receiptVerification, "not-verified");
  assert.equal(answerSnapshotBindingMatches(answer, {
    requestQuestion: "What was the burn time?",
    question: "What was the burn time?",
    runIds: ["FLEX-001"],
  }), true);
  assert.equal(answerSnapshotBindingMatches(answer, {
    requestQuestion: "What was the burn time?",
    question: "What was the burn time?",
    runIds: ["FLEX-010"],
  }), false);
});

test("comparison results and notebook steps require exact ordered run lists", () => {
  const two = comparisonContext();
  const three = threeRunComparisonContext();
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(two));
  assert.doesNotThrow(() => selectedRunsContextResultSchema.parse(three));

  const extraResult = threeRunComparisonContext();
  extraResult.request.runIds = ["FLEX-001", "FLEX-010"];
  assert.throws(() => selectedRunsContextResultSchema.parse(extraResult));

  assert.doesNotThrow(() => comparisonNotebookStepSchema.parse(comparisonStep()));
  const threeStep = structuredClone(comparisonStep());
  threeStep.context = three;
  threeStep.request = structuredClone(three.request);
  threeStep.resolvedRunIds = [...three.runIds];
  assert.doesNotThrow(() => comparisonNotebookStepSchema.parse(threeStep));

  const reorderedStep = structuredClone(comparisonStep());
  reorderedStep.request.runIds = ["FLEX-010", "FLEX-001"];
  assert.throws(() => comparisonNotebookStepSchema.parse(reorderedStep));

  const lengthMismatchStep = structuredClone(comparisonStep());
  lengthMismatchStep.request.runIds = ["FLEX-001", "FLEX-010", "FLEX-004"];
  assert.throws(() => comparisonNotebookStepSchema.parse(lengthMismatchStep));
});

test("answer snapshots preserve padded submitted questions for exact binding", () => {
  const padded = "  What was the burn time?  ";
  const submitted = { ...answerSnapshot(), requestQuestion: padded };
  const parsed = evidenceAnswerSnapshotSchema.parse(submitted);
  assert.equal(parsed.requestQuestion, padded);
  assert.equal(parsed.question, "What was the burn time?");
  assert.equal(answerSnapshotBindingMatches(parsed, {
    requestQuestion: padded,
    question: "What was the burn time?",
    runIds: ["FLEX-001"],
  }), true);
  assert.equal(answerSnapshotBindingMatches(parsed, {
    requestQuestion: padded.trim(),
    question: "What was the burn time?",
    runIds: ["FLEX-001"],
  }), false);

  const paddedNotebook = notebook();
  paddedNotebook.steps[2].answer = submitted;
  assert.equal(parseNotebook(paddedNotebook).steps[2].answer.requestQuestion, padded);
});

test("assistant actions are allowlisted and bind turn, workspace, dataset and selection", () => {
  const create = {
    version: "assistant-action-1",
    actionId: "action-1",
    context: actionContext(),
    kind: "create_plot",
    plot: scatterSpec(),
  };
  const parsedCreate = assistantActionRequestSchema.parse(create);
  assert.equal(parsedCreate.kind, "create_plot");
  assert.throws(() => assistantActionRequestSchema.parse({ ...create, kind: "run_shell" }));
  assert.throws(() => assistantActionRequestSchema.parse({
    ...create,
    context: { ...actionContext(), datasetVersion: undefined },
  }));
  assert.throws(() => assistantActionRequestSchema.parse({
    ...create,
    context: actionContext({ selectedRunIds: ["FLEX-001", "FLEX-002", "FLEX-003", "FLEX-004"] }),
  }));
  assert.deepEqual(checkActionContext(parsedCreate.context, actionContext()), { status: "current" });
  const stale = checkActionContext(parsedCreate.context, actionContext({
    datasetVersion: "old",
    selectedRunIds: ["FLEX-003"],
    selectionRevision: 4,
  }));
  assert.equal(stale.status, "stale");
  assert.ok(stale.reasons.includes("dataset-version"));
  assert.ok(stale.reasons.includes("selection"));
  assert.ok(stale.reasons.includes("selection-revision"));

  assert.equal(validateActionAgainstDataset(dataset, parsedCreate).length, 0);
  const unknownRun = assistantActionRequestSchema.parse({
    ...create,
    plot: { ...scatterSpec(), scope: { kind: "explicit-runs", runIds: ["FLEX-999"] } },
  });
  assert.equal(validateActionAgainstDataset(dataset, unknownRun).length, 1);

  const prepare = {
    version: "assistant-action-1",
    actionId: "action-2",
    context: actionContext(),
    kind: "prepare_notebook_step",
    step: plotStep(),
  };
  assert.doesNotThrow(() => assistantActionRequestSchema.parse(prepare));
  assert.throws(() => assistantActionRecordSchema.parse({
    status: "executed",
    request: assistantActionRequestSchema.parse(prepare),
    effect: "state-changing",
    approvedAt: null,
    executedAt: updatedAt,
    outcome: { kind: "notebook-step", step: plotStep() },
  }));
  assert.doesNotThrow(() => assistantActionRecordSchema.parse({
    status: "executed",
    request: assistantActionRequestSchema.parse(prepare),
    effect: "state-changing",
    approvedAt: updatedAt,
    executedAt: updatedAt,
    outcome: { kind: "notebook-step", step: plotStep() },
  }));
  assert.throws(() => assistantActionRecordSchema.parse({
    status: "executed",
    request: parsedCreate,
    effect: "read-only",
    approvedAt: updatedAt,
    executedAt: updatedAt,
    outcome: { kind: "plot-result", result: scatterResult() },
  }));
  assert.doesNotThrow(() => assistantActionRecordSchema.parse({
    status: "executed",
    request: parsedCreate,
    effect: "read-only",
    approvedAt: null,
    executedAt: updatedAt,
    outcome: { kind: "plot-result", result: scatterResult() },
  }));
  assert.doesNotThrow(() => assistantActionOutcomeSchema.parse({
    kind: "stale-context",
    reasons: ["selection"],
  }));
});
