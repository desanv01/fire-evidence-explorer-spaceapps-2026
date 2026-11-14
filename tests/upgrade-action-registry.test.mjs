import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import {
  AssistantActionUnavailableError,
  assistantActionRegistry,
  checkAssistantActionContext,
  createAssistantActionContext,
  createLocalAssistantActionApproval,
  dispatchAssistantAction,
  parseAssistantActionRequest,
} from "../src/lib/upgrades/action-registry.ts";

const datasetBytes = await readFile(new URL("../data/flex.json", import.meta.url));
const dataset = parseDataset(JSON.parse(datasetBytes.toString("utf8")));
const datasetVersion = dataset.version;
const datasetSha256 = createHash("sha256").update(datasetBytes).digest("hex");
const approvedAt = "2025-01-15T19:30:00+08:00";
const createdAt = "2025-01-15T19:00:00+08:00";

function run(runId) {
  const found = dataset.runs.find(({ id }) => id === runId);
  assert.ok(found, `fixture corpus must contain ${runId}`);
  return found;
}

function recordedField(runId, fieldKey) {
  const field = run(runId).fields.find(({ key }) => key === fieldKey);
  assert.ok(field, `fixture run ${runId} must record ${fieldKey}`);
  return field;
}

function recordedValue(runId, fieldKey) {
  return recordedField(runId, fieldKey).value;
}

function reference(runId, fieldKey) {
  const field = recordedField(runId, fieldKey);
  return {
    datasetVersion,
    runId,
    fieldKey,
    sourceId: field.sourceId,
  };
}

function cell(runId, fieldKey) {
  const field = recordedField(runId, fieldKey);
  return {
    runId,
    value: field.value,
    original: field.original,
    reference: reference(runId, fieldKey),
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
    resolvedRunIds: [...runIds],
    includedCount: runIds.length,
    omittedCount: 0,
    points: runIds.map((runId) => ({
      runId,
      x: recordedValue(runId, "oxygen"),
      y: recordedValue(runId, "burning_rate"),
      group: null,
      sourceReferences: [reference(runId, "oxygen"), reference(runId, "burning_rate")],
    })),
    omitted: [],
    limitations: ["Only runs with finite recorded values are included; no value is interpolated."],
  };
}

function createPlotAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-plot-1",
    context: actionContext(),
    kind: "create_plot",
    plot: scatterSpec(),
    ...overrides,
  };
}

function comparisonContext(runIds = ["FLEX-001", "FLEX-010"]) {
  const [first, second] = runIds;
  const gasKeys = ["oxygen", "nitrogen", "carbon_dioxide", "helium"];
  const gasCells = (runId) => Object.fromEntries(gasKeys.map((key) => [key, recordedValue(runId, key)]));
  const firstGas = gasCells(first);
  const secondGas = gasCells(second);
  const gasComplete = gasKeys.every((key) => firstGas[key] !== null && secondGas[key] !== null);
  const difference = (fieldKey) => recordedValue(second, fieldKey) - recordedValue(first, fieldKey);

  return {
    version: "comparison-context-result-1",
    kind: "selected-runs-context",
    datasetVersion,
    comparisonRuleVersion: "1",
    contextRuleVersion: "comparison-context-1",
    request: {
      version: "comparison-context-request-1",
      kind: "selected-runs",
      runIds: [...runIds],
      focusCondition: "oxygen",
    },
    runIds: [...runIds],
    conditions: [
      {
        key: "oxygen",
        label: "Initial ambient oxygen",
        kind: "condition",
        status: "same",
        unit: "mole fraction",
        cells: [cell(first, "oxygen"), cell(second, "oxygen")],
        deltas: [],
        reason: "Recorded values match exactly.",
      },
      {
        key: "nitrogen",
        label: "Initial ambient nitrogen",
        kind: "condition",
        status: "different",
        unit: "mole fraction",
        cells: [cell(first, "nitrogen"), cell(second, "nitrogen")],
        deltas: [{
          fromRunId: first,
          toRunId: second,
          delta: difference("nitrogen"),
          unit: "mole fraction",
          provenanceClass: "deterministic-derived",
          ruleVersion: "native-delta-1",
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
      cells: [cell(first, "burn_time"), cell(second, "burn_time")],
      deltas: [{
        fromRunId: first,
        toRunId: second,
        delta: difference("burn_time"),
        unit: "s",
        provenanceClass: "deterministic-derived",
        ruleVersion: "native-delta-1",
      }],
      reason: "Recorded values differ.",
    }],
    gasComposition: {
      fieldKeys: gasKeys,
      complete: gasComplete,
      values: [
        { runId: first, values: firstGas },
        { runId: second, values: secondGas },
      ],
      differences: [{
        fromRunId: first,
        toRunId: second,
        values: gasKeys.map((key) => ({
          key,
          delta: secondGas[key] - firstGas[key],
          unit: "mole fraction",
        })),
      }],
      limitation: "Gas fractions are linked. Inspect the complete recorded composition; a difference in oxygen alone does not establish an isolated oxygen effect.",
    },
    evidence: [{
      category: "recorded-observation",
      text: "The selected runs report the same ambient oxygen fraction.",
      fieldKeys: ["oxygen"],
      sourceReferences: [reference(first, "oxygen"), reference(second, "oxygen")],
    }],
    limitations: ["Recorded differences cannot establish a causal conclusion."],
  };
}

function explainContextAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-context-1",
    context: actionContext({ selectedRunIds: ["FLEX-001", "FLEX-010"] }),
    kind: "explain_comparison_context",
    request: {
      version: "comparison-context-request-1",
      kind: "selected-runs",
      runIds: ["FLEX-001", "FLEX-010"],
      focusCondition: "oxygen",
    },
    ...overrides,
  };
}

function comparatorSearchResult() {
  const comparatorRequest = {
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-001",
    focusCondition: "pressure",
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-010"] },
  };
  return {
    version: "comparator-search-1",
    kind: "comparator-search",
    datasetVersion,
    comparisonRuleVersion: "1",
    contextRuleVersion: "comparison-context-1",
    request: comparatorRequest,
    matching: { mode: "exact" },
    candidateScope: comparatorRequest.candidateScope,
    resolvedCandidateRunIds: ["FLEX-010"],
    activeFilters: [],
    evaluatedCount: 1,
    outcome: {
      kind: "eligible-match",
      candidates: [{
        runId: "FLEX-010",
        disposition: "eligible",
        context: comparisonContext(["FLEX-001", "FLEX-010"]),
        mismatchedFieldKeys: [],
        unknownFieldKeys: [],
        incompatibleFieldKeys: [],
        limitations: [],
      }],
    },
    limitations: ["No eligible match is never presented as a nearest candidate."],
  };
}

function findComparatorsAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-comparator-1",
    context: actionContext({ selectedRunIds: ["FLEX-001"] }),
    kind: "find_comparators",
    request: {
      version: "comparison-context-request-1",
      kind: "comparator",
      referenceRunId: "FLEX-001",
      focusCondition: "pressure",
      candidateScope: { kind: "explicit-runs", runIds: ["FLEX-010"] },
    },
    ...overrides,
  };
}

function plotNotebookStep() {
  return {
    stepId: "step-plot-1",
    createdAt,
    title: "Oxygen and burning rate",
    datasetVersion,
    resolvedRunIds: ["FLEX-001", "FLEX-002"],
    query: { search: null },
    sourceReferences: [
      reference("FLEX-001", "oxygen"),
      reference("FLEX-001", "burning_rate"),
      reference("FLEX-002", "oxygen"),
      reference("FLEX-002", "burning_rate"),
    ],
    limitations: ["A plot does not establish a trend or causation."],
    stepType: "plot",
    plotSpec: scatterSpec(),
    plotResult: scatterResult(),
  };
}

function answerSnapshot() {
  const citationId = "field:1";
  const burnTime = recordedField("FLEX-001", "burn_time");
  return {
    datasetVersion,
    datasetSha256,
    comparisonRuleVersion: "1",
    requestQuestion: "What burn time did FLEX-001 record?",
    question: "What burn time did FLEX-001 record?",
    runIds: ["FLEX-001"],
    packetVersion: 1,
    packet: {
      scope: "selected-runs",
      evidence: [{
        id: citationId,
        status: "reported",
        text: "Recorded burn time for FLEX-001.",
        numbers: [{ label: "Burn time (FLEX-001)", value: burnTime.value, unit: "s" }],
      }],
      limitations: ["A recorded value does not establish an isolated cause."],
    },
    citations: {
      [citationId]: {
        fieldKey: "burn_time",
        sources: [{
          runId: "FLEX-001",
          sourceId: burnTime.sourceId,
          locator: burnTime.locator,
        }],
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
        measurements: [{
          label: "Burn time (FLEX-001)",
          value: burnTime.value,
          unit: "s",
          citationId,
        }],
      }],
      model: null,
    },
    explanationReceipt: `abc.${"a".repeat(43)}`,
    receiptVerification: "not-verified",
  };
}

function answerNotebookStep() {
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

function preparePlotAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-notebook-1",
    context: actionContext(),
    kind: "prepare_notebook_step",
    step: plotNotebookStep(),
    ...overrides,
  };
}

function prepareAnswerAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-answer-1",
    context: actionContext({ selectedRunIds: ["FLEX-001"] }),
    kind: "prepare_notebook_step",
    step: answerNotebookStep(),
    ...overrides,
  };
}

function fixtures() {
  const calls = {
    create_plot: 0,
    explain_comparison_context: 0,
    find_comparators: 0,
    prepare_notebook_step: 0,
  };
  const seen = [];
  const handlers = {
    create_plot: ({ request, dataset: activeDataset }) => {
      calls.create_plot += 1;
      seen.push({ kind: "create_plot", request, datasetVersion: activeDataset.version });
      return scatterResult(request.plot.scope.runIds);
    },
    explain_comparison_context: ({ request }) => {
      calls.explain_comparison_context += 1;
      return comparisonContext(request.request.runIds);
    },
    find_comparators: () => {
      calls.find_comparators += 1;
      return comparatorSearchResult();
    },
    prepare_notebook_step: ({ request }) => {
      calls.prepare_notebook_step += 1;
      return request.step;
    },
  };
  return { calls, seen, handlers };
}

function dispatch(action, fixture, options = {}) {
  const proposedContext = action && typeof action === "object" && action.context
    ? action.context
    : actionContext();
  return dispatchAssistantAction({
    action,
    dataset,
    activeContext: proposedContext,
    handlers: fixture.handlers,
    ...options,
  });
}

test("a valid read-only action reaches its explicitly typed fixture handler once", async () => {
  const fixture = fixtures();
  const action = createPlotAction();
  const result = await dispatch(action, fixture);

  assert.equal(result.handlerInvoked, true);
  assert.equal(fixture.calls.create_plot, 1);
  assert.equal(result.outcome.kind, "plot-result");
  assert.deepEqual(result.outcome.result.resolvedRunIds, ["FLEX-001", "FLEX-002"]);
  assert.deepEqual(fixture.seen[0].request.plot, scatterSpec());
  assert.equal(fixture.seen[0].datasetVersion, datasetVersion);
  assert.equal(assistantActionRegistry.create_plot.effect, "read-only");
  assert.equal(assistantActionRegistry.create_plot.requiresUserApproval, false);
  // A read-only action needs no approval object.
  assert.equal(result.request?.kind, "create_plot");
});

test("stale selection or turn rejects without invoking a handler", async () => {
  const action = createPlotAction();

  const staleSelectionFixture = fixtures();
  const staleSelection = await dispatch(action, staleSelectionFixture, {
    activeContext: actionContext({
      selectedRunIds: ["FLEX-003"],
      selectionRevision: 4,
    }),
  });
  assert.equal(staleSelection.outcome.kind, "stale-context");
  assert.ok(staleSelection.outcome.reasons.includes("selection"));
  assert.ok(staleSelection.outcome.reasons.includes("selection-revision"));
  assert.equal(staleSelection.handlerInvoked, false);
  assert.equal(staleSelectionFixture.calls.create_plot, 0);

  const staleTurnFixture = fixtures();
  const staleTurn = await dispatch(action, staleTurnFixture, {
    activeContext: actionContext({ turnId: "turn-2" }),
  });
  assert.equal(staleTurn.outcome.kind, "stale-context");
  assert.deepEqual(staleTurn.outcome.reasons, ["turn"]);
  assert.equal(staleTurn.handlerInvoked, false);
  assert.equal(staleTurnFixture.calls.create_plot, 0);

  const staleCorpusFixture = fixtures();
  const staleCorpus = await dispatch(action, staleCorpusFixture, {
    activeContext: actionContext({ datasetVersion: "flex-old-version" }),
  });
  assert.equal(staleCorpus.outcome.kind, "stale-context");
  assert.deepEqual(staleCorpus.outcome.reasons, ["dataset-version"]);
  assert.equal(staleCorpus.handlerInvoked, false);
  assert.equal(staleCorpusFixture.calls.create_plot, 0);

  assert.equal(checkAssistantActionContext(actionContext(), actionContext()).status, "current");
});

test("an unapproved notebook mutation never reaches its handler", async () => {
  const fixture = fixtures();
  const action = preparePlotAction();

  const unapproved = await dispatch(action, fixture);
  assert.equal(unapproved.handlerInvoked, false);
  assert.equal(unapproved.outcome.kind, "invalid");
  assert.equal(unapproved.outcome.code, "invalid-action");
  assert.ok(unapproved.outcome.issues.some(({ path }) => path === "approval"));
  assert.equal(fixture.calls.prepare_notebook_step, 0);

  const otherAction = preparePlotAction({ actionId: "action-notebook-2" });
  const mismatched = await dispatch(action, fixture, {
    approval: createLocalAssistantActionApproval(otherAction, approvedAt),
  });
  assert.equal(mismatched.handlerInvoked, false);
  assert.equal(mismatched.outcome.kind, "invalid");
  assert.equal(fixture.calls.prepare_notebook_step, 0);

  // A provider-shaped approval document cannot pass: only the in-memory
  // factory brand created by a local confirmation is accepted.
  const forgedApproval = {
    actionId: action.actionId,
    request: action,
    approvedAt,
    approvalSource: "local-user-confirmation",
  };
  const forged = await dispatch(action, fixture, { approval: forgedApproval });
  assert.equal(forged.handlerInvoked, false);
  assert.equal(forged.outcome.kind, "invalid");
  assert.equal(fixture.calls.prepare_notebook_step, 0);

  const approval = createLocalAssistantActionApproval(action, approvedAt);
  const approved = await dispatch(action, fixture, { approval });
  assert.equal(approved.handlerInvoked, true);
  assert.equal(approved.outcome.kind, "notebook-step");
  assert.equal(fixture.calls.prepare_notebook_step, 1);
});

test("unknown operations, unknown fields and invalid runs are rejected before handlers", async () => {
  const unknownOperationFixture = fixtures();
  const unknownOperation = await dispatch({ ...createPlotAction(), kind: "run_shell" }, unknownOperationFixture);
  assert.equal(unknownOperation.outcome.kind, "invalid");
  assert.equal(unknownOperation.outcome.code, "invalid-action");
  assert.equal(unknownOperation.request, null);
  assert.equal(unknownOperationFixture.calls.create_plot, 0);

  const unknownFieldFixture = fixtures();
  const unknownField = await dispatch({
    ...createPlotAction(),
    tool: "shell",
    url: "https://example.invalid/run",
  }, unknownFieldFixture);
  assert.equal(unknownField.outcome.kind, "invalid");
  assert.equal(unknownField.request, null);
  assert.equal(unknownFieldFixture.calls.create_plot, 0);

  const invalidRunFixture = fixtures();
  const invalidRun = await dispatch(
    createPlotAction({ plot: scatterSpec(["FLEX-999"]) }),
    invalidRunFixture,
  );
  assert.equal(invalidRun.handlerInvoked, false);
  assert.equal(invalidRun.outcome.kind, "invalid");
  assert.equal(invalidRun.outcome.code, "unknown-run");
  assert.equal(invalidRunFixture.calls.create_plot, 0);
});

test("evidence-answer steps require a matching trusted current snapshot", async () => {
  const action = prepareAnswerAction();
  const approval = createLocalAssistantActionApproval(action, approvedAt);
  const missingFixture = fixtures();

  const missing = await dispatch(action, missingFixture, { approval });
  assert.equal(missing.handlerInvoked, false);
  assert.equal(missing.outcome.kind, "invalid");
  assert.equal(missing.outcome.code, "invalid-context");
  assert.ok(missing.outcome.issues.some(({ path }) => path.startsWith("trustedAnswerSnapshot")));
  assert.equal(missingFixture.calls.prepare_notebook_step, 0);

  const snapshot = answerSnapshot();
  const validFixture = fixtures();
  const valid = await dispatch(action, validFixture, {
    approval,
    trustedAnswerSnapshot: snapshot,
    activeDatasetSha256: datasetSha256,
  });
  assert.equal(valid.handlerInvoked, true);
  assert.equal(valid.outcome.kind, "notebook-step");
  assert.equal(validFixture.calls.prepare_notebook_step, 1);

  const tamperedFixture = fixtures();
  const tampered = await dispatch(action, tamperedFixture, {
    approval,
    trustedAnswerSnapshot: { ...snapshot, question: "A different question" },
  });
  assert.equal(tampered.handlerInvoked, false);
  assert.equal(tampered.outcome.kind, "invalid");
  assert.equal(tamperedFixture.calls.prepare_notebook_step, 0);

  const wrongHashFixture = fixtures();
  const wrongHash = await dispatch(action, wrongHashFixture, {
    approval,
    trustedAnswerSnapshot: snapshot,
    activeDatasetSha256: "0".repeat(64),
  });
  assert.equal(wrongHash.handlerInvoked, false);
  assert.equal(wrongHash.outcome.kind, "invalid");
  assert.equal(wrongHashFixture.calls.prepare_notebook_step, 0);
});

test("handler results are shape- and reference-checked before return", async () => {
  const malformedFixture = fixtures();
  malformedFixture.handlers.create_plot = ({ request }) => ({
    ...scatterResult(request.plot.scope.runIds),
    limitations: [],
  });
  const malformed = await dispatch(createPlotAction(), malformedFixture);
  assert.equal(malformed.handlerInvoked, true);
  assert.equal(malformed.outcome.kind, "invalid");
  assert.equal(malformed.outcome.code, "invalid-plot");

  const fabricatedFixture = fixtures();
  fabricatedFixture.handlers.create_plot = ({ request }) => {
    const result = scatterResult(request.plot.scope.runIds);
    result.points[0].y += 1;
    return result;
  };
  const fabricated = await dispatch(createPlotAction(), fabricatedFixture);
  assert.equal(fabricated.handlerInvoked, true);
  assert.equal(fabricated.outcome.kind, "invalid");
  assert.equal(fabricated.outcome.code, "invalid-plot");
  assert.ok(fabricated.outcome.issues.some(({ message }) => /recorded burning_rate/.test(message)));

  const tamperedComparisonFixture = fixtures();
  tamperedComparisonFixture.handlers.explain_comparison_context = ({ request }) => {
    const result = comparisonContext(request.request.runIds);
    result.conditions[1].cells[0].value = 0.8; // Nitrogen is recorded as 0.79.
    return result;
  };
  const tamperedComparison = await dispatch(explainContextAction(), tamperedComparisonFixture);
  assert.equal(tamperedComparison.handlerInvoked, true);
  assert.equal(tamperedComparison.outcome.kind, "invalid");
  assert.equal(tamperedComparison.outcome.code, "invalid-context");
  assert.ok(tamperedComparison.outcome.issues.some(({ message }) => /recorded source value/.test(message)));
});

test("comparison and comparator actions validate and reach their handlers once", async () => {
  const fixture = fixtures();

  const contextResult = await dispatch(explainContextAction(), fixture);
  assert.equal(contextResult.handlerInvoked, true);
  assert.equal(contextResult.outcome.kind, "comparison-context");
  assert.equal(fixture.calls.explain_comparison_context, 1);

  const comparatorResult = await dispatch(findComparatorsAction(), fixture);
  assert.equal(comparatorResult.handlerInvoked, true);
  assert.equal(comparatorResult.outcome.kind, "comparator-search");
  assert.equal(fixture.calls.find_comparators, 1);
});

test("unavailable corpus or missing engine yields an unavailable outcome", async () => {
  const action = createPlotAction();

  const nullDatasetFixture = fixtures();
  const nullDataset = await dispatch(action, nullDatasetFixture, { dataset: null });
  assert.equal(nullDataset.handlerInvoked, false);
  assert.equal(nullDataset.outcome.kind, "unavailable");
  assert.equal(nullDataset.outcome.code, "service-unavailable");
  assert.equal(nullDatasetFixture.calls.create_plot, 0);

  const missingEngineFixture = fixtures();
  delete missingEngineFixture.handlers.create_plot;
  const missingEngine = await dispatch(action, missingEngineFixture);
  assert.equal(missingEngine.handlerInvoked, false);
  assert.equal(missingEngine.outcome.kind, "unavailable");
  assert.equal(missingEngine.outcome.code, "service-unavailable");

  const typedUnavailableFixture = fixtures();
  typedUnavailableFixture.handlers.create_plot = () => {
    throw new AssistantActionUnavailableError(
      "provider-disabled",
      "Provider-backed actions are disabled in this phase.",
    );
  };
  const typedUnavailable = await dispatch(action, typedUnavailableFixture);
  assert.equal(typedUnavailable.handlerInvoked, true);
  assert.equal(typedUnavailable.outcome.kind, "unavailable");
  assert.equal(typedUnavailable.outcome.code, "provider-disabled");
});

test("parse and context helpers stay closed and ordered", () => {
  const parsed = parseAssistantActionRequest(createPlotAction());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.kind, "create_plot");
  assert.equal(parseAssistantActionRequest({ kind: "provider_tool" }).ok, false);

  assert.throws(() => createAssistantActionContext({
    workspaceId: "workspace-1",
    turnId: "turn-1",
    datasetVersion,
    selectedRunIds: ["FLEX-001", "FLEX-002", "FLEX-003", "FLEX-004"],
    selectionRevision: 1,
  }));

  const context = createAssistantActionContext({
    workspaceId: "workspace-1",
    turnId: "turn-1",
    datasetVersion,
    selectedRunIds: ["FLEX-002", "FLEX-001"],
    selectionRevision: 1,
  });
  const reversed = checkAssistantActionContext(context, actionContext({
    selectedRunIds: ["FLEX-001", "FLEX-002"],
    selectionRevision: 1,
  }));
  assert.equal(reversed.status, "stale");
  assert.deepEqual(reversed.reasons, ["selection"]);
});
