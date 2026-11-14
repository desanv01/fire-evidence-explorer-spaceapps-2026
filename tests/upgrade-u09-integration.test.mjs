/**
 * U09 focused integration check — guide entry points and the opt-in AI planner.
 *
 * This is a deterministic, model-level fixture using the real bundled corpus and
 * a fake provider transport. It makes zero live provider calls and does not
 * pretend to be browser acceptance. It covers:
 * - guide open as an unsaved draft with no storage write, explicit save/reload,
 *   JSON/print export and import round-trip;
 * - the +3.34 s burn-time comparison, a missing burning-rate measurement and the
 *   complete linked gas composition from the actual corpus;
 * - planner request bounds/identity/run-membership validation before provider
 *   work, exactly one fake transport call, response binding, stale/cancelled
 *   suppression and disabled/exhausted availability with manual flows intact.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as React from "react";
import * as ReactDOMServer from "react-dom/server";
import { parseDataset } from "../src/lib/evidence.ts";
import { buildSelectedRunsContext } from "../src/lib/upgrades/comparison-engine.ts";
import {
  appendNotebookStep, createComparisonNotebookStep, createNotebook,
  createNotebookStorage, importNotebookFromBytes, importNotebookFromText,
  loadNotebookFromStorage, saveNotebookToStorage,
} from "../src/lib/upgrades/notebook-engine.ts";
import {
  addNotebookNote, createNotebookNote,
} from "../src/lib/upgrades/notebook-presentation.ts";
import {
  exportGuidedInvestigation, guidedInvestigationDatasetReport, listGuidedInvestigations,
  openGuidedInvestigation,
} from "../src/lib/upgrades/guided-investigations.ts";
import {
  createAssistantActionContext,
} from "../src/lib/upgrades/action-registry.ts";
import {
  createAssistantActionId, createAssistantActionLifecycle,
} from "../src/lib/upgrades/action-lifecycle.ts";
import {
  assistantActionPlanResponseSchema, handleAssistantActionPlanRequest,
} from "../src/lib/upgrades/action-planning-api.ts";
import { suggestAssistantAction } from "../src/lib/deepseek.ts";
import {
  acceptPlannedAssistantAction, AssistantActionPlanningError, requestAssistantActionPlan,
} from "../src/components/workbench/action-planning-client.ts";
import { planLocalAssistantAction } from "../src/components/workbench/assistant-actions.ts";
import {
  notebookDraftIsDirty, notebookDraftSignature, notebookSaveStatusText, useNotebookController,
} from "../src/components/workbench/notebook-store.ts";

const dataset = parseDataset(JSON.parse(await readFile(new URL("../data/flex.json", import.meta.url), "utf8")));
const manifest = JSON.parse(await readFile(new URL("../data/flex.sources.json", import.meta.url), "utf8"));
const datasetSha256 = manifest.datasetSha256;
const versionContext = {
  activeDatasetVersion: dataset.version,
  availableDatasetVersions: [dataset.version],
};
const openedAt = "2025-01-16T09:00:00+08:00";
const baseEnv = {
  DEEPSEEK_ENABLED: "true",
  DEEPSEEK_API_KEY: "test-key-not-real",
  DEEPSEEK_MODEL: "deepseek-flash",
  DEEPSEEK_TIMEOUT_MS: "2000",
};

const validPlotPlan = {
  kind: "create_plot",
  plot: {
    version: "plot-spec-1",
    kind: "scatter",
    axes: { x: { field: "diameter" }, y: { field: "burn_time" } },
    grouping: "none",
    scope: { kind: "explicit-runs", runIds: ["FLEX-001", "FLEX-004"] },
  },
};

function actionContext(overrides = {}) {
  return createAssistantActionContext({
    workspaceId: "workbench-u09-test",
    turnId: "turn-u09-1",
    datasetVersion: dataset.version,
    selectedRunIds: ["FLEX-001", "FLEX-004"],
    selectionRevision: 1,
    ...overrides,
  });
}

function planBody(overrides = {}) {
  return {
    question: "Plot the recorded burn times for the selected runs.",
    actionId: "action-u09-plan-1",
    context: actionContext(),
    datasetVersion: dataset.version,
    datasetSha256,
    ...overrides,
  };
}

function providerResponse(plan) {
  return new Response(JSON.stringify({
    model: "deepseek-flash",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(plan) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function callPlanRoute(body, { env = baseEnv, fetchImpl, rawBody, headers } = {}) {
  const request = new Request("http://localhost/api/assistant-action", {
    method: "POST",
    headers: headers ?? { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
  const response = await handleAssistantActionPlanRequest(request, {
    dataset,
    datasetSha256,
    env,
    fetchImpl,
  });
  return { response, json: await response.json() };
}

test("guided investigations open as an unsaved draft and round-trip explicitly", () => {
  const writes = [];
  const reads = [];
  const stored = new Map();
  const storage = createNotebookStorage({
    getItem: (key) => { reads.push(key); return stored.get(key) ?? null; },
    setItem: (key, value) => { writes.push(key); stored.set(key, value); },
    removeItem: (key) => { stored.delete(key); },
  });
  const opened = openGuidedInvestigation(dataset, "burn-time-condition-differences", {
    notebookId: "guide-u09-burn-time",
    openedAt,
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(writes, [], "opening a guide must not write storage");
  assert.deepEqual(reads, [], "opening a guide must not read storage");
  assert.equal(opened.notebook.steps.length, 2);
  assert.ok(opened.notebook.steps.every((step) => step.sourceReferences.length > 0));
  assert.ok(opened.notebook.steps.every((step) => step.limitations.length > 0));

  const saved = saveNotebookToStorage(storage, opened.notebook);
  assert.equal(saved.ok, true);
  assert.equal(writes.length, 1, "saving is the first explicit storage write");
  const loaded = loadNotebookFromStorage(storage, opened.notebook.id, { versionContext });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.notebook.steps, opened.notebook.steps);
  assert.deepEqual(loaded.notebook.notes, opened.notebook.notes);

  const exported = exportGuidedInvestigation(dataset, "burn-time-condition-differences", {
    notebookId: "guide-u09-burn-time",
    openedAt,
  });
  assert.equal(exported.ok, true);
  assert.ok(exported.json.byteLength > 0);
  assert.match(exported.printableHtml, new RegExp(dataset.version));
  assert.doesNotMatch(exported.printableHtml, /<script/i);
  assert.equal(writes.length, 1, "export must not write storage");
  const imported = importNotebookFromText(exported.json.text, { versionContext, datasets: [dataset] });
  assert.equal(imported.ok, true);
  assert.equal(imported.verification, "not-verified");
  assert.deepEqual(imported.notebook.steps, opened.notebook.steps);
  // Save reads the prior value once; the explicit reload is the second read.
  assert.equal(reads.length, 2);
  assert.equal(reads.at(-1), `fire-evidence:notebook:${opened.notebook.id}`);
});

test("notebook draft cleanliness protects only genuine unsaved work", () => {
  // The hook's real initial state is clean; this is the regression that made an
  // untouched "Untitled investigation" prompt on the first guide open.
  function Probe() {
    const controller = useNotebookController(dataset, datasetSha256);
    return React.createElement("span", null,
      `${controller.dirty ? "dirty" : "clean"}:${controller.saveFailed ? "save-failed" : "save-ok"}:${controller.savedAt ? "saved" : "not-saved"}`);
  }
  assert.equal(ReactDOMServer.renderToStaticMarkup(React.createElement(Probe)), "<span>clean:save-ok:not-saved</span>");

  // The normalized title/question signature excludes updatedAt and whitespace.
  const initial = createNotebook({ id: "draft-clean", title: "Untitled investigation", datasetVersions: [dataset.version] });
  const initialSignature = notebookDraftSignature(initial, initial.title, initial.question);
  assert.equal(notebookDraftIsDirty(initialSignature, initialSignature), false);
  assert.equal(
    notebookDraftSignature(initial, `  ${initial.title}  `, "   "),
    initialSignature,
    "normalized whitespace stays clean",
  );

  // Title, question, personal-note and evidence-step edits are dirty; reverting
  // to the clean values/objects restores clean behavior.
  assert.equal(notebookDraftIsDirty(notebookDraftSignature(initial, "Edited investigation", initial.question), initialSignature), true);
  assert.equal(notebookDraftIsDirty(notebookDraftSignature(initial, initial.title, "What changed?"), initialSignature), true);
  assert.equal(notebookDraftIsDirty(initialSignature, initialSignature), false);

  const noted = addNotebookNote(initial, createNotebookNote({ noteId: "draft-note-1", text: "Check this." }));
  assert.equal(noted.ok, true);
  assert.equal(
    notebookDraftIsDirty(notebookDraftSignature(noted.notebook, noted.notebook.title, noted.notebook.question), initialSignature),
    true,
  );

  const context = buildSelectedRunsContext(dataset, {
    version: "comparison-context-request-1",
    kind: "selected-runs",
    runIds: ["FLEX-001", "FLEX-004"],
  });
  const step = createComparisonNotebookStep({ stepId: "draft-step-1", title: "Draft comparison", context });
  const stepped = appendNotebookStep(initial, step);
  assert.equal(stepped.ok, true);
  const stepSignature = notebookDraftSignature(stepped.notebook, stepped.notebook.title, stepped.notebook.question);
  assert.equal(notebookDraftIsDirty(stepSignature, initialSignature), true);

  // Fresh blank drafts and explicitly saved/reopened notebooks are clean until
  // their content changes; a guided or imported notebook is unsaved even when
  // untouched, so it keeps replacement protection with no clean baseline.
  const fresh = createNotebook({ id: "draft-fresh", title: "Untitled investigation", datasetVersions: [dataset.version] });
  const freshSignature = notebookDraftSignature(fresh, fresh.title, fresh.question);
  assert.equal(notebookDraftIsDirty(freshSignature, freshSignature), false);

  const savedStore = new Map();
  const savedStorage = createNotebookStorage({
    getItem: (key) => savedStore.get(key) ?? null,
    setItem: (key, value) => { savedStore.set(key, value); },
    removeItem: (key) => { savedStore.delete(key); },
  });
  const saved = saveNotebookToStorage(savedStorage, stepped.notebook);
  assert.equal(saved.ok, true);
  const reopened = loadNotebookFromStorage(savedStorage, stepped.notebook.id, { versionContext });
  assert.equal(reopened.ok, true);
  const reopenedSignature = notebookDraftSignature(reopened.notebook, reopened.notebook.title, reopened.notebook.question);
  assert.equal(notebookDraftIsDirty(reopenedSignature, reopenedSignature), false);
  assert.equal(
    notebookDraftIsDirty(notebookDraftSignature(reopened.notebook, "Changed title", reopened.notebook.question), reopenedSignature),
    true,
  );

  const guide = openGuidedInvestigation(dataset, "burn-time-condition-differences", {
    notebookId: "draft-guide-clean",
    openedAt,
  });
  assert.equal(guide.ok, true);
  assert.equal(
    notebookDraftIsDirty(notebookDraftSignature(guide.notebook, guide.notebook.title, guide.notebook.question), null),
    true,
  );

  const imported = importNotebookFromBytes(new TextEncoder().encode(JSON.stringify(initial)), { versionContext, datasets: [dataset] });
  assert.equal(imported.ok, true);
  assert.equal(
    notebookDraftIsDirty(notebookDraftSignature(imported.notebook, imported.notebook.title, imported.notebook.question), null),
    true,
  );

  // An invalid import is structured and leaves the current in-memory value
  // untouched; the workspace reports that error without opening a discard prompt.
  const current = imported.notebook;
  const before = JSON.stringify(current);
  const invalid = importNotebookFromBytes(new TextEncoder().encode("{}"), { versionContext, datasets: [dataset] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-content");
  assert.equal(JSON.stringify(current), before);
});

test("save status reflects persistence, not a shared operation error", () => {
  // The malformed-import alert remains separate; no controller.error value is an
  // input here, so import/notes/export failures leave the save card on its
  // existing persistence text.
  assert.equal(notebookSaveStatusText({ saveFailed: false, savedAtLabel: "", dirty: false }),
    "Nothing has been written yet.");
  assert.equal(notebookSaveStatusText({ saveFailed: false, savedAtLabel: "", dirty: true }),
    "Unsaved changes; nothing has been written.");
  assert.equal(notebookSaveStatusText({ saveFailed: false, savedAtLabel: "13 Nov 2026, 09:00", dirty: false }),
    "Last saved 13 Nov 2026, 09:00");
  // Existing precedence is preserved when a saved draft has later edits.
  assert.equal(notebookSaveStatusText({ saveFailed: false, savedAtLabel: "13 Nov 2026, 09:00", dirty: true }),
    "Last saved 13 Nov 2026, 09:00");
  // A real Save failure keeps its own status, independent of the specific alert.
  assert.equal(notebookSaveStatusText({ saveFailed: true, savedAtLabel: "13 Nov 2026, 09:00", dirty: true }),
    "Save did not complete; the draft remains open.");
});

test("the actual corpus supplies +3.34 s, a missing measurement and the full gas group", () => {
  const comparison = buildSelectedRunsContext(dataset, {
    version: "comparison-context-request-1",
    kind: "selected-runs",
    runIds: ["FLEX-001", "FLEX-004"],
  });
  const burnTime = comparison.outcomes.find(({ key }) => key === "burn_time");
  const extinction = comparison.outcomes.find(({ key }) => key === "extinction_diameter");
  assert.ok(burnTime);
  assert.equal(burnTime.status, "different");
  assert.equal(burnTime.deltas.length, 1);
  assert.equal(burnTime.deltas[0].delta, 3.34);
  assert.equal(burnTime.deltas[0].unit, "s");
  assert.deepEqual(burnTime.cells.map(({ value }) => value), [4.3, 7.64]);
  assert.ok(extinction);
  assert.equal(extinction.status, "unknown");
  assert.deepEqual(extinction.cells.map(({ value }) => value), [0.89, null]);
  assert.equal(extinction.deltas.length, 0, "an unknown value never produces a delta or zero");
  assert.equal(comparison.gasComposition.complete, true);
  const gas = comparison.gasComposition.values.find(({ runId }) => runId === "FLEX-004").values;
  assert.deepEqual(gas, { oxygen: 0.21, nitrogen: 0.79, carbon_dioxide: 0, helium: 0 });

  const guide = openGuidedInvestigation(dataset, "burn-time-condition-differences", {
    notebookId: "guide-u09-facts",
    openedAt,
  });
  assert.equal(guide.ok, true);
  const facts = guide.facts.find(({ stepId }) => stepId === "bt-2-context");
  assert.ok(facts);
  assert.equal(facts.gasComposition.complete, true);
  assert.deepEqual([...facts.gasComposition.fieldKeys], ["oxygen", "nitrogen", "carbon_dioxide", "helium"]);
  assert.ok(guide.sourceAnchors.some(({ reference, locator }) => reference.runId === "FLEX-004"
    && reference.fieldKey === "burn_time" && /row 5, column N/i.test(locator)));

  const missing = openGuidedInvestigation(dataset, "missing-burning-rate", {
    notebookId: "guide-u09-missing",
    openedAt,
  });
  assert.equal(missing.ok, true);
  const ratePlot = missing.facts.find(({ stepId }) => stepId === "mr-1-burning-rate");
  assert.ok(ratePlot);
  assert.deepEqual(ratePlot.points.map(({ runId }) => runId), ["FLEX-013"]);
  assert.deepEqual(ratePlot.omitted, [{ runId: "FLEX-014", reasons: ["missing-y"] }]);
  const missingContext = missing.facts.find(({ stepId }) => stepId === "mr-3-context");
  assert.ok(missingContext);
  const rate = missingContext.outcomes.find(({ key }) => key === "burning_rate");
  assert.ok(rate);
  assert.equal(rate.status, "unknown");
  assert.deepEqual(rate.values.map(({ value }) => value), [0.49, null]);
  assert.equal(rate.deltas.length, 0);
  assert.equal(missingContext.gasComposition.complete, true);
});

test("all three guides remain corpus-pinned, ordered and sourced", () => {
  const guides = listGuidedInvestigations();
  assert.deepEqual(guides.map(({ guideId }) => guideId),
    ["burn-time-condition-differences", "missing-burning-rate", "visible-flame-extinction"]);
  const report = guidedInvestigationDatasetReport(dataset);
  assert.equal(report.compatible, true);
  assert.equal(report.datasetVersion, report.expectedDatasetVersion);

  for (const guide of guides) {
    const opened = openGuidedInvestigation(dataset, guide.guideId, {
      notebookId: `guide-u09-${guide.guideId}`,
      openedAt,
    });
    assert.equal(opened.ok, true, guide.guideId);
    assert.equal(opened.corpus.datasetVersion, report.expectedDatasetVersion);
    assert.equal(opened.corpus.sourceId, "psi-69-flex-table-v1");
    assert.equal(opened.notebook.steps.length, guide.steps.length);
    assert.equal(opened.facts.length, guide.steps.length);
    assert.ok(opened.notebook.steps.every((step) => step.sourceReferences.length > 0));
    assert.ok(opened.sourceReferences.length > 0);
    assert.ok(opened.sourceAnchors.every(({ locator }) => locator.length > 0));
  }

  const extinct = openGuidedInvestigation(dataset, "visible-flame-extinction", {
    notebookId: "guide-u09-extinction",
    openedAt,
  });
  assert.equal(extinct.ok, true);
  const sameEnd = extinct.facts.find(({ stepId }) => stepId === "xf-3-same-end");
  assert.ok(sameEnd);
  const oxygen = sameEnd.conditions.find(({ key }) => key === "oxygen");
  const nitrogen = sameEnd.conditions.find(({ key }) => key === "nitrogen");
  assert.ok(oxygen);
  assert.ok(nitrogen);
  assert.ok(Math.abs(oxygen.deltas[0].delta - (-0.04)) < 1e-9);
  assert.ok(Math.abs(nitrogen.deltas[0].delta - 0.04) < 1e-9);
  assert.equal(sameEnd.gasComposition.complete, true);
  // One ordered pair produces one full four-field composition difference row.
  assert.equal(sameEnd.gasComposition.differenceCount, 1);
});

test("planner route validates bounds and identity before one fake provider call", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
    return providerResponse(validPlotPlan);
  };
  const body = planBody();
  const { response, json } = await callPlanRoute(body, { fetchImpl });
  assert.equal(response.status, 200);
  const parsed = assistantActionPlanResponseSchema.parse(json);
  assert.equal(parsed.status, "proposed");
  assert.equal(parsed.request.actionId, body.actionId);
  assert.deepEqual(parsed.request.context, body.context);
  assert.deepEqual(parsed.request.plot.scope, { kind: "explicit-runs", runIds: ["FLEX-001", "FLEX-004"] });
  assert.equal(calls.length, 1, "one explicit request produces one provider attempt");
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.doesNotMatch(calls[0].body, /test-key-not-real/);
  const providerBody = JSON.parse(calls[0].body);
  const planningInput = JSON.parse(providerBody.messages.at(-1).content);
  assert.equal(planningInput.question, body.question);
  assert.deepEqual(planningInput.selectedRunIds, ["FLEX-001", "FLEX-004"]);
  assert.ok(!("actionId" in planningInput));
  assert.ok(!("context" in planningInput));
  assert.ok(!("receipt" in planningInput));
  assert.ok(!("notebook" in planningInput));
  assert.ok(!JSON.stringify(parsed).includes("test-key-not-real"));
  assert.ok(!("receipt" in parsed) && !("notebook" in parsed));
});

test("planner route rejects oversized, non-JSON, malformed and mismatched input without provider work", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return providerResponse(validPlotPlan);
  };
  const wrongType = await callPlanRoute(planBody(), {
    fetchImpl,
    headers: { "content-type": "text/plain" },
    rawBody: JSON.stringify(planBody()),
  });
  assert.equal(wrongType.response.status, 415);

  const oversized = await callPlanRoute(planBody({ question: "x".repeat(9_000) }), { fetchImpl });
  assert.equal(oversized.response.status, 413);

  const malformed = await callPlanRoute(planBody(), { fetchImpl, rawBody: "{" });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.json.error, "invalid-json");

  const badQuestion = await callPlanRoute(planBody({ question: "" }), { fetchImpl });
  assert.equal(badQuestion.response.status, 400);
  assert.equal(badQuestion.json.error, "invalid-request");

  const unknownRun = await callPlanRoute(planBody({
    context: actionContext({ selectedRunIds: ["FLEX-999"] }),
  }), { fetchImpl });
  assert.equal(unknownRun.response.status, 200);
  assert.equal(unknownRun.json.status, "invalid");
  assert.equal(unknownRun.json.outcome.kind, "invalid");
  assert.equal(unknownRun.json.outcome.code, "unknown-run");

  const stale = await callPlanRoute(planBody({ datasetSha256: "0".repeat(64) }), { fetchImpl });
  assert.equal(stale.response.status, 200);
  assert.equal(stale.json.status, "stale");
  assert.equal(stale.json.outcome.kind, "stale-context");
  assert.equal(calls, 0, "no validation failure reaches the provider");
});

test("client wrapper accepts a bound response and rejects a tampered one", async () => {
  const route = await callPlanRoute(planBody(), {
    fetchImpl: async () => providerResponse(validPlotPlan),
  });
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls += 1;
      assert.equal(String(url), "/api/assistant-action");
      assert.equal(JSON.parse(String(init?.body)).actionId, "action-u09-plan-1");
      return new Response(JSON.stringify(route.json), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const plan = await requestAssistantActionPlan(planBody());
    assert.equal(plan.status, "proposed");
    assert.equal(calls, 1, "the wrapper performs no retry");

    const tampered = structuredClone(route.json);
    tampered.request.context.selectionRevision += 1;
    globalThis.fetch = async () => new Response(JSON.stringify(tampered), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(requestAssistantActionPlan(planBody()), (error) => (
      error instanceof AssistantActionPlanningError && error.code === "invalid-response"
    ));

    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async () => {
      throw new DOMException("Aborted", "AbortError");
    };
    await assert.rejects(requestAssistantActionPlan(planBody(), { signal: controller.signal }), (error) => (
      error.name === "AbortError"
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI proposals are rechecked, registered as proposed only, and stale ones suppressed", async () => {
  const route = await callPlanRoute(planBody(), {
    fetchImpl: async () => providerResponse(validPlotPlan),
  });
  const plan = route.json;
  assert.equal(plan.status, "proposed");
  const active = actionContext();
  const lifecycle = createAssistantActionLifecycle({
    getDataset: () => dataset,
    readActiveContext: () => active,
  });
  const accepted = acceptPlannedAssistantAction({
    plan,
    plannedContext: plan.request.context,
    actionId: plan.request.actionId,
    activeContext: active,
    dataset,
    datasetSha256,
    corpusReady: true,
    lifecycle,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.card.phase, "proposed", "acceptance never auto-applies the action");
  assert.equal(lifecycle.listCards().length, 1);
  const replay = acceptPlannedAssistantAction({
    plan,
    plannedContext: plan.request.context,
    actionId: plan.request.actionId,
    activeContext: active,
    dataset,
    datasetSha256,
    corpusReady: true,
    lifecycle,
  });
  assert.equal(replay.ok, true);
  assert.equal(lifecycle.listCards().length, 1, "a replayed proposal does not register twice");

  const staleContext = actionContext({ selectionRevision: 2 });
  const staleLifecycle = createAssistantActionLifecycle({
    getDataset: () => dataset,
    readActiveContext: () => staleContext,
  });
  const stale = acceptPlannedAssistantAction({
    plan,
    plannedContext: plan.request.context,
    actionId: plan.request.actionId,
    activeContext: staleContext,
    dataset,
    datasetSha256,
    corpusReady: true,
    lifecycle: staleLifecycle,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");
  assert.equal(staleLifecycle.listCards().length, 0, "a stale proposal is never registered");

  const unverified = acceptPlannedAssistantAction({
    plan,
    plannedContext: plan.request.context,
    actionId: plan.request.actionId,
    activeContext: active,
    dataset,
    datasetSha256,
    corpusReady: false,
    lifecycle,
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.reason, "corpus");

  const ungroundedPlan = structuredClone(plan);
  ungroundedPlan.request.plot.scope.runIds = ["FLEX-002"];
  const ungroundedLifecycle = createAssistantActionLifecycle({
    getDataset: () => dataset,
    readActiveContext: () => active,
  });
  const ungrounded = acceptPlannedAssistantAction({
    plan: ungroundedPlan,
    plannedContext: ungroundedPlan.request.context,
    actionId: ungroundedPlan.request.actionId,
    activeContext: active,
    dataset,
    datasetSha256,
    corpusReady: true,
    lifecycle: ungroundedLifecycle,
  });
  assert.equal(ungrounded.ok, false);
  assert.equal(ungrounded.reason, "stale");
  assert.equal(ungroundedLifecycle.listCards().length, 0);
});

test("cancellation and notebook-mutation plans cannot register or spend again", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await suggestAssistantAction(planBody().question, actionContext(), dataset, {
    env: baseEnv,
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      return providerResponse(validPlotPlan);
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(calls, 0, "an already-cancelled request makes no provider call");

  const mutation = await callPlanRoute(planBody({ actionId: "action-u09-mutation-1" }), {
    fetchImpl: async () => providerResponse({ kind: "prepare_notebook_step", step: {} }),
  });
  assert.equal(mutation.json.status, "invalid");
  assert.equal(mutation.json.outcome.kind, "invalid");
  assert.ok(!("request" in mutation.json));
});

test("disabled and exhausted providers keep deterministic manual actions available", async () => {
  let disabledCalls = 0;
  const disabled = await callPlanRoute(planBody(), {
    env: { DEEPSEEK_ENABLED: "false" },
    fetchImpl: async () => {
      disabledCalls += 1;
      return providerResponse(validPlotPlan);
    },
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.json.status, "unavailable");
  assert.equal(disabled.json.outcome.kind, "unavailable");
  assert.equal(disabled.json.outcome.code, "provider-disabled");
  assert.equal(disabledCalls, 0);
  assert.ok(!JSON.stringify(disabled.json).includes("test-key-not-real"));

  const budgetCalls = [];
  const budget = await callPlanRoute(planBody(), {
    env: {
      ...baseEnv,
      DEEPSEEK_REQUIRE_ATTEMPT_BUDGET: "true",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token-not-real",
    },
    fetchImpl: async (url) => {
      budgetCalls.push(String(url));
      if (String(url).startsWith("https://example.upstash.io")) {
        return new Response(JSON.stringify({ result: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return providerResponse(validPlotPlan);
    },
  });
  assert.equal(budget.json.status, "unavailable");
  assert.equal(budget.json.outcome.kind, "unavailable");
  assert.equal(budget.json.outcome.code, "budget-exhausted");
  assert.equal(budgetCalls.length, 1);
  assert.match(budgetCalls[0], /example\.upstash\.io/);
  assert.ok(!budgetCalls.includes("https://api.deepseek.com/chat/completions"));

  const manual = planLocalAssistantAction({
    question: "Plot burn time against diameter.",
    dataset,
    context: actionContext(),
    selectedRunIds: ["FLEX-001", "FLEX-004"],
    search: { investigation: "FLEX" },
    nextActionId: () => createAssistantActionId(),
    nextStepId: () => "step-u09-manual-1",
  });
  assert.ok(manual?.request);
  assert.equal(manual.request.kind, "create_plot");
  const manualLifecycle = createAssistantActionLifecycle({
    getDataset: () => dataset,
    readActiveContext: () => actionContext(),
  });
  const manualProposal = manualLifecycle.propose(manual.request);
  assert.equal(manualProposal.ok, true);
  assert.equal(manualProposal.card.phase, "proposed");
});
