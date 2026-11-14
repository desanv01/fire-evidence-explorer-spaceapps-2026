import type { EvidenceSource, RunField } from "../../lib/evidence";
import type { DatasetProvenance } from "../../lib/evidence-export";
import { formatEvidenceValue } from "../../lib/evidence-format";
import { FieldValue, Icon, coordinates, fieldLabel } from "./elements";

export type SourceResult = {
  runId: string;
  field: RunField;
  source: EvidenceSource;
  datasetVersion: string;
  provenance?: DatasetProvenance;
};

export function SourceInspector({ result, error, close }: { result?: SourceResult; error: string; close: () => void }) {
  const coordinate = result && coordinates(result.field.locator);
  const field = result?.field;
  const displayField = field?.value == null ? field
    : { ...field, value: formatEvidenceValue(field.value, { original: field.original }) };
  return <div className="evidence-detail" aria-labelledby="source-title">
    <header className="evidence-heading"><h2 id="source-title"><Icon name="file" /> Source evidence</h2><button className="button" type="button" onClick={close}>Close</button></header>
    {error ? <p role="alert" className="notice">{error}</p> : !result ? <p className="muted" role="status">Loading source evidence…</p> : <>
      <p className="source-id">{result.runId} · {fieldLabel(result.field.key, result.field.label)}</p>
      <div className="source-value"><FieldValue field={displayField} showUnit /></div>
      <div className="source-sheet">
        <div className="sheet-file"><span>FLEX experimental table</span><small>CSV</small></div>
        {coordinate && <><div className="sheet-row"><span>1</span><span>{coordinate.header}</span></div><div className="sheet-row"><span>{coordinate.row}</span><strong>{result.field.original ?? "Unknown"}</strong></div></>}
        <p className="sheet-location">{coordinate ? `CSV row ${coordinate.row} · column ${coordinate.column}` : result.field.locator}</p>
      </div>
      <dl>
        {coordinate && <><dt>File</dt><dd>{coordinate.file}</dd></>}
        <dt>Source version</dt><dd>{result.source.version}</dd>
        {coordinate && <><dt>Test record</dt><dd>{coordinate.test}</dd></>}
        <dt>Corpus</dt><dd>{result.datasetVersion}</dd>
        <dt>License</dt><dd>{result.source.license}</dd>
      </dl>
      <p className="source-note">Formatted excerpt of the original recorded cell.</p>
      {result.field.key === "extinction_diameter" && <p className="source-note">NASA reports that some diameters were estimated. The CSV does not identify individual estimates.</p>}
      {result.field.key === "burning_rate" && <p className="source-note">Table IX reports burning rate in mm²/s. The original CSV header above preserves the source wording.</p>}
      <a className="source-link" href={result.source.url} target="_blank" rel="noreferrer">Open original NASA PSI record <Icon name="link" /></a>
    </>}
  </div>;
}

