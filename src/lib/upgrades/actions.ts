import { z } from "zod";
import type { Dataset } from "../evidence.ts";
import {
  canonicalRunIdSchema,
  corpusIssue,
  datasetVersionSchema,
  resolveStableFieldReference,
  type CorpusValidationIssue,
} from "./provenance.ts";
import {
  comparatorRequestSchema,
  comparatorSearchResultSchema,
  selectedRunsContextRequestSchema,
  selectedRunsContextResultSchema,
  validateComparisonContextRequestAgainstDataset,
} from "./comparison-context.ts";
import {
  notebookStepSchema,
} from "./notebook.ts";
import {
  plotResultSchema,
  plotSpecSchema,
  validatePlotResultAgainstDataset,
  validatePlotSpecAgainstDataset,
} from "./plot.ts";
import { upgradeContractVersions } from "./versions.ts";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const limitationSchema = z.string().min(1).max(300);

export const actionKindSchema = z.enum([
  "create_plot",
  "explain_comparison_context",
  "find_comparators",
  "prepare_notebook_step",
]);
export type ActionKind = z.infer<typeof actionKindSchema>;

export const assistantActionEffectSchema = z.enum(["read-only", "state-changing"]);
export type AssistantActionEffect = z.infer<typeof assistantActionEffectSchema>;

export const assistantActionCatalog = {
  create_plot: {
    effect: "read-only",
    requiresUserApproval: false,
    description: "Compute a typed plot from the active corpus; does not change the saved notebook.",
  },
  explain_comparison_context: {
    effect: "read-only",
    requiresUserApproval: false,
    description: "Explain recorded condition/outcome differences for the explicitly requested runs.",
  },
  find_comparators: {
    effect: "read-only",
    requiresUserApproval: false,
    description: "Search the active corpus for candidates under an explicit matching rule.",
  },
  prepare_notebook_step: {
    effect: "state-changing",
    requiresUserApproval: true,
    description: "Prepare an immutable notebook step; saving requires explicit user approval.",
  },
} as const satisfies Record<ActionKind, {
  effect: AssistantActionEffect;
  requiresUserApproval: boolean;
  description: string;
}>;

export function actionEffect(kind: ActionKind): AssistantActionEffect {
  return assistantActionCatalog[kind].effect;
}

export function requiresUserApproval(kind: ActionKind): boolean {
  return assistantActionCatalog[kind].requiresUserApproval;
}

/**
 * Binds a proposed action to the turn, workspace, dataset and selection that
 * produced it. Later selections cannot be used silently.
 */
export const assistantActionContextSchema = z.strictObject({
  workspaceId: identifierSchema,
  turnId: identifierSchema,
  datasetVersion: datasetVersionSchema,
  selectedRunIds: z.array(canonicalRunIdSchema).max(3)
    .refine((ids) => new Set(ids).size === ids.length, "Use distinct selected run IDs"),
  selectionRevision: z.int().nonnegative(),
});
export type AssistantActionContext = z.infer<typeof assistantActionContextSchema>;

const actionRequestBase = {
  version: z.literal(upgradeContractVersions.assistantAction),
  actionId: identifierSchema,
  context: assistantActionContextSchema,
};

export const createPlotActionRequestSchema = z.strictObject({
  ...actionRequestBase,
  kind: z.literal("create_plot"),
  plot: plotSpecSchema,
});

export const explainComparisonContextActionRequestSchema = z.strictObject({
  ...actionRequestBase,
  kind: z.literal("explain_comparison_context"),
  request: selectedRunsContextRequestSchema,
});

export const findComparatorsActionRequestSchema = z.strictObject({
  ...actionRequestBase,
  kind: z.literal("find_comparators"),
  request: comparatorRequestSchema,
});

export const prepareNotebookStepActionRequestSchema = z.strictObject({
  ...actionRequestBase,
  kind: z.literal("prepare_notebook_step"),
  step: notebookStepSchema,
});

export const assistantActionRequestSchema = z.discriminatedUnion("kind", [
  createPlotActionRequestSchema,
  explainComparisonContextActionRequestSchema,
  findComparatorsActionRequestSchema,
  prepareNotebookStepActionRequestSchema,
]).superRefine((request, context) => {
  if (request.kind === "prepare_notebook_step" && request.step.datasetVersion !== request.context.datasetVersion) {
    context.addIssue({
      code: "custom",
      path: ["step", "datasetVersion"],
      message: "Notebook step version differs from the action context",
    });
  }
});
export type AssistantActionRequest = z.infer<typeof assistantActionRequestSchema>;
export type CreatePlotActionRequest = z.infer<typeof createPlotActionRequestSchema>;
export type ExplainComparisonContextActionRequest = z.infer<typeof explainComparisonContextActionRequestSchema>;
export type FindComparatorsActionRequest = z.infer<typeof findComparatorsActionRequestSchema>;
export type PrepareNotebookStepActionRequest = z.infer<typeof prepareNotebookStepActionRequestSchema>;
export const staleActionContextReasonSchema = z.enum([
  "workspace",
  "turn",
  "dataset-version",
  "selection",
  "selection-revision",
]);
export type StaleActionContextReason = z.infer<typeof staleActionContextReasonSchema>;

export type ActionContextCheck =
  | { status: "current" }
  | { status: "stale"; reasons: StaleActionContextReason[] };

/** Pure check against the caller's current workspace context. */
export function checkActionContext(
  requestContext: AssistantActionContext,
  activeContext: AssistantActionContext,
): ActionContextCheck {
  const reasons: StaleActionContextReason[] = [];
  if (requestContext.workspaceId !== activeContext.workspaceId) reasons.push("workspace");
  if (requestContext.turnId !== activeContext.turnId) reasons.push("turn");
  if (requestContext.datasetVersion !== activeContext.datasetVersion) reasons.push("dataset-version");
  if (requestContext.selectionRevision !== activeContext.selectionRevision) reasons.push("selection-revision");
  if (requestContext.selectedRunIds.length !== activeContext.selectedRunIds.length
    || requestContext.selectedRunIds.some((runId, index) => runId !== activeContext.selectedRunIds[index])) {
    reasons.push("selection");
  }
  return reasons.length ? { status: "stale", reasons } : { status: "current" };
}

export const actionInvalidCodeSchema = z.enum([
  "invalid-action",
  "unknown-run",
  "unknown-field",
  "invalid-plot",
  "invalid-context",
  "unknown-source",
]);
export type ActionInvalidCode = z.infer<typeof actionInvalidCodeSchema>;

export const actionIssueSummarySchema = z.strictObject({
  path: z.string().min(1).max(200),
  message: z.string().min(1).max(300),
});

export const actionUnavailableCodeSchema = z.enum([
  "provider-disabled",
  "budget-exhausted",
  "service-unavailable",
]);

export const assistantActionOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plot-result"), result: plotResultSchema }),
  z.strictObject({ kind: z.literal("comparison-context"), result: selectedRunsContextResultSchema }),
  z.strictObject({ kind: z.literal("comparator-search"), result: comparatorSearchResultSchema }),
  z.strictObject({ kind: z.literal("notebook-step"), step: notebookStepSchema }),
  z.strictObject({
    kind: z.literal("unavailable"),
    code: actionUnavailableCodeSchema,
    message: limitationSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("invalid"),
    code: actionInvalidCodeSchema,
    issues: z.array(actionIssueSummarySchema).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal("stale-context"),
    reasons: z.array(staleActionContextReasonSchema).min(1).max(5),
  }),
]);
export type AssistantActionOutcome = z.infer<typeof assistantActionOutcomeSchema>;

export const actionFailureSchema = z.strictObject({
  code: z.enum(["execution-failed", "internal-error"]),
  message: z.string().min(1).max(300),
});
export type ActionFailure = z.infer<typeof actionFailureSchema>;

const actionRecordBase = {
  request: assistantActionRequestSchema,
  effect: assistantActionEffectSchema,
};
const actionSuccessKinds = {
  create_plot: "plot-result",
  explain_comparison_context: "comparison-context",
  find_comparators: "comparator-search",
  prepare_notebook_step: "notebook-step",
} as const satisfies Record<ActionKind, AssistantActionOutcome["kind"]>;

export const assistantActionRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...actionRecordBase,
    status: z.literal("proposed"),
  }),
  z.strictObject({
    ...actionRecordBase,
    status: z.literal("approved"),
    approvedAt: timestampSchema,
  }),
  z.strictObject({
    ...actionRecordBase,
    status: z.literal("executed"),
    approvedAt: timestampSchema.nullable(),
    executedAt: timestampSchema,
    outcome: assistantActionOutcomeSchema,
  }),
  z.strictObject({
    ...actionRecordBase,
    status: z.literal("failed"),
    failedAt: timestampSchema,
    error: actionFailureSchema,
  }),
  z.strictObject({
    ...actionRecordBase,
    status: z.literal("cancelled"),
    cancelledAt: timestampSchema,
    reason: limitationSchema.optional(),
  }),
]).superRefine((record, context) => {
  if (record.effect !== actionEffect(record.request.kind)) {
    context.addIssue({ code: "custom", path: ["effect"], message: "Action effect does not match the allowlisted operation" });
  }
  if (record.status === "approved" && !requiresUserApproval(record.request.kind)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Read-only actions do not require an approval state",
    });
  }
  if (record.status === "executed") {
    if (requiresUserApproval(record.request.kind) && record.approvedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "State-changing actions require approval before execution",
      });
    }
    if (!requiresUserApproval(record.request.kind) && record.approvedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "Read-only actions execute without an approval timestamp",
      });
    }
    const expected = actionSuccessKinds[record.request.kind];
    if (!["unavailable", "invalid", "stale-context", expected].includes(record.outcome.kind)) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "kind"],
        message: `Unexpected outcome for ${record.request.kind}`,
      });
    }
  }
});
export type AssistantActionRecord = z.infer<typeof assistantActionRecordSchema>;

/**
 * Corpus-aware action validation. Schema parsing alone cannot establish run
 * membership, source identity or dataset freshness.
 */
export function validateActionAgainstDataset(
  dataset: Dataset,
  request: AssistantActionRequest,
  path = "action",
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  if (request.context.datasetVersion !== dataset.version) {
    issues.push(corpusIssue(
      `${path}.context.datasetVersion`,
      "version-mismatch",
      `Action dataset version ${request.context.datasetVersion} does not match ${dataset.version}`,
    ));
    return issues;
  }
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  for (const [index, runId] of request.context.selectedRunIds.entries()) {
    if (!knownRunIds.has(runId)) {
      issues.push(corpusIssue(`${path}.context.selectedRunIds.${index}`, "unknown-run", `Unknown run ID: ${runId}`));
    }
  }

  switch (request.kind) {
    case "create_plot":
      issues.push(...validatePlotSpecAgainstDataset(dataset, request.plot, `${path}.plot`));
      break;
    case "explain_comparison_context":
      issues.push(...validateComparisonContextRequestAgainstDataset(dataset, request.request, `${path}.request`));
      break;
    case "find_comparators":
      issues.push(...validateComparisonContextRequestAgainstDataset(dataset, request.request, `${path}.request`));
      break;
    case "prepare_notebook_step":
      issues.push(...validateNotebookStepAgainstDataset(dataset, request.step, `${path}.step`));
      break;
  }
  return issues;
}

export function validateNotebookStepAgainstDataset(
  dataset: Dataset,
  step: z.infer<typeof notebookStepSchema>,
  path = "step",
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  if (step.datasetVersion !== dataset.version) {
    issues.push(corpusIssue(
      `${path}.datasetVersion`,
      "version-mismatch",
      `Step dataset version ${step.datasetVersion} does not match ${dataset.version}`,
    ));
    return issues;
  }
  const knownRunIds = new Set(dataset.runs.map(({ id }) => id));
  for (const [index, runId] of step.resolvedRunIds.entries()) {
    if (!knownRunIds.has(runId)) {
      issues.push(corpusIssue(`${path}.resolvedRunIds.${index}`, "unknown-run", `Unknown run ID: ${runId}`));
    }
  }
  for (const [index, reference] of step.sourceReferences.entries()) {
    const resolution = resolveStableFieldReference(dataset, reference);
    if (resolution.status !== "resolved") {
      issues.push(corpusIssue(
        `${path}.sourceReferences.${index}`,
        resolution.status === "dataset-version-mismatch" ? "version-mismatch"
          : resolution.status === "unknown-run" ? "unknown-run"
          : resolution.status === "unknown-field" ? "unknown-field"
          : resolution.status === "unknown-source" ? "unknown-source" : "source-mismatch",
        `Source reference did not resolve: ${reference.runId}/${reference.fieldKey}`,
      ));
    }
  }
  if (step.stepType === "plot") {
    issues.push(...validatePlotResultAgainstDataset(dataset, step.plotResult, `${path}.plotResult`));
  }
  if (step.stepType === "comparison") {
    issues.push(...validateComparisonContextRequestAgainstDataset(dataset, step.request, `${path}.request`));
  }
  return issues;
}
