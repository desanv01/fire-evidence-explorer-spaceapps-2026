/**
 * U07 local action planner + the U09 integration boundary.
 *
 * The planner is intentionally deterministic: it maps a small set of manual
 * workspace requests ("plot …", "compare …", "find a comparator", "pin …") to
 * the accepted `assistant-action-1` requests using only the current corpus,
 * current selection and already-validated results. It never calls a provider.
 *
 * U09 can replace this planner with a server-side one by passing
 * `AssistantActionPlanner` into the Workbench. The typed request produced at
 * that boundary is still parsed and corpus-validated by the local action
 * registry before anything runs.
 */
import type { Dataset, RunSearchRequest } from "../../lib/evidence";
import type { EvidenceExplanation } from "../../lib/evidence-client";
import type { AssistantActionContext, AssistantActionRequest } from "../../lib/upgrades/actions";
import type { ConditionFieldKey, NumericFieldKey } from "../../lib/upgrades/field-catalog.ts";
import { conditionFieldKeys, fieldDefinitionByKey } from "../../lib/upgrades/field-catalog.ts";
import type { EvidenceAnswerSnapshot } from "../../lib/upgrades/notebook";
import {
  createComparisonNotebookStep, createEvidenceAnswerNotebookStep, createPlotNotebookStep, snapshotEvidenceAnswer,
} from "../../lib/upgrades/notebook-engine.ts";
import type { PlotResult, PlotSpec } from "../../lib/upgrades/plot";
import type { RunScope } from "../../lib/upgrades/scope";
import type { SelectedRunsContextResult } from "../../lib/upgrades/comparison-context";
import { pointComparisonPlotSpec, scatterPlotSpec } from "./plot-model.ts";

export type PlannerInput = {
  question: string;
  dataset: Dataset;
  context: AssistantActionContext;
  selectedRunIds: readonly string[];
  search: RunSearchRequest;
  currentPlot?: { spec: PlotSpec; result: PlotResult };
  currentComparison?: SelectedRunsContextResult;
  trustedAnswer?: EvidenceExplanation;
  nextActionId: () => string;
  nextStepId: () => string;
};

export type PlannedAction =
  | { reply: string; request?: undefined }
  | {
    reply: string;
    request: AssistantActionRequest;
    trustedAnswerSnapshot?: EvidenceAnswerSnapshot;
  };

export type AssistantActionPlanner = (input: PlannerInput) => PlannedAction | null;

const fieldAliases: readonly { key: NumericFieldKey; words: readonly string[] }[] = [
  { key: "extinction_diameter", words: ["extinction diameter", "extinction"] },
  { key: "burning_rate", words: ["burning rate", "burn rate"] },
  { key: "burn_time", words: ["burn time", "burn-time", "burn_time", "duration"] },
  { key: "diameter", words: ["diameter"] },
  { key: "oxygen", words: ["oxygen", "o2", "o₂"] },
  { key: "pressure", words: ["pressure"] },
];

function matchedFields(question: string): NumericFieldKey[] {
  let working = question.toLowerCase();
  const found: NumericFieldKey[] = [];
  for (const alias of fieldAliases) {
    for (const word of alias.words) {
      if (working.includes(word)) {
        found.push(alias.key);
        working = working.replaceAll(word, " ");
        break;
      }
    }
  }
  return found;
}

function pairFor(question: string): { x: NumericFieldKey; y: NumericFieldKey } {
  const fields = matchedFields(question);
  for (const field of fields) {
    if (field === "diameter") return { x: "diameter", y: "burn_time" };
    if (field === "burn_time") return { x: "diameter", y: "burn_time" };
    if (field === "oxygen") return { x: "oxygen", y: "burning_rate" };
    if (field === "burning_rate") return { x: "oxygen", y: "burning_rate" };
    if (field === "pressure") return { x: "pressure", y: "burn_time" };
    if (field === "extinction_diameter") return { x: "diameter", y: "extinction_diameter" };
  }
  return { x: "diameter", y: "burn_time" };
}

function hasRun(dataset: Dataset, runId: string): boolean {
  return dataset.runs.some(run => run.id === runId);
}

function presentCondition(dataset: Dataset, preferred: ConditionFieldKey): ConditionFieldKey {
  const present = new Set(dataset.runs.flatMap(run => run.fields.map(field => field.key)));
  const conditions = conditionFieldKeys.filter(key => present.has(key));
  if (conditions.includes(preferred)) return preferred;
  return conditions.find(key => key === "diameter") ?? conditions[0] ?? preferred;
}

function plotTitle(spec: PlotSpec): string {
  const label = (key: string) => fieldDefinitionByKey[key as keyof typeof fieldDefinitionByKey].label;
  const title = spec.kind === "scatter"
    ? `${label(spec.axes.x.field)} × ${label(spec.axes.y.field)}`
    : `${label(spec.axes.y.field)} by selected run`;
  return title.slice(0, 160);
}

export function planLocalAssistantAction(input: PlannerInput): PlannedAction | null {
  const question = input.question.trim();
  if (!question) return null;
  const lower = question.toLowerCase();
  const selection = input.selectedRunIds.slice(0, 3);
  const wantsSelected = /selected|these runs|this run|current runs|my runs/.test(lower);
  const { dataset, context } = input;

  const plotIntent = /\bplot\b|\bchart\b|\bscatter\b/.test(lower);
  const comparatorIntent = /comparator|similar run|nearest|find another|find a run/.test(lower);
  const notebookIntent = /\bpin\b|notebook step|save.*notebook|keep this view/.test(lower);
  const comparisonIntent = /\bcompare\b|\bcomparison\b|condition|context|difference/.test(lower);

  if (notebookIntent) {
    const wantsComparison = comparisonIntent && input.currentComparison;
    if (wantsComparison || !input.currentPlot) {
      if (input.currentComparison) {
        const contextResult = input.currentComparison;
        const step = createComparisonNotebookStep({
          stepId: input.nextStepId(),
          title: `${contextResult.runIds.join(" vs ")} context`.slice(0, 160),
          context: contextResult,
        });
        return {
          reply: "I’ve prepared an immutable comparison snapshot for review. Adding it to the notebook draft requires your confirmation; saving stays explicit.",
          request: {
            version: "assistant-action-1",
            actionId: input.nextActionId(),
            kind: "prepare_notebook_step",
            context,
            step,
          },
        };
      }
    }
    if (input.currentPlot && input.currentPlot.result.resolvedRunIds.length > 0) {
      const step = createPlotNotebookStep({
        stepId: input.nextStepId(),
        title: plotTitle(input.currentPlot.spec),
        plotSpec: input.currentPlot.spec,
        plotResult: input.currentPlot.result,
      });
      return {
        reply: "I’ve prepared a frozen plot snapshot for review. It captures the axes, rows, source references and limitations; saving the notebook is a separate step.",
        request: {
          version: "assistant-action-1",
          actionId: input.nextActionId(),
          kind: "prepare_notebook_step",
          context,
          step,
        },
      };
    }
    if (input.trustedAnswer) {
      const step = createEvidenceAnswerNotebookStep({
        stepId: input.nextStepId(),
        title: `Answer · ${input.trustedAnswer.runIds.join(" · ")}`.slice(0, 160),
        answer: input.trustedAnswer,
      });
      return {
        reply: "I’ve prepared a stored-answer snapshot for review. The receipt marker stays not-verified; adding it to the notebook requires your confirmation.",
        request: {
          version: "assistant-action-1",
          actionId: input.nextActionId(),
          kind: "prepare_notebook_step",
          context,
          step,
        },
        trustedAnswerSnapshot: snapshotEvidenceAnswer(input.trustedAnswer),
      };
    }
    return { reply: "Apply a plot or comparison first, or ask a question that returns a validated answer, and I can prepare a notebook step for your review." };
  }

  if (plotIntent) {
    const { x, y } = pairFor(question);
    const scope: RunScope = wantsSelected && selection.length
      ? { kind: "explicit-runs", runIds: [...selection] }
      : { kind: "all-reviewed-runs" };
    const spec = scatterPlotSpec(x, y, scope);
    return {
      reply: "I can open a plot of the recorded values. The workspace will calculate the points from the reviewed corpus; no value is interpolated.",
      request: {
        version: "assistant-action-1",
        actionId: input.nextActionId(),
        kind: "create_plot",
        context,
        plot: spec,
      },
    };
  }

  if (comparatorIntent) {
    const referenceRunId = selection.find(runId => hasRun(dataset, runId)) ?? dataset.runs[0]?.id;
    if (!referenceRunId) return { reply: "No reviewed run is available as a comparator reference." };
    const focusCondition = presentCondition(dataset, "diameter");
    return {
      reply: `I can search the reviewed corpus for runs matching ${referenceRunId} on every recorded condition except ${fieldDefinitionByKey[focusCondition].label}. Unknown conditions never count as matches.`,
      request: {
        version: "assistant-action-1",
        actionId: input.nextActionId(),
        kind: "find_comparators",
        context,
        request: {
          version: "comparison-context-request-1",
          kind: "comparator",
          referenceRunId,
          focusCondition,
          candidateScope: { kind: "all-reviewed-runs" },
        },
      },
    };
  }

  if (comparisonIntent) {
    const ordered = selection.filter(runId => hasRun(dataset, runId));
    if (ordered.length < 2) {
      return { reply: "Select two or three runs first. Then I can describe their recorded conditions, outcomes and source references; I will not infer causes." };
    }
    return {
      reply: "I can describe the recorded conditions and outcomes for the ordered runs. Differences are computed from the stored values only.",
      request: {
        version: "assistant-action-1",
        actionId: input.nextActionId(),
        kind: "explain_comparison_context",
        context,
        request: {
          version: "comparison-context-request-1",
          kind: "selected-runs",
          runIds: ordered,
        },
      },
    };
  }

  return null;
}

/** Convenience for point-comparison actions from the workspace: ordered runs. */
export function pointComparisonActionSpec(y: NumericFieldKey, runIds: readonly string[]): PlotSpec {
  return pointComparisonPlotSpec(y, runIds);
}
