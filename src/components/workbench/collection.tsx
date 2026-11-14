import type { EvidenceComparison, EvidenceOverview } from "../../lib/evidence-client";
import type { Run } from "../../lib/evidence";
import { Citation, FieldValue, Icon, coordinates, fieldLabel, type InspectSource } from "./elements";

export function Overview({ overview, runs, comparison, error, retry, explore, compare, openRun }: {
  overview?: EvidenceOverview;
  runs: Run[];
  comparison?: EvidenceComparison;
  error: string;
  retry: () => void;
  explore: () => void;
  compare: () => void;
  openRun: (id: string) => void;
}) {
  if (error) return <section className="card status-card"><h2>Collection unavailable</h2><p role="alert">{error}</p><button className="primary" onClick={retry}>Retry collection</button></section>;
  if (!overview) return <p className="empty" role="status">Loading dataset coverage…</p>;
  const { source, selection } = overview.provenance;
  const example = runs.find(run => run.id === "FLEX-004") ?? runs[0];
  return <>
    <div className="overview-stats">
      <div className="card"><strong>{overview.runCount}</strong><span>Reviewed experiments</span></div>
      <div className="card"><strong>{selection.fieldsPerRun}</strong><span>Fields per experiment</span></div>
      <div className="card"><strong>{source.fileVersion}</strong><span>Source table version</span></div>
    </div>
    <div className="comparison-grid">
      <div className="stack">
        <section className="card">
          <h2><Icon name="chevron" /> Collection coverage</h2>
          <div className="card-body">
            <strong>{overview.runCount} of {source.dataRows} source rows reviewed</strong>
            <progress value={overview.runCount} max={source.dataRows} aria-label="Reviewed source rows" />
            <p>This collection covers the reviewed subset of the experimental table.</p>
            <div className="card-actions"><button className="primary" onClick={explore}>Explore {overview.runCount} runs</button><button className="button" onClick={compare}>Open comparison</button></div>
          </div>
        </section>
        {example && <section className="card">
          <h2><Icon name="chevron" /> Start with a run</h2>
          <div className="card-body"><button className="text-button" onClick={() => openRun(example.id)}>View {example.id} →</button>
            {comparison && <p className="muted">{comparison.runIds.join(" and ")} selected for comparison</p>}</div>
        </section>}
      </div>
      <section className="card">
        <h2><Icon name="chevron" /> Source record</h2>
        <div className="card-body">
          <span className="pill">NASA PSI · {source.accession}</span>
          <p className="source-note">Experimental table<br />Investigation {source.investigationVersion} · CSV file {source.fileVersion}</p>
          <dl><dt>Corpus version</dt><dd>{overview.datasetVersion}</dd><dt>Evidence standard</dt><dd>Recorded values, explicit units and source coordinates. Missing cells remain unknown.</dd></dl>
          <div className="card-actions"><a className="source-link" href={source.investigationUrl} target="_blank" rel="noreferrer">Open NASA source <Icon name="link" /></a></div>
        </div>
      </section>
    </div>
  </>;
}

export function RunWorkspace({ id, run, error, selected, select, compare, explore, inspect }: {
  id: string; run?: Run; error: string; selected: string[];
  select: () => void; compare: () => void; explore: () => void; inspect: InspectSource;
}) {
  if (error) return <section className="card status-card"><h2>Run unavailable</h2><p role="alert">{error}</p><button className="primary" onClick={explore}>Browse reviewed runs</button></section>;
  if (!run) return <p className="empty" role="status">Loading run detail…</p>;
  const missing = run.fields.filter(field => field.value === null);
  const selectedRun = selected.includes(id);
  return <>
    <p className="workspace-controls"><span>Reviewed source record · {run.fields.length} fields</span></p>
    <div className="comparison-grid">
      <section className="card matrix">
        <h2><Icon name="chevron" /> Recorded fields</h2>
        <table className="detail-table"><tbody>{run.fields.map(field => <tr key={field.key}>
          <th scope="row">{field.label}{field.unit && <small>{field.unit}</small>}</th>
          <td><FieldValue field={field} /> <Citation runId={run.id} field={field} inspect={inspect} /></td>
        </tr>)}</tbody></table>
      </section>
      <div className="stack">
        <section className="card">
          <h2><Icon name="chevron" /> Comparison set</h2>
          <div className="card-body">
            <p>{selected.length ? selected.join(" · ") : "Choose two or three reviewed runs."}</p>
            <div className="card-actions">
              <button className="button" disabled={!selectedRun && selected.length >= 3} onClick={select}>{selectedRun ? "Remove this run" : "Add this run"}</button>
              <button className="primary" disabled={!selectedRun || selected.length < 2} onClick={compare}>Compare {selected.length} runs</button>
            </div>
            {!selectedRun && selected.length >= 3 && <button className="text-button" onClick={explore}>Edit selection in Runs</button>}
          </div>
        </section>
        {missing.length > 0 && <section className="card">
          <h2><Icon name="chevron" /> Missing evidence</h2>
          <div className="card-body">{missing.map(field => <p key={field.key}>{fieldLabel(field.key, field.label)} is unknown. <Citation runId={id} field={field} inspect={inspect} /></p>)}</div>
        </section>}
      </div>
    </div>
  </>;
}

export function BriefPreview({ result, overview, inspect }: {
  result: EvidenceComparison; overview?: EvidenceOverview; inspect: InspectSource;
}) {
  const focus = ["burn_time", "diameter", "test_end"];
  const highlights = focus.flatMap(key => result.rows.find(row => row.key === key) ?? []);
  const missing = result.rows.flatMap(row => row.cells.flatMap(({ runId, field }) => field?.value === null ? [{ runId, field }] : []));
  const burnTime = highlights.find(row => row.key === "burn_time");
  return <section className="card brief-preview">
    <header><p className="muted">FLEX / EVIDENCE BRIEF</p><h2>{result.runIds.join(" versus ")}</h2><p className="muted">NASA Physical Sciences Informatics · Reviewed collection</p></header>
    <div className="card-body">
      <h3>Recorded evidence</h3>
      <p>{result.rows.length} fields compared · {result.rows.filter(row => row.status === "same").length} same · {result.rows.filter(row => row.status === "different").length} different</p>
      <dl className="brief-measurements">{highlights.flatMap(row => row.cells.map(({ runId, field }) => <div key={`${row.key}-${runId}`}>
        <dt>{runId} · {fieldLabel(row.key, row.label)}</dt><dd><FieldValue field={field} showUnit /> {field && <Citation runId={runId} field={field} inspect={inspect} />}</dd>
      </div>))}</dl>
      {burnTime && burnTime.differences.length > 0 && <>
        <h3>Calculated burn-time differences</h3>
        <ul>{burnTime.differences.map(({ fromRunId, toRunId, delta }) => <li key={`${fromRunId}-${toRunId}`}>{toRunId} minus {fromRunId}: {new Intl.NumberFormat("en", { signDisplay: "always", maximumFractionDigits: 10 }).format(delta)} s</li>)}</ul>
      </>}
      <h3>Unknowns and interpretation limits</h3>
      {missing.map(({ runId, field }) => <p key={`${runId}-${field.key}`}>{runId} · {fieldLabel(field.key, field.label)}: Unknown. <Citation runId={runId} field={field} inspect={inspect} /></p>)}
      <p>Matching recorded values cannot establish scientific equivalence. Unrecorded conditions may affect outcomes.</p>
      <h3>Source references</h3>
      <p>Corpus: {result.datasetVersion} · Rule {result.comparisonRuleVersion}</p>
      {overview && <a className="source-link" href={overview.provenance.source.investigationUrl} target="_blank" rel="noreferrer">Original NASA PSI record <Icon name="link" /></a>}
    </div>
  </section>;
}
