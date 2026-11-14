import { useState } from "react";
import type { ComparisonResult } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import { Citation, FieldValue, Icon, fieldLabel, type InspectSource } from "./elements";

type Row = ComparisonResult["rows"][number];
const states = [
  { id: "same", label: "Same", color: "#2bc58c" },
  { id: "different", label: "Different", color: "#eaa966" },
  { id: "unknown", label: "Unknown", color: "#747474" },
  { id: "incompatible", label: "Incompatible", color: "#b49dca" },
] as const;

function BurnTime({ row }: { row: Row | undefined }) {
  const compatible = row?.status !== "incompatible";
  const entries = row?.cells.flatMap(({ runId, field }) => compatible && field?.unit === "s" && typeof field.value === "number" && field.value >= 0
    ? [{ runId, value: field.value, original: field.original }]
    : []) ?? [];
  const highest = Math.max(0, ...entries.map(item => item.value));
  const step = Math.max(1, Math.ceil(highest / 4));
  const extent = step * 4;
  const delta = row?.cells.length === 2 ? row.differences[0]?.delta : undefined;
  return <section className="card burn-card" aria-labelledby="burn-heading">
    <h2 id="burn-heading"><Icon name="chevron" /> Burn time</h2>
    {entries.length > 0 ? <>
      <div className="metric">
        <strong>{delta === undefined ? "Duration by run" : <>{formatEvidenceValue(delta, { signed: true })}<span> s</span></>}</strong>
        <p>{delta === undefined ? "Recorded burn times" : "Recorded burn-time difference"}</p>
      </div>
      <div className="chart">
        <div className="chart-scale" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>{i * step}{i === 4 && " s"}</span>)}</div>
        {entries.map(({ runId, value, original }, index) => <div className="chart-row" key={runId}>
          <div><span>{runId}</span><span>{formatEvidenceValue(value, { original })} s</span></div>
          <div className="track" aria-hidden="true"><span className={index === 0 ? "first-bar" : undefined} style={{ width: `${value / extent * 100}%` }} /></div>
        </div>)}
        <small>Recorded duration</small>
      </div>
    </> : <p className="empty">No comparable burn times were recorded.</p>}
  </section>;
}

function ComparisonSummary({ rows, inspect }: { rows: Row[]; inspect: InspectSource }) {
  const summary = states.map(state => ({ ...state, count: rows.filter(row => row.status === state.id).length }));
  let edge = 0;
  const segments = summary.filter(state => state.count > 0).map(state => {
    const start = edge;
    edge += state.count / rows.length * 100;
    return `${state.color} ${start}% ${edge}%`;
  });
  const missing = rows.flatMap(row => row.cells.flatMap(cell => cell.field && cell.field.value === null ? [{ ...cell, field: cell.field }] : []));
  return <section className="card summary-card" aria-labelledby="summary-heading">
    <h2 id="summary-heading"><Icon name="chevron" /> Comparison summary</h2>
    <div className="summary-graphic">
      <div className="donut" style={{ background: segments.length ? `conic-gradient(from -90deg, ${segments.join(", ")})` : "#747474" }}>
        <div><span>Fields compared</span><strong>{rows.length}</strong></div>
      </div>
      <ul className="legend">
        {summary.filter(state => state.id !== "incompatible" || state.count > 0).map(state => <li key={state.id}><i style={{ background: state.color }} /> {state.label} <strong>{state.count}</strong></li>)}
      </ul>
    </div>
    {missing.length > 0 && <div className="limit">
      <strong>{missing.length === 1 ? "One unresolved value" : `${missing.length} unresolved values`}</strong>
      <p>{missing[0].runId} has no recorded value for {missing[0].field.label.toLowerCase()}.</p>
      <Citation runId={missing[0].runId} field={missing[0].field} inspect={inspect} />
    </div>}
  </section>;
}

export function Comparison({ result, inspect }: { result: ComparisonResult; inspect: InspectSource }) {
  const [filter, setFilter] = useState("all");
  const rows = filter === "all" ? result.rows : result.rows.filter(row => row.status === filter);
  return <>
    <div className="workspace-controls"><span>NASA PSI / FLEX</span>
      <select aria-label="Comparison fields" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All {result.rows.length} fields</option>
        {states.map(state => <option key={state.id} value={state.id}>{state.label} fields</option>)}
      </select>
    </div>
    <div className="comparison-grid">
      <section className="card matrix" aria-labelledby="recorded-heading">
        <h2 id="recorded-heading"><Icon name="chevron" /> Recorded evidence</h2>
        <div className="table-scroll" role="region" aria-label="Recorded evidence table" tabIndex={0}>
          <table className={result.runIds.length === 3 ? "three-runs" : undefined}>
            <thead><tr><th scope="col">Recorded field</th>{result.runIds.map((id, index) => <th key={id} scope="col">{id}<small>{index === 0 ? "Baseline" : "Comparison"}</small></th>)}</tr></thead>
            <tbody>{rows.map(row => {
              const units = new Set(row.cells.flatMap(({ field }) => field?.unit ? [field.unit] : []));
              const sharedUnit = row.status !== "incompatible" && units.size === 1 ? [...units][0] : undefined;
              return <tr key={row.key}>
                <th scope="row">{fieldLabel(row.key, row.label)}{sharedUnit && <small>{sharedUnit}</small>}{row.status === "incompatible" && <small>Incompatible</small>}</th>
                {row.cells.map(({ runId, field }) => <td key={runId}>
                  <FieldValue field={field?.value == null ? field
                    : { ...field, value: formatEvidenceValue(field.value, { original: field.original }) }} showUnit={!sharedUnit} />
                  {field && <Citation runId={runId} field={field} inspect={inspect} />}
                </td>)}
              </tr>;
            })}</tbody>
          </table>
        </div>
        {!rows.length && <p className="empty">No fields have this status.</p>}
        <div className="card-foot">Exact equality in shared units · Rule {result.comparisonRuleVersion}</div>
      </section>
      <div className="comparison-cards">
        <BurnTime row={result.rows.find(row => row.key === "burn_time")} />
        <ComparisonSummary rows={result.rows} inspect={inspect} />
      </div>
    </div>
    <p className="scientific-limit">Matching recorded values cannot establish scientific equivalence. Unrecorded conditions may affect outcomes.</p>
  </>;
}
