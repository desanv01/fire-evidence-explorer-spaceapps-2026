"use client";

import type { Dataset } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import type { AssistantActionCard, AssistantActionCardEvidence } from "../../lib/upgrades/action-cards";
import { coordinates, Icon, type InspectSource } from "./elements";
import { fieldLabelFor, omissionReasonText } from "./plot-model.ts";

type Props = {
  card: AssistantActionCard;
  busy: boolean;
  dataset: Dataset;
  inspect: InspectSource;
  onConfirm: (actionId: string, trigger: HTMLButtonElement) => void;
  onCancel: (actionId: string) => void;
  onOpenWorkspace: (card: AssistantActionCard) => void;
};

const kindLabels: Record<AssistantActionCard["kind"], string> = {
  create_plot: "Create plot",
  explain_comparison_context: "Comparison context",
  find_comparators: "Find comparators",
  prepare_notebook_step: "Prepare notebook step",
};

const confirmLabels: Record<AssistantActionCard["kind"], string> = {
  create_plot: "Apply plot",
  explain_comparison_context: "Inspect context",
  find_comparators: "Run comparator search",
  prepare_notebook_step: "Review & pin step",
};

function fieldLabel(key: string): string {
  return fieldLabelFor(key);
}

function phaseLabel(card: AssistantActionCard): string {
  if (card.phase === "proposed") return card.requiresUserApproval ? "Ready to review" : "Ready to run";
  if (card.phase === "approved") return "Approved";
  if (card.phase === "executed") return "Result";
  if (card.phase === "cancelled") return "Cancelled";
  return "Failed";
}

function visibleSources(card: AssistantActionCard) {
  const references = card.sourceReferences.length
    ? card.sourceReferences
    : card.payload.kind === "prepare_notebook_step"
      ? card.payload.step.sourceReferences
      : [];
  const unique = new Map<string, (typeof references)[number]>();
  for (const reference of references) {
    unique.set(`${reference.runId}:${reference.fieldKey}:${reference.sourceId}`, reference);
  }
  return [...unique.values()].slice(0, 6);
}

function EvidenceLine({ evidence, inspect }: { evidence: AssistantActionCardEvidence; inspect: InspectSource }) {
  return <li className="card-evidence">
    <span>{evidence.text}</span>
    {evidence.numbers.length > 0 && <span className="muted"> {evidence.numbers.map(number =>
      `${number.label}: ${formatEvidenceValue(number.value)} ${number.unit}`).join(" · ")}</span>}
    {evidence.sourceReferences.slice(0, 2).map(reference => <button className="citation" type="button"
      key={`${reference.runId}-${reference.fieldKey}`}
      onClick={event => inspect(reference.runId, reference.fieldKey, event.currentTarget)}>
      {reference.runId} · {fieldLabel(reference.fieldKey)} <Icon name="link" />
    </button>)}
  </li>;
}

function CardContent({ card }: { card: AssistantActionCard }) {
  const content = card.content;
  if (!content) return null;
  if (content.kind === "plot") {
    const omitted = content.result.omitted;
    const spec = card.payload.kind === "create_plot" ? card.payload.plot
      : card.request.kind === "create_plot" ? card.request.plot : null;
    return <div className="card-result">
      <p>{content.empty
        ? "The requested scope resolved to zero runs. This is a valid empty plot, not an all-omitted result."
        : `${content.pointCount} plotted point${content.pointCount === 1 ? "" : "s"} · ${content.omittedCount} omitted for these axes.`}</p>
      {omitted.length > 0 && <ul className="card-result-list">{omitted.map(item => <li key={item.runId}>
        {item.runId}: {spec ? omissionReasonText(item.reasons, spec) : "Required axis value unavailable."}
      </li>)}</ul>}
    </div>;
  }
  if (content.kind === "comparison-context") {
    return <div className="card-result">
      <p>{content.result.runIds.join(" vs ")} · {content.result.conditions.length} conditions · {content.result.outcomes.length} outcomes.</p>
      <ul className="card-result-list">{content.result.outcomes.flatMap(field => field.deltas.slice(0, 2).map(delta =>
        <li key={`${field.key}-${delta.fromRunId}-${delta.toRunId}`}>
          {field.label}: {delta.toRunId} minus {delta.fromRunId} = {formatEvidenceValue(delta.delta, { signed: true })} {delta.unit}
        </li>))}</ul>
      {content.result.outcomes.some(field => field.status === "unknown") && <p className="muted">At least one recorded outcome is unknown; no difference is computed for it.</p>}
      <p className="muted">{content.result.gasComposition.complete ? "All four recorded gas fractions are shown together." : "At least one recorded gas fraction is unknown."}</p>
    </div>;
  }
  if (content.kind === "comparator-search") {
    const outcome = content.result.outcome;
    return <div className="card-result">
      <p>{outcome.kind === "eligible-match"
        ? `${outcome.candidates.length} eligible candidate${outcome.candidates.length === 1 ? "" : "s"} · ${content.result.evaluatedCount} evaluated.`
        : content.result.resolvedCandidateRunIds.length === 0
          ? "Empty candidate scope: no run remained after excluding the reference run."
          : `No eligible comparator · ${outcome.nearestCandidates.length} nearest ineligible candidate${outcome.nearestCandidates.length === 1 ? "" : "s"} listed separately.`}</p>
      <ul className="card-result-list">{content.candidates.map(candidate => <li key={candidate.runId}>
        <strong>{candidate.runId}</strong> · {candidate.disposition === "eligible" ? "eligible" : "nearest, not a match"}
        {candidate.mismatchedFieldKeys.length > 0 && ` · mismatched: ${candidate.mismatchedFieldKeys.map(fieldLabel).join(", ")}`}
        {candidate.unknownFieldKeys.length > 0 && ` · unknown: ${candidate.unknownFieldKeys.map(fieldLabel).join(", ")}`}
      </li>)}</ul>
    </div>;
  }
  return <div className="card-result">
    <p>{content.step.title} · {content.step.stepType === "plot" ? "plot snapshot" : content.step.stepType === "comparison" ? "comparison snapshot" : "trusted answer snapshot"} · corpus {content.step.datasetVersion}.</p>
    <p className="muted">Prepared, not saved. Confirm adds the immutable step to the notebook draft; the notebook Save action stays separate.</p>
  </div>;
}

export function AssistantActionCardView({ card, busy, dataset, inspect, onConfirm, onCancel, onOpenWorkspace }: Props) {
  const sources = visibleSources(card);
  const limitations = card.limitations.length
    ? card.limitations
    : card.payload.kind === "prepare_notebook_step" ? card.payload.step.limitations : [];
  const showConfirm = card.canApprove || card.canExecute;
  const stale = card.outcome?.kind === "stale-context";
  const unavailable = card.outcome?.kind === "unavailable";
  const invalid = card.outcome?.kind === "invalid";

  return <article className={`action-card phase-${card.phase}${stale || unavailable || invalid ? " caution" : ""}`}
    id={`card-${card.actionId}`} tabIndex={-1} aria-labelledby={`card-title-${card.actionId}`}>
    <p className="action-kicker">{kindLabels[card.kind]} · {phaseLabel(card)}</p>
    <h3 id={`card-title-${card.actionId}`}>{card.title}</h3>
    <p className="action-summary">{card.summary}</p>
    {card.notice && <p className={`action-notice${stale || unavailable || invalid ? " alert" : ""}`}
      role={stale || unavailable || invalid ? "alert" : "status"}>{card.notice}</p>}

    <CardContent card={card} />

    {card.evidence.length > 0 && <ul className="card-evidence-list">
      {card.evidence.slice(0, 4).map((evidence, index) => <EvidenceLine key={index} evidence={evidence} inspect={inspect} />)}
    </ul>}

    {sources.length > 0 && <div className="card-sources" role="group" aria-label="Sources for this action">
      {sources.map(reference => {
        const field = dataset.runs.find(run => run.id === reference.runId)?.fields.find(item => item.key === reference.fieldKey);
        const cell = field ? coordinates(field.locator)?.cell : undefined;
        return <button className="citation" type="button" key={`${reference.runId}-${reference.fieldKey}-${reference.sourceId}`}
          aria-label={`Inspect ${reference.runId} ${fieldLabel(reference.fieldKey)} source`}
          onClick={event => inspect(reference.runId, reference.fieldKey, event.currentTarget)}>
          {reference.runId} · {fieldLabel(reference.fieldKey)}{cell ? ` · ${cell}` : ""} <Icon name="link" />
        </button>;
      })}
    </div>}

    {limitations.length > 0 && <details className="card-limits">
      <summary>Limits</summary>
      <ul>{limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
    </details>}

    <div className="action-controls">
      {showConfirm && <button className="primary" type="button" disabled={busy}
        onClick={event => onConfirm(card.actionId, event.currentTarget)}>
        {busy ? "Working…" : confirmLabels[card.kind]}
      </button>}
      {card.canCancel && <button className="button" type="button" disabled={busy} onClick={() => onCancel(card.actionId)}>Cancel</button>}
      {card.phase === "executed" && <button className="button" type="button" onClick={() => onOpenWorkspace(card)}>
        {card.kind === "prepare_notebook_step" ? "Open notebook" : card.kind === "create_plot" ? "Open Visual Evidence Lab" : "Open comparison context"}
      </button>}
      {(stale || invalid) && <button className="button" type="button" onClick={() => onOpenWorkspace(card)}>Review current context</button>}
    </div>
    <p id={`card-status-${card.actionId}`} tabIndex={-1} className="sr-only" role="status">
      {card.phase === "executed" ? "Action result updated." : card.phase === "cancelled" ? "Action cancelled." : ""}
    </p>
  </article>;
}
