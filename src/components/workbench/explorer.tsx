import type { Run, RunSearchRequest } from "../../lib/evidence";
import type { rankEvidence } from "../../lib/evidence-client";
import { Citation, FieldValue, Icon, type InspectSource } from "./elements";

type Props = {
  runs: Run[];
  total: number | undefined;
  selected: string[];
  search: RunSearchRequest;
  busy: boolean;
  error: string;
  onSearch: (search: RunSearchRequest) => void;
  onSelect: (runId: string) => void;
  onCompare: () => void;
  onRun: (runId: string) => void;
  inspect: InspectSource;
  rankingReference: string;
  ranking?: Awaited<ReturnType<typeof rankEvidence>>;
  rankError: string;
  references: string[];
  onRank: (id: string) => void;
};

const pressurePattern = /(?:(?:\+|-)?[0-9]+(?:[.][0-9]+)?(?:[eE](?:\+|-)?[0-9]+)?|unknown)/;

export function Explorer({ runs, total, selected, search, busy, error, onSearch, onSelect, onCompare, onRun, inspect, rankingReference, ranking: result, rankError, references, onRank }: Props) {
  const filters = search.filters ?? [];
  const fuelIndex = filters.findIndex(({ key, value }) => key === "fuel" && (value === "Methanol" || value === "Heptane"));
  const pressureIndex = filters.findIndex(({ key, value }) => key === "pressure" && (typeof value === "number" || value === null));
  const fuel = filters[fuelIndex]?.value ?? "";
  const pressure = filters[pressureIndex]?.value;
  const extraFilters = filters.map((filter, index) => ({ filter, index }))
    .filter(({ index }) => index !== fuelIndex && index !== pressureIndex);
  const reference = references.includes(rankingReference) ? rankingReference : "";
  const ranking = reference && result?.referenceRunId === reference && !busy && !error
    && result.search?.query === search.query && result.search?.investigation === search.investigation
    && JSON.stringify(result.search?.filters ?? []) === JSON.stringify(filters)
    ? result : undefined;
  const candidateById = new Map(ranking?.candidates.map(candidate => [candidate.runId, candidate]));
  const runsById = new Map(runs.map(run => [run.id, run]));
  const visible = busy || error ? [] : ranking ? ranking.candidates.flatMap(({ runId }) => runsById.get(runId) ?? []) : runs;
  const referenceOnly = ranking?.candidates.length === 0 && runs.length === 1 && runs[0].id === ranking.referenceRunId;

  function toggleRun(id: string) {
    if (id === reference && selected.includes(id)) onRank("");
    onSelect(id);
  }

  return <section className="card explorer-card" aria-label="Reviewed runs">
    <form className="filters" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const query = String(form.get("query") ?? "").trim();
      const submittedFuel = String(form.get("fuel") ?? "");
      const submittedPressure = String(form.get("pressure") ?? "");
      const pressureValue = submittedPressure === "unknown" ? null : Number(submittedPressure);
      if (pressureValue !== null && !Number.isFinite(pressureValue)) {
        const input = event.currentTarget.elements.namedItem("pressure");
        if (input instanceof HTMLInputElement) {
          input.setCustomValidity("Enter a finite pressure in mmHg.");
          input.reportValidity();
        }
        return;
      }
      const nextFuel = submittedFuel ? { key: "fuel", value: submittedFuel } : undefined;
      const nextPressure = submittedPressure ? { key: "pressure", value: pressureValue } : undefined;
      const nextFilters = filters.flatMap((filter, index) => {
        const next = index === fuelIndex ? nextFuel : index === pressureIndex ? nextPressure : filter;
        return next ? [next] : [];
      });
      if (fuelIndex === -1 && nextFuel) nextFilters.push(nextFuel);
      if (pressureIndex === -1 && nextPressure) nextFilters.push(nextPressure);
      onSearch({ ...(query && { query }), investigation: search.investigation ?? "FLEX", ...(nextFilters.length > 0 && { filters: nextFilters }) });
    }} key={JSON.stringify(search)}>
      <label className="search-field"><Icon name="search" /><input name="query" aria-label="Search reviewed runs" placeholder="Search reviewed runs…" defaultValue={search.query ?? ""} /></label>
      <select name="fuel" aria-label="Fuel" defaultValue={String(fuel)}>
        <option value="">All fuels</option><option>Methanol</option><option>Heptane</option>
      </select>
      <input className="pressure-filter" name="pressure" aria-label="Pressure in mmHg or unknown" inputMode="text" pattern={pressurePattern.source} placeholder="Pressure (mmHg)" defaultValue={pressure === null ? "unknown" : pressure ?? ""} onChange={event => event.currentTarget.setCustomValidity("")} />
      <button className="button" type="submit" disabled={busy}>Search</button>
    </form>
    {extraFilters.map(({ filter, index }) => <button type="button" className="pill active-filter" key={index}
      aria-label={`Remove filter ${filter.key}: ${filter.value ?? "Unknown"}`}
      onClick={() => onSearch({ ...search, filters: filters.filter((_, position) => position !== index) })}>
      {filter.key}: {filter.value ?? "Unknown"} <span aria-hidden="true">×</span>
    </button>)}
    <div className="ranking-controls">
      <label>Rank against <select value={reference} onChange={event => onRank(event.target.value)}>
        <option value="">Choose a selected run</option>
        {references.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <button className="button" type="button" disabled={!filters.length} onClick={() => onSearch({ ...search, filters: undefined })}>Clear filters</button>
      {reference && <small className="muted">Ranked by the share of comparable conditions that match exactly{ranking && ` · Rule ${ranking.rankingRuleVersion}`}</small>}
    </div>
    {reference && !busy && !ranking && !rankError && !error && <p role="status" className="muted">Ranking matching runs…</p>}
    {reference && !busy && !error && rankError && <p role="alert" className="notice">{rankError}</p>}
    <div className="selection-strip" aria-label="Selected comparison set">
      <div>{selected.length ? selected.map(id => <button key={id} className="selection-chip" type="button" aria-label={`Remove ${id}`} onClick={() => toggleRun(id)}>{id} <span aria-hidden="true">×</span></button>) : <span className="muted">Choose 2–3 runs</span>}</div>
      <button className="button" type="button" aria-label="Compare selected runs" disabled={selected.length < 2} onClick={onCompare}>Compare</button>
    </div>
    <p className="result-count" role="status">{busy ? "Searching reviewed runs…" : error ? "Search unavailable" : referenceOnly ? "No other matching candidates" : `${visible.length}${total !== undefined && total !== visible.length ? ` of ${total}` : ""} reviewed runs · choose 2–3 to compare`}</p>
    {error && <p className="notice" role="alert">{error} <button type="button" className="button" onClick={() => onSearch({ ...search })}>Retry search</button></p>}
    {!busy && !error && !visible.length && <div className="empty"><p>{referenceOnly
      ? `${ranking.referenceRunId} is the only reviewed run that matches this search. Change the search or filters to find other candidates.`
      : search.query ? `No reviewed runs match “${search.query}”.` : "No reviewed runs match these filters."}</p>
      <button className="button" type="button" onClick={() => onSearch({ investigation: "FLEX" })}>Clear search</button></div>}
    {visible.length > 0 && <div className="table-scroll" role="region" aria-label="Reviewed runs table" tabIndex={0}>
      <table className="run-table">
        <thead><tr><th scope="col" className="check-col"><span className="sr-only">Select</span></th><th scope="col">Run</th>{ranking && <th scope="col">Condition agreement</th>}<th scope="col" className="wide-cell">Pressure</th><th scope="col">Burn time</th><th scope="col">Test end</th><th scope="col" className="wide-cell">Evidence</th></tr></thead>
        <tbody>{visible.map(run => {
          const fields = new Map(run.fields.map(field => [field.key, field]));
          const pressure = fields.get("pressure");
          const checked = selected.includes(run.id);
          const candidate = candidateById.get(run.id);
          return <tr key={run.id}>
            <td className="check-col"><input type="checkbox" aria-label={`Select ${run.id}`} checked={checked} disabled={!checked && selected.length >= 3} onChange={() => toggleRun(run.id)} /></td>
            <th scope="row"><button className="text-button" type="button" onClick={() => onRun(run.id)}>{run.id}</button><small>{fields.get("fuel")?.value ?? "Unknown fuel"}</small></th>
            {candidate && <td><strong>{candidate.score === null ? "No comparable conditions" : `${candidate.sameCount} of ${candidate.comparableCount} match`}</strong>
              <details className="rank-details"><summary>{candidate.unknownCount} unknown · {candidate.incompatibleCount} incompatible</summary>
                <ul>{candidate.conditions.map(condition => <li key={condition.key}>{condition.label}: {condition.status}. {condition.reason}</li>)}</ul>
              </details></td>}
            <td className="wide-cell"><FieldValue field={pressure} showUnit /></td>
            <td><FieldValue field={fields.get("burn_time")} showUnit /></td>
            <td><span className="pill"><FieldValue field={fields.get("test_end")} /></span></td>
            <td className="wide-cell">{pressure && <Citation runId={run.id} field={pressure} inspect={inspect} />}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
  </section>;
}
