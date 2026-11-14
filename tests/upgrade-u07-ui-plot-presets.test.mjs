/**
 * U07 UI integration regression — the Visual Evidence Lab presets must produce
 * the approved corpus values and must feed the accepted plot/export/notebook
 * contracts. This is a narrow model-level check; no browser automation.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { buildPlotResult } from "../src/lib/upgrades/plot-engine.ts";
import { buildPlotExportPayload } from "../src/lib/upgrades/plot-workspace.ts";
import { createPlotNotebookStep } from "../src/lib/upgrades/notebook-engine.ts";
import { createAssistantActionContext, parseAssistantActionRequest } from "../src/lib/upgrades/action-registry.ts";
import { validateActionAgainstDataset } from "../src/lib/upgrades/actions.ts";
import { planLocalAssistantAction } from "../src/components/workbench/assistant-actions.ts";
import {
  omissionReasonText, plotCoverage, plotPresetForSpec, plotScopeChoice, plotSpecForPreset,
  scatterPlotSpec,
} from "../src/components/workbench/plot-model.ts";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const dataset = parseDataset(await read("flex.json"));

function presetResult(id, options = { selectedRunIds: [] }) {
  const spec = plotSpecForPreset(id, options);
  assert.ok(spec, `preset ${id} produced a spec`);
  return { spec, result: buildPlotResult(dataset, spec) };
}

test("Diameter / time preset is the approved 28 of 31 view with three explicit omissions", () => {
  const { spec, result } = presetResult("diameter-time");
  assert.equal(plotPresetForSpec(spec), "diameter-time");
  assert.equal(plotScopeChoice(spec), "all");
  assert.equal(result.includedCount, 28);
  assert.equal(result.omittedCount, 3);
  assert.deepEqual(result.omitted.map(({ runId }) => runId), ["FLEX-009", "FLEX-012", "FLEX-024"]);
  const coverage = plotCoverage(result);
  assert.deepEqual(coverage, { resolved: 31, included: 28, omitted: 3, emptyScope: false, allOmitted: false });
  const flex009 = result.omitted.find(({ runId }) => runId === "FLEX-009");
  assert.ok(flex009);
  assert.equal(omissionReasonText(flex009.reasons, spec), "Initial droplet diameter unknown and Burn time unknown.");
  const exported = buildPlotExportPayload(dataset, spec, result);
  assert.equal(exported.counts.included, 28);
  assert.equal(exported.counts.omitted, 3);
  assert.equal(exported.rows.length, 28);
});

test("O₂ / burning rate preset uses native units and six omissions", () => {
  const { spec, result } = presetResult("oxygen-rate");
  assert.equal(plotPresetForSpec(spec), "oxygen-rate");
  assert.equal(result.includedCount, 25);
  assert.equal(result.omittedCount, 6);
  assert.deepEqual(result.omitted.map(({ runId }) => runId),
    ["FLEX-009", "FLEX-012", "FLEX-014", "FLEX-015", "FLEX-017", "FLEX-024"]);
  for (const point of result.points) {
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
  }
  assert.equal(result.points[0].sourceReferences.length, 2);
});

test("Selected-runs point comparison keeps caller order for two or three runs", () => {
  const { spec, result } = presetResult("selected-runs", { selectedRunIds: ["FLEX-001", "FLEX-004", "FLEX-002"] });
  assert.equal(plotPresetForSpec(spec), "selected-runs");
  assert.equal(plotScopeChoice(spec), "selected");
  assert.equal(result.kind, "point-comparison");
  assert.deepEqual(result.resolvedRunIds, ["FLEX-001", "FLEX-004", "FLEX-002"]);
  assert.deepEqual(result.points.map(({ runId }) => runId), ["FLEX-001", "FLEX-004", "FLEX-002"]);
  assert.ok(result.points.every(point => point.x === null && point.sourceReferences.length === 1));
});

test("an empty selected scope cannot build a point comparison", () => {
  assert.equal(plotSpecForPreset("selected-runs", { selectedRunIds: [] }), null);
});

test("a valid zero-row scope exports a zero-row payload but cannot be pinned", () => {
  const spec = scatterPlotSpec("diameter", "burn_time", {
    kind: "filtered-results",
    search: { query: "no-such-reviewed-run" },
  });
  const result = buildPlotResult(dataset, spec);
  assert.equal(result.resolvedRunIds.length, 0);
  const coverage = plotCoverage(result);
  assert.equal(coverage.emptyScope, true);
  assert.equal(coverage.allOmitted, false);
  const exported = buildPlotExportPayload(dataset, spec, result);
  assert.deepEqual(exported.counts, { resolved: 0, included: 0, omitted: 0 });
  assert.equal(exported.rows.length, 0);
  assert.throws(() => createPlotNotebookStep({
    stepId: "empty-plot-step",
    title: "Empty plot",
    plotSpec: spec,
    plotResult: result,
  }));
});

test("a nonempty all-omitted scope stays distinct from an empty scope", () => {
  const { spec, result } = presetResult("selected-runs", { selectedRunIds: ["FLEX-004"] });
  const ySpec = { ...spec, axes: { y: { field: "extinction_diameter" } } };
  const yResult = buildPlotResult(dataset, ySpec);
  const coverage = plotCoverage(yResult);
  assert.equal(coverage.resolved, 1);
  assert.equal(coverage.included, 0);
  assert.equal(coverage.omitted, 1);
  assert.equal(coverage.emptyScope, false);
  assert.equal(coverage.allOmitted, true);
  const exported = buildPlotExportPayload(dataset, ySpec, yResult);
  assert.deepEqual(exported.counts, { resolved: 1, included: 0, omitted: 1 });
  const step = createPlotNotebookStep({
    stepId: "all-omitted-step",
    title: "Recorded extinction diameter",
    plotSpec: ySpec,
    plotResult: yResult,
  });
  assert.equal(step.datasetVersion, dataset.version);
  assert.deepEqual(step.resolvedRunIds, ["FLEX-004"]);
});

function plannerInput(question, extra = {}) {
  return {
    question,
    dataset,
    context: createAssistantActionContext({
      workspaceId: "workbench-u07",
      turnId: "turn-u07-1",
      datasetVersion: dataset.version,
      selectedRunIds: ["FLEX-001", "FLEX-004"],
      selectionRevision: 2,
    }),
    selectedRunIds: ["FLEX-001", "FLEX-004"],
    search: { investigation: "FLEX" },
    nextActionId: () => "action-u07-1",
    nextStepId: () => "step-u07-1",
    ...extra,
  };
}

function assertValidRequest(request) {
  const parsed = parseAssistantActionRequest(request);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.outcome));
  assert.deepEqual(validateActionAgainstDataset(dataset, parsed.request), []);
  return parsed.request;
}

test("local UI planner produces valid action requests for the manual workspace tools", () => {
  const plot = presetResult("diameter-time");
  const plannedPlot = planLocalAssistantAction(plannerInput("Plot burn time against diameter.", { currentPlot: plot }));
  assert.ok(plannedPlot?.request);
  const plotRequest = assertValidRequest(plannedPlot.request);
  assert.equal(plotRequest.kind, "create_plot");

  const plannedComparison = planLocalAssistantAction(
    plannerInput("Compare the recorded conditions for these runs.", { currentPlot: plot }),
  );
  assert.ok(plannedComparison?.request);
  const comparisonRequest = assertValidRequest(plannedComparison.request);
  assert.equal(comparisonRequest.kind, "explain_comparison_context");
  assert.deepEqual(comparisonRequest.request.runIds, ["FLEX-001", "FLEX-004"]);

  const plannedComparator = planLocalAssistantAction(plannerInput("Find a comparator for these runs."));
  assert.ok(plannedComparator?.request);
  const comparatorRequest = assertValidRequest(plannedComparator.request);
  assert.equal(comparatorRequest.kind, "find_comparators");
  assert.equal(comparatorRequest.request.focusCondition, "diameter");

  const plannedStep = planLocalAssistantAction(plannerInput("Pin this plot to the notebook.", { currentPlot: plot }));
  assert.ok(plannedStep?.request);
  const stepRequest = assertValidRequest(plannedStep.request);
  assert.equal(stepRequest.kind, "prepare_notebook_step");
  assert.equal(stepRequest.step.stepType, "plot");
});

test("ordinary conversation is not intercepted and an empty plot cannot be pinned", () => {
  assert.equal(planLocalAssistantAction(plannerInput("Why do these burn times differ?")), null);
  const emptySpec = scatterPlotSpec("diameter", "burn_time", { kind: "filtered-results", search: { query: "no-match" } });
  const emptyPlot = { spec: emptySpec, result: buildPlotResult(dataset, emptySpec) };
  const planned = planLocalAssistantAction(plannerInput("Pin this plot.", { currentPlot: emptyPlot }));
  assert.ok(planned);
  assert.equal(planned.request, undefined);
  assert.match(planned.reply, /Apply a plot or comparison first/);
});
