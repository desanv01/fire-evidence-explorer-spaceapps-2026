"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Dataset, Run, RunSearchRequest } from "../../lib/evidence";
import { searchRuns } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import type { NumericFieldKey } from "../../lib/upgrades/field-catalog";
import type { PlotResult, PlotSpec } from "../../lib/upgrades/plot";
import { buildPlotExportPayload } from "../../lib/upgrades/plot-workspace";
import type { PlotReplacementChoice, PlotRunSelection } from "../../lib/upgrades/plot-workspace";
import { replacePlotRunSelection, togglePlotRunSelection } from "../../lib/upgrades/plot-workspace";
import { Citation, Icon, type InspectSource } from "./elements";
import { downloadText, errorMessage } from "./files";
import {
  axisShortTitle, axisTitle, fieldLabelFor, fieldUnitFor, hasPlotFilters, omissionReasonText, plotAxisFields,
  plotCoverage, plotExportFilename, plotPresets, plotPresetForSpec, plotScopeChoice, plotSpecForPreset, plotXField,
  plotYField, scopeForChoice, type PlotPresetId, type PlotScopeChoice,
} from "./plot-model";

type Props = {
  dataset: Dataset;
  spec: PlotSpec;
  onSpecChange: (spec: PlotSpec) => void;
  result?: PlotResult;
  error: string;
  selection: PlotRunSelection;
  onSelectionChange: (runIds: string[]) => void;
  inspectedRunId?: string;
  onInspectRun: (runId: string) => void;
  search: RunSearchRequest;
  searchBusy: boolean;
  onSearch: (search: RunSearchRequest) => void;
  onCompare: () => void;
  onSelectTableMode: () => void;
  onOpenNotebook: () => void;
  onPinPlot: (spec: PlotSpec, result: PlotResult) => void;
  inspect: InspectSource;
  corpusReady: boolean;
  corpusNotice: string;
  frozenNotice: string;
};

type Domain = { min: number; max: number; ticks: number[] };

function buildDomain(values: readonly number[], targetTicks = 5): Domain {
  if (!values.length) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min) * 0.12 || 1;
    min -= pad;
    max += pad;
  }
  const padding = (max - min) * 0.07;
  min -= padding;
  max += padding;
  const raw = (max - min) / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  const step = (normal <= 1 ? 1 : normal <= 2 ? 2 : normal <= 5 ? 5 : 10) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 12) break;
  }
  if (ticks.length < 2) ticks.push(Number((start + step).toPrecision(12)));
  return {
    min: Math.min(min, ticks[0] ?? min),
    max: Math.max(max, ticks[ticks.length - 1] ?? max),
    ticks,
  };
}

function useElementWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function valueLabel(value: number, unit: string | null, original?: string | null): string {
  return `${formatEvidenceValue(value, { original })}${unit ? ` ${unit}` : ""}`;
}

function pointLabel(runId: string, spec: PlotSpec, run: Run | undefined): string {
  const yKey = plotYField(spec);
  const xKey = plotXField(spec);
  const find = (key: string) => run?.fields.find(field => field.key === key);
  const description = (key: string) => {
    const field = find(key);
    const unit = fieldUnitFor(key);
    return `${fieldLabelFor(key)} ${field && field.value !== null ? `${field.value}${unit ? ` ${unit}` : ""}` : "unknown"}`;
  };
  const y = find(yKey);
  const parts = xKey ? [description(xKey)] : [];
  parts.push(`${fieldLabelFor(yKey)} ${y && y.value !== null ? `${y.value}${fieldUnitFor(yKey) ? ` ${fieldUnitFor(yKey)}` : ""}` : "unknown"}`);
  return `${runId}: ${parts.join(", ")}`;
}

function ScatterChart({ result, spec, selectedRunIds, inspectedRunId, onInspect, dataset }: {
  result: PlotResult;
  spec: PlotSpec;
  selectedRunIds: readonly string[];
  inspectedRunId?: string;
  onInspect: (runId: string) => void;
  dataset: Dataset;
}) {
  const [container, width] = useElementWidth();
  const xKey = plotXField(spec);
  const yKey = plotYField(spec);
  const chartWidth = Math.max(320, Math.round(width || 660));
  const compact = chartWidth < 520;
  const chartHeight = compact ? 260 : 320;
  const padding = compact
    ? { left: 48, right: 16, top: 14, bottom: 46 }
    : { left: 66, right: 22, top: 16, bottom: 52 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;
  const points = xKey
    ? result.points.flatMap(point => point.x === null ? [] : [{ ...point, x: point.x }])
    : [];
  const xDomain = buildDomain(points.map(point => point.x));
  const yDomain = buildDomain(result.points.map(point => point.y));
  const px = (value: number) => padding.left + ((value - xDomain.min) / (xDomain.max - xDomain.min)) * innerWidth;
  const py = (value: number) => padding.top + (1 - (value - yDomain.min) / (yDomain.max - yDomain.min)) * innerHeight;
  const runsById = new Map(dataset.runs.map(run => [run.id, run]));

  return <div className="plot-chart" ref={container}>
    <svg className="chart-svg" width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      role="group" aria-label={`Scatterplot of ${fieldLabelFor(yKey)} against ${fieldLabelFor(xKey ?? yKey)}, ${result.points.length} recorded runs`}>
      {yDomain.ticks.map(tick => <g key={`y-${tick}`}>
        <line className="chart-grid" x1={padding.left} x2={padding.left + innerWidth} y1={py(tick)} y2={py(tick)} />
        <text className="chart-tick" x={padding.left - 8} y={py(tick) + 4} textAnchor="end">{formatEvidenceValue(tick)}</text>
      </g>)}
      {xDomain.ticks.map(tick => <text className="chart-tick" key={`x-${tick}`} x={px(tick)} y={padding.top + innerHeight + 18} textAnchor="middle">
        {formatEvidenceValue(tick)}
      </text>)}
      <text className="chart-axis-title" x={padding.left + innerWidth / 2} y={chartHeight - 8} textAnchor="middle">
        {axisTitle(xKey ?? yKey)}
      </text>
      <text className="chart-axis-title" transform={`rotate(-90 12 ${padding.top + innerHeight / 2})`}
        x={12} y={padding.top + innerHeight / 2} textAnchor="middle">{axisTitle(yKey)}</text>
      {points.map(point => {
        const inspected = point.runId === inspectedRunId;
        const selected = selectedRunIds.includes(point.runId);
        return <g key={point.runId} className={inspected ? "plot-point inspected" : "plot-point"}
          role="button" tabIndex={0} aria-label={pointLabel(point.runId, spec, runsById.get(point.runId))}
          onClick={() => onInspect(point.runId)}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onInspect(point.runId);
            }
          }}>
          <title>{pointLabel(point.runId, spec, runsById.get(point.runId))}</title>
          <circle className="point-hit" cx={px(point.x)} cy={py(point.y)} r={22} />
          {selected && <circle className="point-ring" cx={px(point.x)} cy={py(point.y)} r={inspected ? 9 : 7} />}
          <circle className="point-dot" cx={px(point.x)} cy={py(point.y)} r={inspected ? 6 : 4} />
        </g>;
      })}
    </svg>
  </div>;
}

function PointComparisonChart({ result, spec, selectedRunIds, inspectedRunId, onInspect, dataset }: {
  result: PlotResult;
  spec: PlotSpec;
  selectedRunIds: readonly string[];
  inspectedRunId?: string;
  onInspect: (runId: string) => void;
  dataset: Dataset;
}) {
  const [container, width] = useElementWidth();
  const yKey = plotYField(spec);
  const compact = (width || 660) < 520;
  const runsById = new Map(dataset.runs.map(run => [run.id, run]));
  const domain = buildDomain(result.points.map(point => point.y), 4);
  const maxValue = Math.max(domain.max, 0);
  const unit = fieldUnitFor(yKey);
  return <div className="point-chart" ref={container} aria-label={`Point comparison of ${fieldLabelFor(yKey)}`}>
    <div className="point-chart-scale" aria-hidden="true">
      <span>0</span><span>{formatEvidenceValue(maxValue)} {unit}</span>
    </div>
    {result.points.map(point => {
      const position = maxValue > 0 ? Math.max(0, Math.min(1, point.y / maxValue)) : 0;
      const inspected = point.runId === inspectedRunId;
      const selected = selectedRunIds.includes(point.runId);
      return <div className={inspected ? "point-row inspected" : "point-row"} key={point.runId}>
        <button type="button" className="text-button point-run" onClick={() => onInspect(point.runId)}
          aria-label={pointLabel(point.runId, spec, runsById.get(point.runId))}>{point.runId}</button>
        <div className="point-track">
          <span className="point-track-line" aria-hidden="true" />
          <span className={selected ? "point-track-dot selected" : "point-track-dot"} style={{ left: `${position * 100}%` }} aria-hidden="true" />
          <span className="point-track-value" style={{ left: `${position * 100}%` }}>
            {formatEvidenceValue(point.y)} {compact ? "" : unit}
          </span>
        </div>
      </div>;
    })}
    <p className="chart-legend">Each row is one selected run. Point comparison uses a common zero baseline; no trend is fitted.</p>
  </div>;
}

function SelectionTray({ selection, choice, notice, onToggle, onReplace, onCancelReplace, onCompare }: {
  selection: PlotRunSelection;
  choice?: PlotReplacementChoice;
  notice: string;
  onToggle: (runId: string) => void;
  onReplace: (runId: string) => void;
  onCancelReplace: () => void;
  onCompare: () => void;
}) {
  const atCap = selection.runIds.length >= 3;
  return <div className="selection-tray" aria-label="Shared run selection">
    <div className="selection-tray-head">
      <div className="selection-chips">
        {selection.runIds.length ? selection.runIds.map(runId => <button className="selection-chip" type="button" key={runId}
          aria-label={`Remove ${runId} from the selection`} onClick={() => onToggle(runId)}>{runId} <span aria-hidden="true">×</span></button>)
          : <span className="muted">Select one to three runs from the plot or the table.</span>}
      </div>
      <span className="muted selection-count">{selection.runIds.length} of 3 selected</span>
      <button className="primary" type="button" disabled={selection.runIds.length < 2} onClick={onCompare}>
        Compare <span aria-hidden="true">→</span>
      </button>
    </div>
    {choice && <div className="replacement-panel" role="group" aria-label="Replace a selected run">
      <strong>Three runs selected</strong>
      <p>To add {choice.incomingRunId}, explicitly choose which selected run to replace. No selection is discarded silently.</p>
      <div className="replacement-actions">
        {choice.selectionRunIds.map(runId => <button className="button" type="button" key={runId} onClick={() => onReplace(runId)}>
          Replace {runId}
        </button>)}
        <button className="button" type="button" onClick={onCancelReplace}>Cancel</button>
      </div>
    </div>}
    {notice && <p className="notice" role="alert">{notice}</p>}
    {atCap && !choice && <p className="muted selection-hint">Three runs are selected. Adding another run requires an explicit replacement.</p>}
  </div>;
}

function AxisValue({ run, fieldKey, inspect }: { run?: Run; fieldKey: NumericFieldKey; inspect: InspectSource }) {
  const field = run?.fields.find(item => item.key === fieldKey);
  if (!run || !field) return <span className="muted">Not recorded</span>;
  return <span className="plot-cell">
    <span>{field.value === null ? <span className="muted">Unknown</span> : <span className="number">
      {formatEvidenceValue(field.value, { original: field.original })}{field.unit && <small className="unit"> {field.unit}</small>}
    </span>}</span>
    <Citation runId={run.id} field={field} inspect={inspect} />
  </span>;
}

function PlotTable({ dataset, result, spec, selection, inspectedRunId, onInspect, onToggle, inspect }: {
  dataset: Dataset;
  result: PlotResult;
  spec: PlotSpec;
  selection: PlotRunSelection;
  inspectedRunId?: string;
  onInspect: (runId: string) => void;
  onToggle: (runId: string) => void;
  inspect: InspectSource;
}) {
  const runsById = new Map(dataset.runs.map(run => [run.id, run]));
  const points = new Map(result.points.map(point => [point.runId, point]));
  const omitted = new Map(result.omitted.map(item => [item.runId, item]));
  const xKey = plotXField(spec);
  const yKey = plotYField(spec);
  return <div className="table-scroll" role="region" aria-label="Plot records table" tabIndex={0}>
    <table className="plot-table">
      <thead><tr>
        <th scope="col" className="check-col"><span className="sr-only">Select</span></th>
        <th scope="col">Run</th>
        {xKey && <th scope="col">{axisShortTitle(xKey)}</th>}
        <th scope="col">{axisShortTitle(yKey)}</th>
        <th scope="col">Status</th>
      </tr></thead>
      <tbody>
        {result.resolvedRunIds.map(runId => {
          const run = runsById.get(runId);
          const point = points.get(runId);
          const omission = omitted.get(runId);
          const checked = selection.runIds.includes(runId);
          const inspected = inspectedRunId === runId;
          return <tr key={runId} className={inspected ? "inspected-row" : undefined}>
            <td className="check-col"><input type="checkbox" aria-label={`Select ${runId} for comparison`} checked={checked}
              onChange={() => onToggle(runId)} /></td>
            <th scope="row">
              <button className="text-button" type="button" onClick={() => onInspect(runId)} aria-pressed={inspected}>{runId}</button>
              <small>{run?.fields.find(field => field.key === "fuel")?.value ?? "Fuel unknown"}</small>
            </th>
            {xKey && <td><AxisValue run={run} fieldKey={xKey} inspect={inspect} /></td>}
            <td><AxisValue run={run} fieldKey={yKey} inspect={inspect} /></td>
            <td>{point
              ? <span className="plot-status included">Included</span>
              : <span className="plot-status omitted">Omitted · {omission ? omissionReasonText(omission.reasons, spec) : "Missing axis value."}</span>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export function PlotWorkspace(props: Props) {
  const { dataset, spec, result, error, selection, inspect } = props;
  const [showTable, setShowTable] = useState(false);
  const [replacement, setReplacement] = useState<PlotReplacementChoice>();
  const [selectionNotice, setSelectionNotice] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const [axisNotice, setAxisNotice] = useState("");
  const [exportError, setExportError] = useState("");
  const coverageNote = useRef<string>("");

  const xKey = plotXField(spec);
  const yKey = plotYField(spec);
  const preset = plotPresetForSpec(spec);
  const scopeChoice = plotScopeChoice(spec);
  const coverage = result ? plotCoverage(result) : undefined;
  const frozenSnapshot = Boolean(result && result.datasetVersion !== dataset.version);
  const awaitingSelection = spec.kind === "point-comparison" && spec.scope.kind === "explicit-runs" && spec.scope.runIds.length === 0;
  const inspectedFallback = selection.runIds.at(-1) && result?.points.some(point => point.runId === selection.runIds.at(-1))
    ? selection.runIds.at(-1)
    : result?.points.at(-1)?.runId;
  const inspectedRunId = props.inspectedRunId && result && result.resolvedRunIds.includes(props.inspectedRunId)
    ? props.inspectedRunId
    : inspectedFallback;

  const filteredCount = useMemo(() => {
    if (!hasPlotFilters(props.search)) return 0;
    return searchRuns(dataset, props.search).length;
  }, [dataset, props.search]);
  const fuelFilter = (props.search.filters ?? []).find(filter => filter.key === "fuel")?.value;

  function changeFuel(value: string) {
    const others = (props.search.filters ?? []).filter(filter => filter.key !== "fuel");
    const filters = value ? [...others, { key: "fuel", value }] : others;
    const nextSearch: RunSearchRequest = {
      investigation: props.search.investigation ?? "FLEX",
      ...(props.search.query ? { query: props.search.query } : {}),
      ...(filters.length ? { filters } : {}),
    };
    props.onSearch(nextSearch);
    if (spec.kind === "scatter") {
      props.onSpecChange({
        ...spec,
        scope: filters.length
          ? { kind: "filtered-results", search: nextSearch }
          : { kind: "all-reviewed-runs" },
      });
    }
  }

  function changeScope(choice: PlotScopeChoice) {
    if (spec.kind === "point-comparison") return;
    const scope = scopeForChoice(choice, props.search, selection.runIds);
    if (!scope) {
      setAxisNotice("Select at least one run before using the selected-runs scope.");
      return;
    }
    setAxisNotice("");
    props.onSpecChange({ ...spec, scope });
  }

  function applyPreset(id: PlotPresetId) {
    const next = plotSpecForPreset(id, { selectedRunIds: selection.runIds, search: props.search, y: yKey });
    setAxisNotice("");
    setShowTable(false);
    if (!next) {
      setAxisNotice(id === "selected-runs"
        ? "Select one to three runs to build a point comparison."
        : "This preset could not be built from the current scope.");
      return;
    }
    // An axis preset keeps the current scatter scope/filters; the selected-runs
    // preset deliberately switches to the ordered explicit selection.
    props.onSpecChange(id !== "selected-runs" && spec.kind === "scatter" && next.kind === "scatter"
      ? { ...next, scope: spec.scope }
      : next);
  }

  function changeAxis(axis: "x" | "y", value: string) {
    if (!plotAxisFields.includes(value as NumericFieldKey)) return;
    const field = value as NumericFieldKey;
    if (spec.kind === "scatter") {
      const other = axis === "x" ? spec.axes.y.field : spec.axes.x.field;
      if (field === other) {
        setAxisNotice("Choose two different numeric fields for the axes.");
        return;
      }
      setAxisNotice("");
      props.onSpecChange({
        ...spec,
        axes: axis === "x" ? { ...spec.axes, x: { field } } : { ...spec.axes, y: { field } },
      });
      return;
    }
    setAxisNotice("");
    props.onSpecChange({ ...spec, axes: { y: { field } } });
  }

  function toggle(runId: string) {
    try {
      const outcome = togglePlotRunSelection(selection, dataset, runId);
      if (outcome.status === "replacement-required") {
        setReplacement(outcome.choice);
        setSelectionNotice("");
        return;
      }
      setReplacement(undefined);
      setSelectionNotice("");
      props.onSelectionChange([...outcome.selection.runIds]);
      if (outcome.status === "added") props.onInspectRun(runId);
    } catch (caught) {
      setSelectionNotice(errorMessage(caught, "The selection could not be changed."));
    }
  }

  function replace(replacedRunId: string) {
    if (!replacement) return;
    try {
      const next = replacePlotRunSelection(selection, dataset, replacement, replacedRunId);
      setReplacement(undefined);
      setSelectionNotice("");
      props.onSelectionChange([...next.runIds]);
      props.onInspectRun(replacement.incomingRunId);
    } catch (caught) {
      setReplacement(undefined);
      setSelectionNotice(errorMessage(caught, "The selection changed before the replacement was applied. Choose again."));
    }
  }

  function exportRows() {
    if (!result) return;
    setExportError("");
    setExportNotice("");
    try {
      const payload = buildPlotExportPayload(dataset, spec, result);
      downloadText(plotExportFilename(spec, dataset.version), `${JSON.stringify(payload, null, 2)}\n`);
      coverageNote.current = `Exported ${payload.counts.included} plotted row${payload.counts.included === 1 ? "" : "s"} and ${payload.counts.omitted} omitted record${payload.counts.omitted === 1 ? "" : "s"} separately.`;
      setExportNotice(coverageNote.current);
    } catch (caught) {
      setExportError(errorMessage(caught, "The plot export could not be prepared."));
    }
  }

  function pin() {
    if (!result) return;
    if (result.resolvedRunIds.length === 0) {
      setExportError("An empty plot cannot be pinned as a notebook step. Change the scope or filters first.");
      return;
    }
    setExportError("");
    props.onPinPlot(spec, result);
  }

  const inspectedRun = inspectedRunId ? dataset.runs.find(run => run.id === inspectedRunId) : undefined;
  const inspectedY = inspectedRun?.fields.find(field => field.key === yKey);
  const inspectedX = xKey ? inspectedRun?.fields.find(field => field.key === xKey) : undefined;
  const inspectedSelected = inspectedRunId ? selection.runIds.includes(inspectedRunId) : false;
  const activeFilters = props.search.filters ?? [];

  const emptyCopy = coverage?.emptyScope
    ? "No records in this view"
    : coverage?.allOmitted
      ? "No plotted measurements"
      : "";

  return <>
    <div className="workspace-controls mode-controls">
      <div className="mode-cluster" role="group" aria-label="Runs workspace mode">
        <div className="segmented">
          <button type="button" aria-pressed={false} onClick={() => { /* table mode is owned by Workbench */ props.onSelectTableMode(); }}>Table</button>
          <button type="button" aria-pressed>Plot</button>
        </div>
        <span className="mode-source">NASA PSI / FLEX</span>
      </div>
      <button className="button notebook-action" type="button" onClick={props.onOpenNotebook}><Icon name="file" /> Notebook</button>
    </div>

    <div className="plot-controls">
      <div className="preset-row" role="group" aria-label="Plot presets">
        {plotPresets.map(item => <button className={preset === item.id ? "preset active" : "preset"} type="button"
          key={item.id} aria-pressed={preset === item.id} onClick={() => applyPreset(item.id)}>{item.label}</button>)}
      </div>
      <div className="plot-filter-row">
        {spec.kind === "scatter" && <label className="scope-field">Fuel
          <select aria-label="Fuel filter" value={typeof fuelFilter === "string" ? fuelFilter : ""} disabled={props.searchBusy}
            onChange={event => changeFuel(event.target.value)}>
            <option value="">All fuels</option>
            <option value="Methanol">Methanol</option>
            <option value="Heptane">Heptane</option>
          </select>
        </label>}
        <label className="scope-field">Scope
          <select aria-label="Plot scope" value={spec.kind === "point-comparison" ? "selected" : scopeChoice}
            disabled={spec.kind === "point-comparison"} onChange={event => changeScope(event.target.value as PlotScopeChoice)}>
            <option value="all">All {dataset.runs.length} reviewed runs</option>
            <option value="filtered" disabled={!activeFilters.length && !props.search.query}>Filtered results{filteredCount ? ` · ${filteredCount}` : ""}</option>
            <option value="selected" disabled={!selection.runIds.length}>Selected runs · {selection.runIds.length}</option>
          </select>
        </label>
      </div>
    </div>

    {(activeFilters.length > 0 || props.search.query) && <div className="active-filters">
      <span className="muted">Active filters</span>
      {props.search.query && <span className="pill">Search: {props.search.query}</span>}
      {activeFilters.map((filter, index) => <span className="pill" key={`${filter.key}-${index}`}>{fieldLabelFor(filter.key)}: {filter.value === null ? "Unknown" : String(filter.value)}</span>)}
      <button className="button" type="button" disabled={props.searchBusy} onClick={() => {
        props.onSearch({ investigation: "FLEX" });
        if (spec.kind === "scatter") props.onSpecChange({ ...spec, scope: { kind: "all-reviewed-runs" } });
      }}>Clear filters</button>
    </div>}

    {props.corpusNotice && <p className="notice" role="alert">{props.corpusNotice}</p>}
    {props.frozenNotice && <p className="notice frozen-notice" role="status">{props.frozenNotice}</p>}

    <div className="plot-layout">
      <div className="plot-main">
        {showTable ? <section className="card plot-card" aria-labelledby="plot-table-heading">
          <h2 id="plot-table-heading"><Icon name="chevron" /> Included records</h2>
          <div className="plot-card-body">
            <div className="coverage-inline">
              {result && <>
                <strong>{result.includedCount}</strong><span className="muted">of {result.resolvedRunIds.length} resolved rows plotted</span>
                {result.omittedCount > 0 && <span className="pill">{result.omittedCount} omitted for these axes</span>}
              </>}
              <button className="button" type="button" onClick={() => setShowTable(false)}>Back to plot</button>
            </div>
            <p className="plot-subtitle">{spec.kind === "scatter"
              ? `${axisShortTitle(xKey as NumericFieldKey)} × ${axisShortTitle(yKey)}`
              : `${axisShortTitle(yKey)} by selected run`}
              {spec.scope.kind === "filtered-results" ? " · filtered results" : spec.scope.kind === "explicit-runs" ? " · selected runs" : " · all reviewed runs"}
            </p>
            {result && <PlotTable dataset={dataset} result={result} spec={spec} selection={selection}
              inspectedRunId={inspectedRunId} onInspect={props.onInspectRun} onToggle={toggle} inspect={inspect} />}
            {!result && !awaitingSelection && <p className="empty" role={error ? "alert" : "status"}>{error || props.corpusNotice || "The records table is unavailable."}</p>}
            {!result && awaitingSelection && <p className="empty" role="status">Select one to three runs in the Runs table, then return to Plot.</p>}
          </div>
        </section>
          : <section className="card plot-card" aria-labelledby="plot-heading">
            <h2 id="plot-heading"><Icon name="chevron" /> {spec.kind === "scatter" ? "Visual Evidence Lab" : "Selected outcome"}</h2>
            <span className="plot-kind">{spec.kind === "scatter" ? "Scatterplot" : "Point comparison"}</span>
            <div className="plot-card-body">
              <div className="axis-row">
                {spec.kind === "scatter" && <label className="axis-field">X axis
                  <select value={spec.axes.x.field} disabled={!props.corpusReady}
                    onChange={event => changeAxis("x", event.target.value)}>
                    {plotAxisFields.map(key => <option key={key} value={key}>{axisShortTitle(key)}</option>)}
                  </select>
                </label>}
                <label className="axis-field">Y axis
                  <select value={yKey} disabled={!props.corpusReady} onChange={event => changeAxis("y", event.target.value)}>
                    {plotAxisFields.map(key => <option key={key} value={key}>{axisShortTitle(key)}</option>)}
                  </select>
                </label>
              </div>
              {axisNotice && <p className="notice" role="status">{axisNotice}</p>}
              {awaitingSelection ? <div className="plot-empty" role="status">
                <p className="plot-empty-title">Select runs to compare</p>
                <p className="muted">Choose one to three runs from the Runs table. Each selected run becomes one recorded point.</p>
                <button className="button" type="button" onClick={props.onSelectTableMode}>Open Runs table</button>
              </div>
                : error ? <p className="notice" role="alert">{error}</p>
                  : !result ? <div className="plot-empty" role="status">
                    <p className="plot-empty-title">{props.corpusNotice ? "Deterministic plot paused" : "Building the plot…"}</p>
                    <p className="muted">{props.corpusNotice || "Reading recorded values from the reviewed corpus."}</p>
                  </div>
                    : emptyCopy ? <div className="plot-empty" role="status">
                      <p className="plot-empty-title">{emptyCopy}</p>
                      <p className="muted">{coverage?.emptyScope
                        ? "Nothing has been plotted or inferred. Clear the active filters or change the scope to all reviewed runs."
                        : `All ${result.resolvedRunIds.length} resolved runs lack a required axis measurement. Zero values would remain plotted; missing values never are.`}</p>
                      <div className="plot-empty-actions">
                        <button className="button" type="button" disabled={!activeFilters.length && !props.search.query} onClick={() => {
                          props.onSearch({ investigation: "FLEX" });
                          if (spec.kind === "scatter") props.onSpecChange({ ...spec, scope: { kind: "all-reviewed-runs" } });
                        }}>Clear filters</button>
                        <button className="button" type="button" onClick={() => changeScope("all")}>Change scope</button>
                      </div>
                    </div>
                      : spec.kind === "scatter"
                        ? <ScatterChart result={result} spec={spec} dataset={dataset} selectedRunIds={selection.runIds}
                          inspectedRunId={inspectedRunId} onInspect={props.onInspectRun} />
                        : <PointComparisonChart result={result} spec={spec} dataset={dataset} selectedRunIds={selection.runIds}
                          inspectedRunId={inspectedRunId} onInspect={props.onInspectRun} />}
              <div className="plot-card-foot">
                <span className="chart-legend"><span className="legend-dot" aria-hidden="true" /> One point = one recorded run</span>
                {result && <button className="text-button table-alternative" type="button" onClick={() => setShowTable(true)}>Table alternative ↗</button>}
              </div>
              {result && result.limitations.length > 0 && <details className="plot-limits">
                <summary>Plot limitations</summary>
                <ul>{result.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
              </details>}
            </div>
          </section>}

        <SelectionTray selection={selection} choice={replacement} notice={selectionNotice}
          onToggle={toggle} onReplace={replace} onCancelReplace={() => setReplacement(undefined)} onCompare={props.onCompare} />

        <section className="card coverage-card" aria-labelledby="coverage-heading">
          <h2 id="coverage-heading"><Icon name="chevron" /> Plot coverage</h2>
          <div className="coverage-body">
            {result ? <>
              <div className="coverage-stats">
                <div><strong>{result.includedCount}<small>/{result.resolvedRunIds.length}</small></strong><span>Included records</span></div>
                <div><strong>{result.omittedCount}</strong><span>Missing an axis value</span></div>
                <button className="button" type="button" onClick={() => setShowTable(!showTable)}>{showTable ? "Back to plot" : "Inspect coverage"}</button>
              </div>
              {result.omitted.length > 0 && <div className="omission-list">
                <strong>Omitted from this plot</strong>
                <ul>{result.omitted.map(item => <li key={item.runId}>{item.runId}: {omissionReasonText(item.reasons, spec)}</li>)}</ul>
                <p className="muted">These rows remain in the corpus. They are not plotted or exported as numeric rows; their run IDs and omission reasons stay in the export metadata.</p>
              </div>}
              <p className="coverage-note">Zero stays zero. Missing values are excluded only when required by an axis.</p>
            </> : <p className="muted" role="status">{awaitingSelection ? "No scope yet: select runs to build a point comparison." : props.corpusNotice || error || "Coverage is unavailable until the plot builds."}</p>}
          </div>
        </section>
      </div>

      <div className="plot-side">
        <section className="card point-card" aria-labelledby="point-heading">
          <h2 id="point-heading"><Icon name="chevron" /> Inspected point</h2>
          <div className="point-body">
            {!inspectedRun || !result ? <p className="muted">{result?.points.length ? "Choose a plotted point or a table row to inspect its recorded values." : "No plotted point is available to inspect."}</p>
              : <>
                <p className="point-run-line">{inspectedRun.id} · {String(inspectedRun.fields.find(field => field.key === "fuel")?.value ?? "Fuel unknown")}</p>
                <p className="point-value">{formatEvidenceValue(inspectedY?.value ?? null, { original: inspectedY?.original })}
                  {inspectedY?.unit && <span className="unit"> {inspectedY.unit}</span>}
                </p>
                <p className="point-field-name">{fieldLabelFor(yKey)} {inspectedY && <Citation runId={inspectedRun.id} field={inspectedY} inspect={inspect} />}</p>
                {spec.kind === "scatter" && <div className="point-axis">
                  <span>{fieldLabelFor(xKey as NumericFieldKey)}</span>
                  <strong>{formatEvidenceValue(inspectedX?.value ?? null, { original: inspectedX?.original })}{inspectedX?.unit ? ` ${inspectedX.unit}` : ""}</strong>
                  {inspectedX && <Citation runId={inspectedRun.id} field={inspectedX} inspect={inspect} />}
                </div>}
                <p className="plot-note">A recorded measurement, not a fitted or simulated value.</p>
                <div className="point-actions">
                  {inspectedY && <button className="button" type="button" onClick={event => inspect(inspectedRun.id, inspectedY.key, event.currentTarget)}>Open source</button>}
                  <button className="button" type="button" onClick={() => toggle(inspectedRun.id)}>
                    {inspectedSelected ? "Remove from selection" : "Add to selection"}
                  </button>
                </div>
              </>}
          </div>
        </section>

        <section className="card keep-card" aria-labelledby="keep-heading">
          <h2 id="keep-heading"><Icon name="chevron" /> Keep this view</h2>
          <div className="keep-body">
            <p>Save the axes, filters, rows and source references as a notebook snapshot. Saving the notebook itself stays a separate explicit step.</p>
            <div className="keep-actions">
              <button className="primary" type="button" disabled={!result || !props.corpusReady || (result?.resolvedRunIds.length ?? 0) === 0} onClick={pin}>Pin plot</button>
              <button className="button" type="button" disabled={!result || !props.corpusReady || frozenSnapshot} onClick={exportRows}>Export rows + spec</button>
            </div>
            {frozenSnapshot && <p className="muted">This frozen snapshot uses corpus {result?.datasetVersion}. Export needs that exact corpus, so it is unavailable here; pin the snapshot to keep it.</p>}
            {result && result.resolvedRunIds.length === 0 && <p className="muted">A valid zero-row plot cannot be pinned; export still produces a zero-row payload with its scope and limitations.</p>}
            {exportError && <p className="notice" role="alert">{exportError}</p>}
            {exportNotice && <p className="notice" role="status">{exportNotice}</p>}
            <p className="plot-note">No trend line or causal inference is added. The {dataset.runs.length}-run subset is not representative of all combustion experiments.</p>
            {result && <details className="plot-limits">
              <summary>Evidence limits</summary>
              <ul>{result.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
            </details>}
          </div>
        </section>
      </div>
    </div>
  </>;
}
