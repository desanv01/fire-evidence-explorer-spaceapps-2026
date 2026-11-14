"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dataset, RunField } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import { buildSelectedRunsContext, searchComparators } from "../../lib/upgrades/comparison-engine";
import {
  buildComparisonExportPayload, buildComparisonPresentation, buildComparisonUnavailablePresentation, comparisonExportJson,
  type ComparisonAvailablePresentation, type ComparisonLimitationCard,
} from "../../lib/upgrades/comparison-presentation";
import {
  contextEvidenceCategoryLabels, gasCompositionLimitations, type ComparatorRequest, type ComparatorSearchResult,
  type ComparisonContextField, type ComparisonContextResult, type SelectedRunsContextResult,
} from "../../lib/upgrades/comparison-context";
import { fieldDefinitionByKey, type ConditionFieldKey, type NumericFieldKey } from "../../lib/upgrades/field-catalog";
import type { StableFieldReference } from "../../lib/upgrades/provenance";
import { Citation, Icon, type InspectSource } from "./elements";
import { downloadText, errorMessage } from "./files";

type Props = {
  dataset: Dataset;
  runIds: string[];
  corpusReady: boolean;
  corpusNotice: string;
  inspect: InspectSource;
  onOpenNotebook: () => void;
  onOpenMeasurements: () => void;
  onOpenRuns: () => void;
  onPinComparison: (context: SelectedRunsContextResult) => void;
  onOpenPair: (runIds: string[]) => void;
  appliedComparator?: { result: ComparatorSearchResult; key: string };
};

type ComparatorState =
  | { status: "idle" }
  | { status: "unavailable"; message: string }
  | {
    status: "done";
    result: ComparatorSearchResult;
    presentation: ComparisonAvailablePresentation;
    unavailable?: undefined;
  };

const statusLabel: Record<ComparisonContextField["status"], string> = {
  same: "Exact match",
  different: "Different",
  unknown: "Unknown",
  incompatible: "Incompatible",
};

function fieldUnit(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(fieldDefinitionByKey, key)
    ? fieldDefinitionByKey[key as keyof typeof fieldDefinitionByKey].nativeUnit
    : null;
}

function fieldLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(fieldDefinitionByKey, key)
    ? fieldDefinitionByKey[key as keyof typeof fieldDefinitionByKey].label
    : key;
}

function deltaText(field: ComparisonContextField): string {
  return field.deltas.map(delta => `${delta.toRunId} minus ${delta.fromRunId}: ${formatEvidenceValue(delta.delta, { signed: true })} ${delta.unit}`).join("; ");
}

function pairedDelta(field: ComparisonContextField | undefined): string | null {
  if (!field || field.status !== "different" || !field.deltas.length) return null;
  const delta = field.deltas[0];
  return `${delta.fromRunId} → ${delta.toRunId}: ${formatEvidenceValue(delta.delta, { signed: true })} ${delta.unit}`;
}

function valueText(field: ComparisonContextField, runId: string): string {
  const cell = field.cells.find(item => item.runId === runId);
  if (!cell || cell.value === null) return "Unknown";
  const unit = field.unit ? ` ${field.unit}` : "";
  return `${formatEvidenceValue(cell.value, { original: cell.original })}${unit}`;
}

function comparisonCardFor(presentation: ComparisonAvailablePresentation | undefined, kind: ComparisonLimitationCard["kind"]) {
  if (!presentation) return undefined;
  return presentation.contexts[0]?.cards.find(card => card.kind === kind)
    ?? presentation.globalCards.find(card => card.kind === kind);
}

export function ComparisonContextView(props: Props) {
  const { dataset, runIds, corpusReady, inspect } = props;
  const [exportNotice, setExportNotice] = useState("");
  const [exportError, setExportError] = useState("");
  const [focus, setFocus] = useState<ConditionFieldKey>("diameter");
  const [ruleMode, setRuleMode] = useState<"exact" | "tolerance">("exact");
  const [toleranceField, setToleranceField] = useState<NumericFieldKey>("pressure");
  const [toleranceValue, setToleranceValue] = useState("1");
  const [comparator, setComparator] = useState<ComparatorState>({ status: "idle" });
  const [comparatorError, setComparatorError] = useState("");

  const context = useMemo((): { result?: SelectedRunsContextResult; presentation?: ComparisonAvailablePresentation; error: string } => {
    if (!corpusReady) return { error: "" };
    if (runIds.length < 2) return { error: "" };
    try {
      const result = buildSelectedRunsContext(dataset, { version: "comparison-context-request-1", kind: "selected-runs", runIds });
      const presentation = buildComparisonPresentation(dataset, result);
      return { result, presentation, error: "" };
    } catch (caught) {
      return { error: errorMessage(caught, "The comparison context could not be built.") };
    }
  }, [dataset, runIds, corpusReady]);

  const result = context.result;
  const presentation = context.presentation;
  const contextPresentation = presentation?.contexts[0];
  const runList = runIds.join("-");

  const availableFocus = useMemo(() => {
    if (!result) return [] as ConditionFieldKey[];
    return result.conditions.map(field => field.key as ConditionFieldKey);
  }, [result]);

  const toleranceFields = useMemo(() => {
    if (!result) return [] as NumericFieldKey[];
    return result.conditions
      .filter(field => field.key !== focus && field.unit !== null)
      .map(field => field.key as NumericFieldKey);
  }, [result, focus]);

  useEffect(() => {
    if (availableFocus.length && !availableFocus.includes(focus)) setFocus(availableFocus[0]);
  }, [availableFocus, focus]);

  useEffect(() => {
    if (toleranceFields.length && !toleranceFields.includes(toleranceField)) setToleranceField(toleranceFields[0]);
  }, [toleranceFields, toleranceField]);

  useEffect(() => {
    setComparator({ status: "idle" });
    setComparatorError("");
  }, [dataset, runList]);

  useEffect(() => {
    if (!props.appliedComparator) return;
    try {
      const nextPresentation = buildComparisonPresentation(dataset, props.appliedComparator.result);
      setComparator({ status: "done", result: props.appliedComparator.result, presentation: nextPresentation });
      setComparatorError("");
    } catch (caught) {
      setComparator({ status: "unavailable", message: errorMessage(caught) });
    }
  }, [props.appliedComparator, dataset]);

  function citationFor(reference: StableFieldReference | null | undefined) {
    if (!reference) return null;
    const field: RunField | undefined = dataset.runs.find(run => run.id === reference.runId)?.fields.find(item => item.key === reference.fieldKey);
    if (!field) return null;
    return <Citation runId={reference.runId} field={field} inspect={inspect} />;
  }

  function exportComparison(source: ComparisonContextResult) {
    setExportNotice("");
    setExportError("");
    try {
      const payload = buildComparisonExportPayload(dataset, source);
      const name = source.kind === "selected-runs-context" ? source.runIds.join("-") : `comparator-${source.request.referenceRunId}`;
      downloadText(`fire-evidence-comparison-${name}.json`, comparisonExportJson(payload));
      setExportNotice("Deterministic comparison JSON prepared. It is not the signed evidence brief.");
    } catch (caught) {
      setExportError(errorMessage(caught, "The comparison export could not be prepared."));
    }
  }

  function runComparator() {
    if (!result || !runIds.length) return;
    setComparatorError("");
    let tolerance: number | undefined;
    if (ruleMode === "tolerance") {
      tolerance = Number(toleranceValue);
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        setComparatorError("Enter a non-negative finite tolerance in the field's native unit.");
        return;
      }
      if (!toleranceFields.includes(toleranceField)) {
        setComparatorError("Choose a numeric condition field for the tolerance; unknown or categorical fields cannot carry one.");
        return;
      }
    }
    const request: ComparatorRequest = {
      version: "comparison-context-request-1",
      kind: "comparator",
      referenceRunId: runIds[0],
      focusCondition: focus,
      candidateScope: { kind: "all-reviewed-runs" },
      ...(ruleMode === "tolerance" && tolerance !== undefined
        ? { matching: { mode: "tolerance" as const, tolerances: [{ field: toleranceField, tolerance }] } }
        : {}),
    };
    try {
      const searchResult = searchComparators(dataset, request);
      const nextPresentation = buildComparisonPresentation(dataset, searchResult);
      setComparator({ status: "done", result: searchResult, presentation: nextPresentation });
    } catch (caught) {
      setComparator({ status: "unavailable", message: errorMessage(caught, "The comparator search is unavailable.") });
    }
  }

  if (!corpusReady) {
    return <div className="card status-card"><h2>Comparison context paused</h2><p role="alert">{props.corpusNotice || "The corpus identity could not be verified."}</p></div>;
  }

  if (runIds.length < 2) {
    return <div className="card status-card">
      <h2>Choose two or three runs</h2>
      <p>The recorded-condition context describes an ordered pair or trio. The current selection has {runIds.length} run{runIds.length === 1 ? "" : "s"}.</p>
      <button className="primary" type="button" onClick={props.onOpenRuns}>Choose runs</button>
    </div>;
  }

  if (context.error) {
    const unavailable = buildComparisonUnavailablePresentation({ code: "service-unavailable", message: context.error });
    return <div className="stack">
      <div className="card status-card"><h2>Comparison context unavailable</h2><p role="alert">{context.error}</p>
        <button className="button" type="button" onClick={props.onOpenMeasurements}>Open Measurements</button></div>
      <section className="card"><h2><Icon name="chevron" /> {unavailable.cards[0].title}</h2>
        <div className="card-body"><p>{unavailable.message}</p></div></section>
    </div>;
  }

  if (!result || !presentation) {
    return <p className="empty" role="status">Building the recorded comparison context…</p>;
  }

  const outcomeFields = result.outcomes;
  const outputField = outcomeFields.find(field => field.key === "burn_time")
    ?? outcomeFields.find(field => field.status === "different")
    ?? outcomeFields[0];
  const outputDelta = result.runIds.length === 2 ? pairedDelta(outputField) : null;
  const outcomeMax = Math.max(0, ...(outputField?.cells.flatMap(cell => typeof cell.value === "number" ? [cell.value] : []) ?? []));
  const gasKeys = result.gasComposition.fieldKeys;
  const nonGasConditions = result.conditions.filter(field => !gasKeys.includes(field.key as typeof gasKeys[number]));
  const unresolved = [...result.conditions, ...result.outcomes].filter(field => field.status === "unknown" || field.status === "incompatible");
  const unknownOutcomes = result.outcomes.filter(field => field.status === "unknown" || field.status === "incompatible");
  const causality = result.evidence.find(item => item.category === "not-established");
  const formRequiredLabels = result.conditions.filter(field => field.key !== focus).map(field => field.label);
  const comparatorResult = comparator.status === "done" ? comparator.result : undefined;
  const comparatorPresentation = comparator.status === "done" ? comparator.presentation : undefined;
  const searchState = comparatorPresentation?.searchState ?? "not-applicable";
  const nearestCards = comparatorPresentation?.globalCards.filter(card => card.kind === "nearest-ineligible") ?? [];

  return <>
    <div className="workspace-controls mode-controls">
      <div className="mode-cluster" role="group" aria-label="Compare workspace mode">
        <div className="segmented">
          <button type="button" aria-pressed={false} onClick={props.onOpenMeasurements}>Measurements</button>
          <button type="button" aria-pressed>Context</button>
        </div>
        <span className="mode-source">NASA PSI / FLEX</span>
      </div>
      <button className="button notebook-action" type="button" onClick={props.onOpenNotebook}><Icon name="file" /> Notebook</button>
    </div>

    <div className="context-order-row">
      <p className="context-order">{result.runIds.join(" → ")}</p>
      <span className="muted">{result.conditions.length} conditions · {result.outcomes.length} outcomes · Rule {result.contextRuleVersion}</span>
    </div>

    <div className="context-grid">
      <div className="context-column">
        <section className="card outcome-card" aria-labelledby="outcome-heading">
          <h2 id="outcome-heading"><Icon name="chevron" /> Recorded outcome</h2>
          <div className="outcome-body">
            <p className="outcome-caption">{outputField ? `${outputField.label} · ${result.runIds.length === 2 ? `${result.runIds[1]} minus ${result.runIds[0]}` : "ordered pairwise differences"}` : "No reviewed outcome"}</p>
            {outputField ? <>
              <p className="outcome-delta">{result.runIds.length === 2 && outputField.deltas[0]
                ? <>{formatEvidenceValue(outputField.deltas[0].delta, { signed: true })}<span className="unit"> {outputField.unit}</span></>
                : outputField.cells.map(cell => <span key={cell.runId}>{cell.runId} {valueText(outputField, cell.runId)}</span>)}</p>
              {outputField.status === "different" && <p className="outcome-kind">Computed comparison</p>}
              {outputField.status === "same" && <p className="outcome-kind">Recorded values match exactly</p>}
              {outputField.status === "unknown" && <p className="outcome-kind muted">Unknown; no difference can be computed</p>}
              {outputField.status === "incompatible" && <p className="outcome-kind muted">Incompatible recorded values</p>}
              {result.runIds.length > 2 && outputField.deltas.length > 0 && <ul className="delta-list">
                {outputField.deltas.map(delta => <li key={`${delta.fromRunId}-${delta.toRunId}`}>{delta.toRunId} minus {delta.fromRunId}: <strong>{formatEvidenceValue(delta.delta, { signed: true })} {delta.unit}</strong></li>)}
              </ul>}
              <div className="outcome-bars">
                {outputField.cells.map((cell, index) => {
                  const value = typeof cell.value === "number" ? cell.value : null;
                  return <div className="outcome-bar" key={cell.runId}>
                    <span>{cell.runId} · {valueText(outputField, cell.runId)}</span>
                    <div className="track" aria-hidden="true"><span className={index === 0 ? "first-bar" : undefined}
                      style={{ width: `${value !== null && outcomeMax > 0 ? Math.max(2, value / outcomeMax * 100) : 0}%` }} /></div>
                  </div>;
                })}
              </div>
              <div className="not-established">
                <strong>Not established by these records</strong>
                <p>{causality?.text ?? "The recorded outcome difference does not establish its cause. Unrecorded conditions may also affect outcomes."}</p>
              </div>
            </> : <p className="empty">No reviewed outcome field is recorded for these runs.</p>}
          </div>
        </section>

        <section className="card find-comparator" aria-labelledby="comparator-heading">
          <h2 id="comparator-heading"><Icon name="chevron" /> Find a comparator</h2>
          <div className="card-body">
            <label className="axis-field">Focus variable
              <select value={focus} onChange={event => setFocus(event.target.value as ConditionFieldKey)}>
                {availableFocus.map(key => <option key={key} value={key}>{fieldLabel(key)}</option>)}
              </select>
            </label>
            <label className="axis-field">Matching rule
              <select value={ruleMode} onChange={event => setRuleMode(event.target.value as "exact" | "tolerance")}>
                <option value="exact">Exact matching</option>
                <option value="tolerance">Inclusive tolerance</option>
              </select>
            </label>
            {ruleMode === "tolerance" && <div className="tolerance-row">
              <label>Tolerance field
                <select value={toleranceField} onChange={event => setToleranceField(event.target.value as NumericFieldKey)}>
                  {toleranceFields.map(key => <option key={key} value={key}>{fieldDefinitionByKey[key].label}</option>)}
                </select>
              </label>
              <label>Tolerance ({fieldUnit(toleranceField) ?? "native unit"})
                <input type="number" min="0" step="any" value={toleranceValue} onChange={event => setToleranceValue(event.target.value)} />
              </label>
            </div>}
            <div className="rule-callout">
              <strong>Rule: {ruleMode === "exact" ? "exact matching only" : "inclusive native-unit tolerance"}</strong>
              <p>{formRequiredLabels.length
                ? `Same ${formRequiredLabels.join(", ").toLowerCase()}. The focus variable is excluded from required matching.`
                : "Every reviewed condition except the focus variable is required."}</p>
              {ruleMode === "tolerance" && <p>Inclusive boundary: a difference exactly equal to {toleranceValue || "0"} {fieldUnit(toleranceField) ?? ""} still counts as a match for {fieldDefinitionByKey[toleranceField].label}.</p>}
            </div>
            <p className="comparator-note">A tolerance is a search rule, not scientific equivalence. Unknown conditions never count as matches.</p>
            <div className="comparator-actions">
              <button className="primary" type="button" onClick={runComparator}>Run comparator search</button>
              <button className="button" type="button" onClick={() => { setRuleMode("exact"); setComparator({ status: "idle" }); setComparatorError(""); }}>Reset rule</button>
            </div>
            {comparatorError && <p className="notice" role="alert">{comparatorError}</p>}
            {comparator.status === "unavailable" && <div className="notice" role="alert">
              <strong>Comparator search unavailable</strong>
              <p>{comparator.message}</p>
              <p>No eligible, nearest or empty result is being shown for this failure.</p>
            </div>}
          </div>
        </section>
      </div>

      <div className="context-column">
        <section className="card conditions-card" aria-labelledby="conditions-heading">
          <h2 id="conditions-heading"><Icon name="chevron" /> Recorded conditions</h2>
          <div className="table-scroll" role="region" aria-label="Recorded conditions table" tabIndex={0}>
            <table className="condition-table">
              <thead><tr><th scope="col">Condition</th>{result.runIds.map(runId => <th key={runId} scope="col">{runId.replace("FLEX-", "")}</th>)}</tr></thead>
              <tbody>{nonGasConditions.map(field => <tr key={field.key}>
                <th scope="row">{field.label}{field.unit && <small>{field.unit}</small>}</th>
                {result.runIds.map(runId => <td key={runId}>
                  <span className={field.status === "different" ? "condition-value different" : "condition-value"}>{valueText(field, runId)}</span>
                  {citationFor(field.cells.find(cell => cell.runId === runId)?.reference)}
                </td>)}
              </tr>)}
              {nonGasConditions.map(field => <tr className="status-row" key={`${field.key}-status`}>
                <th scope="row"><span className={`field-status ${field.status}`}>{statusLabel[field.status]}</span></th>
                <td colSpan={result.runIds.length}>
                  {field.status === "different" && <span>{deltaText(field)}</span>}
                  {field.status === "unknown" && <span>{field.reason}</span>}
                  {field.status === "incompatible" && <span>{field.reason}</span>}
                  {field.status === "same" && <span>Recorded values match exactly.</span>}
                </td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="gas-block">
            <h3>Initial ambient gas composition</h3>
            <div className="table-scroll" role="region" aria-label="Full recorded gas composition" tabIndex={0}>
              <table className="gas-table">
                <thead><tr><th scope="col">Gas fraction</th>{result.runIds.map(runId => <th key={runId} scope="col">{runId.replace("FLEX-", "")}</th>)}</tr></thead>
                <tbody>{gasKeys.map(key => {
                  const field = result.conditions.find(item => item.key === key);
                  return <tr key={key}>
                    <th scope="row">{fieldDefinitionByKey[key].label}<small>{fieldDefinitionByKey[key].nativeUnit}</small></th>
                    {result.runIds.map(runId => <td key={runId}>{field ? valueText(field, runId) : "Unknown"}</td>)}
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <p>{gasCompositionLimitations.linked}</p>
            <ul className="gas-differences">{gasKeys.map(key => {
              const field = result.conditions.find(item => item.key === key);
              if (!field) return <li key={key}>{fieldDefinitionByKey[key].label}: Unknown; the field is absent from these recorded runs.</li>;
              return <li key={key}>
                <span>{fieldDefinitionByKey[key].label}: <span className={`field-status ${field.status}`}>{statusLabel[field.status]}</span></span>
                {field.status === "different" && <span className="gas-delta">{deltaText(field)}</span>}
                {field.status === "unknown" && <span className="gas-delta">{field.reason}</span>}
              </li>;
            })}</ul>
          </div>
          <div className="card-foot">
            <span>{result.gasComposition.complete ? gasCompositionLimitations.complete : gasCompositionLimitations.incomplete}</span>
            <div className="card-actions">
              <button className="button" type="button" disabled={!result} onClick={() => exportComparison(result)}>Export comparison JSON</button>
              <button className="button" type="button" disabled={!result} onClick={() => props.onPinComparison(result)}>Pin comparison</button>
            </div>
            {exportError && <p className="notice" role="alert">{exportError}</p>}
            {exportNotice && <p className="notice" role="status">{exportNotice}</p>}
          </div>
        </section>

        <section className="card unknown-card" aria-labelledby="unknown-heading">
          <h2 id="unknown-heading"><Icon name="chevron" /> {unknownOutcomes.length === 1 ? "One unknown outcome" : unknownOutcomes.length ? `${unknownOutcomes.length} unresolved outcomes` : "Recorded outcomes"}</h2>
          <div className="card-body">
            {unknownOutcomes.length === 0 && unresolved.length === 0 && <p className="muted">Every recorded condition and outcome has a known value for this ordered set. Matching recorded values still cannot establish scientific equivalence.</p>}
            {unknownOutcomes.map(field => <div className="unknown-entry" key={field.key}>
              <strong>{field.cells.filter(cell => cell.value === null).map(cell => cell.runId).join(", ")} · {field.label}</strong>
              <p>Unknown in the source. {field.reason}</p>
              {field.cells.map(cell => cell.reference ? <span key={cell.runId}>{citationFor(cell.reference)}</span> : null)}
            </div>)}
            {unresolved.filter(field => !unknownOutcomes.includes(field)).map(field => <div className="unknown-entry" key={field.key}>
              <strong>{field.label}</strong><p>{field.reason}</p>
              {field.cells.map(cell => cell.reference ? <span key={cell.runId}>{citationFor(cell.reference)}</span> : null)}
            </div>)}
            <div className="not-established">
              <strong>An outcome difference cannot be computed for an unknown value</strong>
              <p>Unknown measurements stay unknown. No value is interpolated or silently dropped.</p>
            </div>
          </div>
        </section>

        {comparator.status === "done" && comparatorResult && comparatorPresentation && <section className="card comparator-results" aria-labelledby="comparator-results-heading">
          <h2 id="comparator-results-heading"><Icon name="chevron" /> Comparator search</h2>
          <div className="card-body">
            <p className="comparator-summary">
              {searchState === "eligible"
                ? `${comparatorResult.outcome.kind === "eligible-match" ? comparatorResult.outcome.candidates.length : 0} eligible candidate${(comparatorResult.outcome.kind === "eligible-match" ? comparatorResult.outcome.candidates.length : 0) === 1 ? "" : "s"} under this rule · ${comparatorResult.evaluatedCount} evaluated.`
                : searchState === "empty"
                  ? "No candidate runs were in scope after excluding the reference run. This is an empty search, not an engine failure."
                  : "No eligible comparator under this rule. Nearest ineligible candidates are listed separately and are not matches."}
            </p>
            {comparatorPresentation.matching && <div className="rule-callout">
              <strong>{comparatorPresentation.matching.mode === "exact" ? "Exact matching" : "Inclusive tolerance"} · focus {fieldLabel(comparatorResult.request.focusCondition)}</strong>
              <p>{comparatorPresentation.matching.mode === "tolerance"
                ? comparatorPresentation.matching.tolerances.map(item => `${item.label} ≤ ${formatEvidenceValue(item.tolerance)} ${item.unit} (inclusive)`).join("; ")
                : `Required: ${comparatorPresentation.requiredMatchFieldKeys.map(fieldLabel).join(", ")}.`}</p>
            </div>}
            {(comparatorResult.outcome.kind === "eligible-match" ? comparatorResult.outcome.candidates : comparatorResult.outcome.nearestCandidates).map(candidate => {
              const mismatched = candidate.mismatchedFieldKeys.map(fieldLabel);
              const unknown = candidate.unknownFieldKeys.map(fieldLabel);
              const incompatible = candidate.incompatibleFieldKeys.map(fieldLabel);
              const firstReference = candidate.context.conditions.find(field => candidate.mismatchedFieldKeys.includes(field.key))
                ?.cells.find(cell => cell.runId === candidate.runId)?.reference ?? null;
              return <div className="candidate" key={candidate.runId}>
                <div className="candidate-head"><strong>{candidate.runId}</strong>
                  <span className={`field-status ${candidate.disposition === "eligible" ? "same" : "different"}`}>{candidate.disposition === "eligible" ? "Eligible" : "Nearest ineligible"}</span>
                </div>
                {mismatched.length > 0 && <p>Mismatched: {mismatched.join(", ")}.</p>}
                {unknown.length > 0 && <p>Unknown: {unknown.join(", ")}.</p>}
                {incompatible.length > 0 && <p>Incompatible: {incompatible.join(", ")}.</p>}
                {candidate.disposition === "eligible" && <p className="muted">{candidate.context.conditions.length} conditions and {candidate.context.outcomes.length} outcomes recorded for the pair.</p>}
                <div className="candidate-actions">
                  {citationFor(firstReference)}
                  <button className="button" type="button" onClick={() => props.onOpenPair([comparatorResult.request.referenceRunId, candidate.runId])}>
                    Compare reference and {candidate.runId}
                  </button>
                </div>
              </div>;
            })}
            {nearestCards.length > 0 && <p className="comparator-note">{nearestCards[0].text}</p>}
            <div className="card-actions">
              <button className="button" type="button" onClick={() => exportComparison(comparatorResult)}>Export comparator JSON</button>
              <button className="button" type="button" onClick={props.onOpenMeasurements}>Open Measurements</button>
            </div>
            {exportError && <p className="notice" role="alert">{exportError}</p>}
            {exportNotice && <p className="notice" role="status">{exportNotice}</p>}
          </div>
        </section>}

        <section className="card limits-card" aria-labelledby="limits-heading">
          <h2 id="limits-heading"><Icon name="chevron" /> Evidence limits</h2>
          <div className="card-body">
            <ul className="limits-list">
              {result.limitations.map(limit => <li key={limit}>{limit}</li>)}
              {contextPresentation?.conditions.map(field => field.status === "incompatible"
                ? <li key={`incompatible-${field.key}`}>{field.label}: {field.reason}</li> : null)}
            </ul>
            {presentation && presentation.contexts[0]?.cards.filter(card => card.kind === "extinction-estimate" || card.kind === "gas-composition").map(card =>
              <p className="muted" key={card.id}>{card.text}</p>)}
            <p className="muted">{comparisonCardFor(presentation, "causality")?.text ?? comparisonContextLimitationsCausal()}</p>
          </div>
        </section>
      </div>
    </div>
  </>;
}

function comparisonContextLimitationsCausal(): string {
  return "Recorded condition differences cannot establish a causal conclusion. Unrecorded conditions may also affect outcomes.";
}

/** Evidence category labels are part of the accepted context contract. */
export const comparisonEvidenceLabels = contextEvidenceCategoryLabels;
