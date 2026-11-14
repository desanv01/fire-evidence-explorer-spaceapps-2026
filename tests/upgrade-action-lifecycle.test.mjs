import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { suggestAssistantAction } from "../src/lib/deepseek.ts";
import { parseDataset } from "../src/lib/evidence.ts";
import { createLocalAssistantActionApproval } from "../src/lib/upgrades/action-registry.ts";
import { buildAssistantActionCard } from "../src/lib/upgrades/action-cards.ts";
import {
  createAssistantActionLifecycle,
  createEngineActionHandlers,
} from "../src/lib/upgrades/action-lifecycle.ts";
import { buildPlotResult } from "../src/lib/upgrades/plot-engine.ts";
import { buildSelectedRunsContext, searchComparators } from "../src/lib/upgrades/comparison-engine.ts";
import {
  createEvidenceAnswerNotebookStep,
  createPlotNotebookStep,
} from "../src/lib/upgrades/notebook-engine.ts";

const datasetBytes = await readFile(new URL("../data/flex.json", import.meta.url));
const dataset = parseDataset(JSON.parse(datasetBytes.toString("utf8")));
const datasetVersion = dataset.version;
const datasetSha256 = createHash("sha256").update(datasetBytes).digest("hex");
const fixedNow = "2026-11-12T22:30:00+08:00";

function field(runId, fieldKey) {
  const run = dataset.runs.find(({ id }) => id === runId);
  assert.ok(run, `fixture dataset must include ${runId}`);
  const result = run.fields.find(({ key }) => key === fieldKey);
  assert.ok(result, `fixture dataset must record ${runId}/${fieldKey}`);
  return result;
}

function reference(runId, fieldKey) {
  const recorded = field(runId, fieldKey);
  return {
    datasetVersion,
    runId,
    fieldKey,
    sourceId: recorded.sourceId,
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

function plotSpec(runIds = ["FLEX-001", "FLEX-002"]) {
  return {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: "oxygen" }, y: { field: "burning_rate" } },
    grouping: "none",
    scope: { kind: "explicit-runs", runIds },
  };
}

function createPlotAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-plot-1",
    context: actionContext(),
    kind: "create_plot",
    plot: plotSpec(),
    ...overrides,
  };
}

function comparisonRequest(overrides = {}) {
  return {
    version: "comparison-context-request-1",
    kind: "selected-runs",
    runIds: ["FLEX-001", "FLEX-004"],
    focusCondition: "pressure",
    ...overrides,
  };
}

function comparisonAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-context-1",
    context: actionContext({ selectedRunIds: ["FLEX-001", "FLEX-004"] }),
    kind: "explain_comparison_context",
    request: comparisonRequest(),
    ...overrides,
  };
}

function comparatorRequest(overrides = {}) {
  return {
    version: "comparison-context-request-1",
    kind: "comparator",
    referenceRunId: "FLEX-001",
    focusCondition: "pressure",
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-004"] },
    ...overrides,
  };
}

function comparatorAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-comparator-1",
    context: actionContext({ selectedRunIds: ["FLEX-001", "FLEX-004"] }),
    kind: "find_comparators",
    request: comparatorRequest(),
    ...overrides,
  };
}

function plotStep() {
  const spec = plotSpec();
  const result = buildPlotResult(dataset, spec);
  return createPlotNotebookStep({
    stepId: "step-plot-1",
    title: "Oxygen and burning rate",
    createdAt: fixedNow,
    plotSpec: spec,
    plotResult: result,
  });
}

function prepareAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-notebook-1",
    context: actionContext(),
    kind: "prepare_notebook_step",
    step: plotStep(),
    ...overrides,
  };
}

function answerSnapshot() {
  const citationId = "field:1";
  const burnTime = field("FLEX-001", "burn_time");
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

function answerPrepareAction(overrides = {}) {
  return {
    version: "assistant-action-1",
    actionId: "action-answer-1",
    context: actionContext({ selectedRunIds: ["FLEX-001"] }),
    kind: "prepare_notebook_step",
    step: createEvidenceAnswerNotebookStep({
      stepId: "step-answer-1",
      title: "Validated burn-time answer",
      createdAt: fixedNow,
      answer: answerSnapshot(),
    }),
    ...overrides,
  };
}

function stateLifecycle(overrides = {}) {
  const state = {
    dataset,
    context: actionContext(),
    ...overrides.state,
  };
  const callLog = {
    plot: 0,
    comparison: 0,
    comparator: 0,
    notebook: 0,
  };
  const handlers = overrides.handlers ?? createEngineActionHandlers();
  const lifecycle = createAssistantActionLifecycle({
    getDataset: overrides.getDataset ?? (() => state.dataset),
    readActiveContext: overrides.readActiveContext ?? (() => state.context),
    handlers: {
      ...handlers,
      create_plot: (input) => {
        callLog.plot += 1;
        return handlers.create_plot(input);
      },
      explain_comparison_context: (input) => {
        callLog.comparison += 1;
        return handlers.explain_comparison_context(input);
      },
      find_comparators: (input) => {
        callLog.comparator += 1;
        return handlers.find_comparators(input);
      },
      prepare_notebook_step: (input) => {
        callLog.notebook += 1;
        return handlers.prepare_notebook_step(input);
      },
    },
    now: overrides.now ?? (() => fixedNow),
    onRecord: overrides.onRecord,
  });
  return { lifecycle, state, callLog };
}

test("real plot engine dispatch produces one executed card with evidence", async () => {
  const { lifecycle, callLog } = stateLifecycle();
  const action = createPlotAction();
  const proposed = lifecycle.propose(action);
  assert.equal(proposed.ok, true);
  assert.equal(proposed.card.phase, "proposed");
  assert.equal(proposed.card.canExecute, true);
  assert.equal(proposed.card.record.status, "proposed");
  assert.deepEqual(proposed.card.context, action.context);

  const execution = await lifecycle.execute(action.actionId);
  assert.equal(execution.status, "executed");
  assert.equal(execution.outcome?.kind, "plot-result");
  assert.equal(execution.handlerInvoked, true);
  assert.equal(execution.applied, true);
  assert.equal(execution.replayed, false);
  assert.equal(callLog.plot, 1);
  assert.equal(execution.record.status, "executed");
  assert.equal(execution.card.phase, "executed");
  assert.equal(execution.card.content?.kind, "plot");
  assert.equal(execution.card.content?.empty, false);
  assert.equal(execution.card.content?.pointCount, 2);
  assert.ok(execution.card.sourceReferences.length >= 4);
  assert.ok(execution.card.limitations.length >= 1);

  const replay = await lifecycle.execute(action.actionId);
  assert.equal(replay.status, "executed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.handlerInvoked, true);
  assert.equal(callLog.plot, 1);
  assert.equal(replay.record.executedAt, execution.record.executedAt);
});

test("a valid zero-row plot is a normal empty card, not an unavailable outcome", async () => {
  const action = createPlotAction({
    actionId: "action-empty-plot",
    plot: {
      ...plotSpec(),
      scope: {
        kind: "filtered-results",
        search: { investigation: "NO-SUCH-INVESTIGATION" },
      },
    },
  });
  const expected = buildPlotResult(dataset, action.plot);
  assert.equal(expected.resolvedRunIds.length, 0);
  assert.equal(expected.includedCount, 0);

  const { lifecycle, callLog } = stateLifecycle();
  assert.equal(lifecycle.propose(action).ok, true);
  const execution = await lifecycle.execute(action.actionId);
  assert.equal(execution.status, "executed");
  assert.equal(execution.outcome?.kind, "plot-result");
  assert.equal(execution.card.content?.kind, "plot");
  assert.equal(execution.card.content?.empty, true);
  assert.equal(execution.card.empty, true);
  assert.equal(execution.card.content?.result.resolvedRunIds.length, 0);
  assert.equal(execution.card.summary.includes("no runs matched"), true);
  assert.ok(execution.card.limitations.length >= 1);
  assert.equal(callLog.plot, 1);
});

test("trusted notebook confirmation is idempotent and requires local approval", async () => {
  const action = prepareAction();
  const { lifecycle, callLog } = stateLifecycle();
  assert.equal(lifecycle.propose(action).ok, true);

  const unapproved = await lifecycle.confirm(action.actionId);
  assert.equal(unapproved.status, "rejected");
  assert.equal(unapproved.outcome?.kind, "invalid");
  assert.equal(unapproved.handlerInvoked, false);
  assert.equal(unapproved.record.status, "proposed");
  assert.equal(callLog.notebook, 0);

  const forged = {
    actionId: action.actionId,
    request: action,
    approvedAt: fixedNow,
    approvalSource: "local-user-confirmation",
  };
  const forgedResult = await lifecycle.confirm(action.actionId, forged);
  assert.equal(forgedResult.status, "rejected");
  assert.equal(forgedResult.outcome?.kind, "invalid");
  assert.equal(callLog.notebook, 0);

  const approval = createLocalAssistantActionApproval(action, fixedNow);
  const [first, duplicate] = await Promise.all([
    lifecycle.confirm(action.actionId, approval),
    lifecycle.confirm(action.actionId, approval),
  ]);
  assert.equal(first.status, "executed");
  assert.equal(first.outcome?.kind, "notebook-step");
  assert.equal(first.applied, true);
  assert.equal(first.handlerInvoked, true);
  assert.equal(first.record.status, "executed");
  assert.equal(first.card.content?.kind, "notebook-step");
  assert.ok(first.card.sourceReferences.length > 0);
  assert.ok(first.card.limitations.length > 0);
  assert.equal(callLog.notebook, 1);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.record.executedAt, first.record.executedAt);

  const after = await lifecycle.confirm(action.actionId, approval);
  assert.equal(after.applied, false);
  assert.equal(after.replayed, true);
  assert.equal(callLog.notebook, 1);
});

test("a stale context after an async handler suppresses the late plot outcome", async () => {
  let resolveHandler;
  let handlerSignal;
  const deferred = new Promise((resolve) => { resolveHandler = resolve; });
  const { lifecycle, state, callLog } = stateLifecycle({
    handlers: {
      ...createEngineActionHandlers(),
      create_plot: ({ signal }) => {
        handlerSignal = signal;
        return deferred;
      },
    },
  });
  const action = createPlotAction({ actionId: "action-stale-plot" });
  assert.equal(lifecycle.propose(action).ok, true);
  const pending = lifecycle.execute(action.actionId);
  assert.equal(callLog.plot, 1);
  assert.equal(handlerSignal.aborted, false);

  state.context = actionContext({
    selectedRunIds: ["FLEX-003", "FLEX-004"],
    selectionRevision: 4,
  });
  resolveHandler(buildPlotResult(dataset, action.plot));
  const execution = await pending;
  assert.equal(execution.status, "executed");
  assert.equal(execution.outcome?.kind, "stale-context");
  assert.ok(execution.outcome?.reasons.includes("selection"));
  assert.ok(execution.outcome?.reasons.includes("selection-revision"));
  assert.equal(execution.card.content, null);
  assert.equal(execution.card.notice.includes("no longer matches"), true);
  assert.equal(execution.handlerInvoked, true);
  assert.equal(callLog.plot, 1);
});

test("a stale confirmation never applies a late notebook step", async () => {
  let resolveHandler;
  const deferred = new Promise((resolve) => { resolveHandler = resolve; });
  const { lifecycle, state, callLog } = stateLifecycle({
    handlers: {
      ...createEngineActionHandlers(),
      prepare_notebook_step: () => deferred,
    },
  });
  const action = prepareAction({ actionId: "action-stale-notebook" });
  assert.equal(lifecycle.propose(action).ok, true);
  const approval = createLocalAssistantActionApproval(action, fixedNow);
  const pending = lifecycle.confirm(action.actionId, approval);
  assert.equal(callLog.notebook, 1);

  state.context = actionContext({
    selectedRunIds: ["FLEX-003", "FLEX-004"],
    selectionRevision: 4,
  });
  resolveHandler(action.step);
  const execution = await pending;
  assert.equal(execution.status, "executed");
  assert.equal(execution.outcome?.kind, "stale-context");
  assert.equal(execution.card.content, null);
  assert.equal(execution.record.status, "executed");
  assert.equal(execution.record.approvedAt, fixedNow);
  assert.equal(execution.handlerInvoked, true);
  assert.equal(callLog.notebook, 1);
});

test("cancellation aborts the signal and never applies a late notebook mutation", async () => {
  let resolveHandler;
  let handlerSignal;
  const deferred = new Promise((resolve) => { resolveHandler = resolve; });
  const { lifecycle, callLog } = stateLifecycle({
    handlers: {
      ...createEngineActionHandlers(),
      prepare_notebook_step: ({ signal }) => {
        handlerSignal = signal;
        return deferred;
      },
    },
  });
  const action = prepareAction({ actionId: "action-cancel-notebook" });
  assert.equal(lifecycle.propose(action).ok, true);
  const approval = createLocalAssistantActionApproval(action, fixedNow);

  const pending = lifecycle.confirm(action.actionId, approval);
  assert.equal(callLog.notebook, 1);
  assert.equal(handlerSignal.aborted, false);
  const cancelled = lifecycle.cancel(action.actionId, "User cancelled the review");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.record.status, "cancelled");
  assert.equal(cancelled.card.phase, "cancelled");
  assert.equal(cancelled.applied, true);
  assert.equal(handlerSignal.aborted, true);

  resolveHandler(action.step);
  const execution = await pending;
  assert.equal(execution.status, "cancelled");
  assert.equal(execution.outcome, null);
  assert.equal(execution.card.content, null);
  assert.equal(execution.record.status, "cancelled");
  assert.equal(callLog.notebook, 1);
});

test("evidence-answer review requires approval and a trusted current snapshot", async () => {
  const missingAction = answerPrepareAction();
  const missingSetup = stateLifecycle();
  missingSetup.state.context = missingAction.context;
  assert.equal(missingSetup.lifecycle.propose(missingAction).ok, true);
  const missingApproval = createLocalAssistantActionApproval(missingAction, fixedNow);
  const missing = await missingSetup.lifecycle.confirm(missingAction.actionId, missingApproval);
  assert.equal(missing.status, "executed");
  assert.equal(missing.outcome?.kind, "invalid");
  assert.equal(missing.outcome?.code, "invalid-context");
  assert.equal(missing.handlerInvoked, false);
  assert.equal(missingSetup.callLog.notebook, 0);
  assert.equal(missing.card.content, null);
  assert.ok(missing.outcome?.issues.some(({ path }) => path.startsWith("trustedAnswerSnapshot")));

  const validAction = answerPrepareAction({ actionId: "action-answer-2" });
  const validSetup = stateLifecycle();
  validSetup.state.context = validAction.context;
  assert.equal(validSetup.lifecycle.propose(validAction).ok, true);
  const validApproval = createLocalAssistantActionApproval(validAction, fixedNow);
  const valid = await validSetup.lifecycle.confirm(validAction.actionId, validApproval, {
    trustedAnswerSnapshot: answerSnapshot(),
    activeDatasetSha256: datasetSha256,
  });
  assert.equal(valid.status, "executed");
  assert.equal(valid.outcome?.kind, "notebook-step");
  assert.equal(valid.handlerInvoked, true);
  assert.equal(validSetup.callLog.notebook, 1);
  assert.equal(valid.card.content?.kind, "notebook-step");
  assert.equal(valid.card.content.evidence.length, 1);
  assert.ok(valid.card.sourceReferences.length >= 1);
  assert.equal(valid.record.status, "executed");
  assert.equal(valid.record.approvedAt, fixedNow);
});

test("comparison, comparator and notebook cards retain evidence, limits and references", async () => {
  const { lifecycle, state } = stateLifecycle();
  const comparison = comparisonAction();
  state.context = comparison.context;
  assert.equal(lifecycle.propose(comparison).ok, true);
  const contextResult = await lifecycle.execute(comparison.actionId);
  assert.equal(contextResult.status, "executed");
  assert.equal(contextResult.outcome?.kind, "comparison-context");
  assert.equal(contextResult.card.content?.kind, "comparison-context");
  assert.ok(contextResult.card.content.evidence.length >= 1);
  assert.ok(contextResult.card.sourceReferences.length >= 4);
  assert.ok(contextResult.card.limitations.length >= 1);

  const comparator = comparatorAction();
  state.context = comparator.context;
  assert.equal(lifecycle.propose(comparator).ok, true);
  const comparatorResult = await lifecycle.execute(comparator.actionId);
  assert.equal(comparatorResult.status, "executed");
  assert.equal(comparatorResult.outcome?.kind, "comparator-search");
  assert.equal(comparatorResult.card.content?.kind, "comparator-search");
  assert.equal(comparatorResult.card.content.candidates.length, 1);
  assert.equal(comparatorResult.card.content.candidates[0].runId, "FLEX-004");
  assert.ok(comparatorResult.card.sourceReferences.length >= 1);
  assert.ok(comparatorResult.card.limitations.length >= 1);

  const notebook = prepareAction({ actionId: "action-card-notebook" });
  state.context = notebook.context;
  assert.equal(lifecycle.propose(notebook).ok, true);
  const approval = createLocalAssistantActionApproval(notebook, fixedNow);
  const notebookResult = await lifecycle.confirm(notebook.actionId, approval);
  assert.equal(notebookResult.status, "executed");
  assert.equal(notebookResult.card.content?.kind, "notebook-step");
  assert.ok(notebookResult.card.sourceReferences.length > 0);

  // Card projection itself is pure and can be built from any canonical record.
  const projected = buildAssistantActionCard(notebookResult.record);
  assert.equal(projected.actionId, notebook.actionId);
  assert.deepEqual(projected.context, notebook.context);
  assert.equal(projected.record.status, "executed");
});

test("invalid, unavailable and failed actions use canonical records and cards", async () => {
  const invalidAction = createPlotAction({
    actionId: "action-invalid-run",
    plot: plotSpec(["FLEX-999"]),
  });
  const invalidSetup = stateLifecycle();
  assert.equal(invalidSetup.lifecycle.propose(invalidAction).ok, true);
  const invalid = await invalidSetup.lifecycle.execute(invalidAction.actionId);
  assert.equal(invalid.status, "executed");
  assert.equal(invalid.outcome?.kind, "invalid");
  assert.equal(invalid.outcome?.code, "unknown-run");
  assert.equal(invalid.handlerInvoked, false);
  assert.equal(invalidSetup.callLog.plot, 0);
  assert.equal(invalid.card.phase, "executed");
  assert.equal(invalid.card.content, null);
  assert.equal(invalid.card.notice.includes("not applied"), true);

  const unavailableSetup = stateLifecycle();
  unavailableSetup.state.dataset = null;
  const unavailableAction = createPlotAction({ actionId: "action-unavailable" });
  assert.equal(unavailableSetup.lifecycle.propose(unavailableAction).ok, true);
  const unavailable = await unavailableSetup.lifecycle.execute(unavailableAction.actionId);
  assert.equal(unavailable.status, "executed");
  assert.equal(unavailable.outcome?.kind, "unavailable");
  assert.equal(unavailable.outcome?.code, "service-unavailable");
  assert.equal(unavailable.card.phase, "executed");
  assert.equal(unavailable.handlerInvoked, false);

  const failedSetup = stateLifecycle({
    getDataset: () => { throw new Error("fixture dataset failure"); },
  });
  const failedAction = createPlotAction({ actionId: "action-failed" });
  assert.equal(failedSetup.lifecycle.propose(failedAction).ok, true);
  const failed = await failedSetup.lifecycle.execute(failedAction.actionId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.record.status, "failed");
  assert.equal(failed.record.error.code, "execution-failed");
  assert.equal(failed.card.phase, "failed");
  assert.equal(failed.outcome, null);
});

test("one opted-in planning call returns a locally-bound request and sends only public context", async () => {
  const plan = {
    kind: "create_plot",
    plot: plotSpec(),
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(plan) },
      }],
    });
  };
  const result = await suggestAssistantAction(
    "Plot oxygen against burning rate for the selected runs.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl,
      actionId: "action-plan-1",
    },
  );
  assert.equal(result.status, "proposed");
  assert.equal(result.request.actionId, "action-plan-1");
  assert.deepEqual(result.request.context, actionContext());
  assert.equal(result.request.kind, "create_plot");
  assert.equal(result.request.plot.scope.kind, "explicit-runs");
  assert.equal(result.model.promptVersion, "action-plan-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  const sent = requests[0].body.messages.at(-1).content;
  const planningInput = JSON.parse(sent);
  assert.deepEqual(Object.keys(planningInput).sort(), ["datasetVersion", "fields", "question", "selectedRunIds"]);
  assert.equal(planningInput.question, "Plot oxygen against burning rate for the selected runs.");
  assert.deepEqual(planningInput.selectedRunIds, ["FLEX-001", "FLEX-002"]);
  assert.equal(planningInput.fields.length, 11);
  assert.equal(sent.includes("workspace-1"), false);
  assert.equal(sent.includes("turn-1"), false);
  assert.equal(sent.includes("selectionRevision"), false);
  assert.equal(sent.includes("fixture-provider-key"), false);
  assert.equal(sent.includes("notebook"), false);
  assert.equal(sent.includes("receipt"), false);
});

test("denied reservation returns budget-exhausted with no provider call", async () => {
  const redisUrl = "https://fixture-instance.upstash.io";
  const calls = [];
  const env = {
    DEEPSEEK_ENABLED: "true",
    DEEPSEEK_API_KEY: "fixture-provider-key",
    VERCEL_ENV: "preview",
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: "fixture-redis-token",
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    assert.equal(url, redisUrl);
    return Response.json({ result: 0 });
  };
  const result = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    { env, fetchImpl },
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.outcome.code, "budget-exhausted");
  assert.equal(result.model, null);
  assert.deepEqual(calls, [redisUrl]);
});

test("unconfigured, malformed and stale planning responses are structured", async () => {
  const unconfigured = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true" },
      fetchImpl: async () => assert.fail("Unconfigured planning must not call transport"),
    },
  );
  assert.equal(unconfigured.status, "unavailable");
  assert.equal(unconfigured.outcome.code, "provider-disabled");

  let malformedCalls = 0;
  const malformed = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl: async () => {
        malformedCalls += 1;
        return new Response("not-json", { status: 200 });
      },
    },
  );
  assert.equal(malformed.status, "unavailable");
  assert.equal(malformed.outcome.code, "service-unavailable");
  assert.match(malformed.outcome.message ?? "", /unusable response/);
  assert.equal(malformedCalls, 1);

  let timeoutCalls = 0;
  const timedOut = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl: async () => {
        timeoutCalls += 1;
        return new Response(null, { status: 504 });
      },
    },
  );
  assert.equal(timedOut.status, "unavailable");
  assert.equal(timedOut.outcome.code, "service-unavailable");
  assert.equal(timeoutCalls, 1);

  let staleCalls = 0;
  const stale = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl: async () => {
        staleCalls += 1;
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify({ kind: "create_plot", plot: plotSpec() }) },
          }],
        });
      },
      readActiveContext: () => actionContext({ turnId: "turn-2" }),
    },
  );
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.outcome.reasons, ["turn"]);
  assert.equal(staleCalls, 1);
});

test("provider cannot plan a notebook mutation or invent runs, and cancellation is zero-call", async () => {
  const notebookPlan = {
    kind: "prepare_notebook_step",
    step: plotStep(),
  };
  let calls = 0;
  const invalidPlan = await suggestAssistantAction(
    "Prepare a notebook step.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(notebookPlan) },
          }],
        });
      },
    },
  );
  assert.equal(invalidPlan.status, "invalid");
  assert.equal(invalidPlan.outcome.code, "invalid-action");
  assert.equal(calls, 1);

  let inventedCalls = 0;
  const invented = await suggestAssistantAction(
    "Plot a run I did not select.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      fetchImpl: async () => {
        inventedCalls += 1;
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({ kind: "create_plot", plot: plotSpec(["FLEX-010"]) }),
            },
          }],
        });
      },
    },
  );
  assert.equal(invented.status, "invalid");
  assert.equal(invented.outcome.code, "invalid-context");
  assert.equal(inventedCalls, 1);

  const controller = new AbortController();
  controller.abort("fixture cancellation");
  let cancelledCalls = 0;
  const cancelled = await suggestAssistantAction(
    "Plot oxygen against burning rate.",
    actionContext(),
    dataset,
    {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture-provider-key" },
      signal: controller.signal,
      fetchImpl: async () => {
        cancelledCalls += 1;
        throw new Error("Cancelled planning must not call transport");
      },
    },
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelledCalls, 0);
});
