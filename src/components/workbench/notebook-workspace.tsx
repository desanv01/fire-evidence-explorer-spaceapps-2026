"use client";

import { useRef, useState } from "react";
import type { Dataset } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import { fieldDefinitionByKey } from "../../lib/upgrades/field-catalog";
import {
  guidedInvestigationDatasetReport,
  listGuidedInvestigations,
  type GuidedInvestigation,
} from "../../lib/upgrades/guided-investigations";
import type {
  ComparisonNotebookStep, EvidenceAnswerNotebookStep, NotebookStep, PlotNotebookStep,
} from "../../lib/upgrades/notebook";
import { Icon, Citation, type InspectSource } from "./elements";
import { focusElement } from "./files";
import { notebookSaveStatusText, type NotebookController } from "./notebook-store";

type Props = {
  controller: NotebookController;
  dataset: Dataset;
  runCount: number | undefined;
  onOpenRuns: () => void;
  onOpenCompare: () => void;
  onReopenPlot: (step: PlotNotebookStep) => void;
  onOpenComparison: (runIds: string[]) => void;
  onOpenAssistant: () => void;
  inspect: InspectSource;
  aiEnabled: boolean;
};

function fieldLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(fieldDefinitionByKey, key)
    ? fieldDefinitionByKey[key as keyof typeof fieldDefinitionByKey].label
    : key;
}

function stepTypeLabel(step: NotebookStep): string {
  if (step.stepType === "plot") return "Plot snapshot";
  if (step.stepType === "comparison") return "Comparison snapshot";
  return "Trusted answer snapshot";
}

function plotStepSummary(step: PlotNotebookStep): string {
  const axes = step.plotSpec.kind === "scatter"
    ? `${fieldLabel(step.plotSpec.axes.x.field)} × ${fieldLabel(step.plotSpec.axes.y.field)}`
    : `${fieldLabel(step.plotSpec.axes.y.field)} by run`;
  return `${axes} · ${step.plotResult.includedCount} included / ${step.plotResult.omittedCount} omitted`;
}

function comparisonStepSummary(step: ComparisonNotebookStep): string {
  const outcome = step.context.outcomes.find(field => field.key === "burn_time")
    ?? step.context.outcomes.find(field => field.status === "different")
    ?? step.context.outcomes[0];
  if (!outcome) return step.context.runIds.join(" vs ");
  const values = outcome.cells.map(cell => `${cell.runId} ${cell.value === null ? "unknown" : `${formatEvidenceValue(cell.value, { original: cell.original })}${outcome.unit ? ` ${outcome.unit}` : ""}`}`).join(" → ");
  return values;
}

function answerStepSummary(step: EvidenceAnswerNotebookStep): string {
  const claims = step.answer.explanation.claims.length;
  return `${step.answer.runIds.join(" · ")} · ${claims} recorded claim${claims === 1 ? "" : "s"} · receipt not-verified`;
}

function guidedRunIds(guide: GuidedInvestigation): string[] {
  const runIds: string[] = [];
  for (const step of guide.steps) {
    const stepRunIds = step.kind === "plot"
      ? (step.plotSpec.scope.kind === "explicit-runs" ? step.plotSpec.scope.runIds : [])
      : step.request.runIds;
    for (const runId of stepRunIds) {
      if (!runIds.includes(runId)) runIds.push(runId);
    }
  }
  return runIds;
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : value;
}

export function NotebookWorkspace(props: Props) {
  const { controller, dataset } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNote, setEditingNote] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const versionReport = controller.versionReport;
  const oldSteps = controller.notebook.steps.filter(step => step.datasetVersion !== dataset.version);
  const guides = listGuidedInvestigations();
  const guideReport = guidedInvestigationDatasetReport(dataset);

  function confirmDiscard(action: () => void) {
    if (controller.dirty && !window.confirm("The current notebook draft has unsaved changes. Continue and discard them?")) return;
    action();
  }

  function openGuide(guide: GuidedInvestigation) {
    if (!guideReport.compatible) return;
    confirmDiscard(() => { controller.openGuide(guide.guideId); });
  }

  async function onImport(file: File | undefined) {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Validate first so an invalid file reports its error without prompting to
      // replace, then reuse the existing discard seam only for a valid import.
      const prepared = controller.prepareImport(bytes, file.name);
      if (!prepared) return;
      confirmDiscard(() => { controller.applyImport(prepared); });
    } catch {
      controller.clearMessages();
      controller.reportError("The selected file could not be read. The existing notebook and stored data are unchanged.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return <>
    <div className="workspace-controls mode-controls">
      <span className="mode-source">NASA PSI / FLEX · {dataset.version}</span>
      <div className="notebook-head-actions">
        <button className="button" type="button" onClick={() => confirmDiscard(controller.startNew)}>New notebook</button>
        <button className="button notebook-action" type="button" aria-pressed> <Icon name="file" /> Notebook</button>
      </div>
    </div>

    {versionReport.hasMismatch && <section className="card version-card" role="status" aria-labelledby="version-heading">
      <h2 id="version-heading"><Icon name="chevron" /> Corpus version differs</h2>
      <div className="card-body">
        <p>{versionReport.message}</p>
        <p className="muted">Original snapshots keep their stored corpus identity. Re-running adds a separate current-version step; it never rewrites history.</p>
        <ul className="version-list">
          {versionReport.mismatchedEntries.map(entry => <li key={entry.datasetVersion}>
            <strong>{entry.datasetVersion}</strong> · {controller.versionStatusLabel(entry.status)} · {entry.stepIds.length} step{entry.stepIds.length === 1 ? "" : "s"}
          </li>)}
        </ul>
        {oldSteps.length > 0 && <div className="version-reruns">
          {oldSteps.map(step => <div className="version-rerun" key={step.stepId}>
            <span>{step.title} · original corpus {step.datasetVersion}</span>
            {step.stepType === "evidence-answer"
              ? <span className="muted">Re-run unavailable for a stored answer; ask the assistant for a current trusted answer.</span>
              : <button className="button" type="button" onClick={() => controller.appendRerun(step)}>Re-run as new step</button>}
          </div>)}
        </div>}
      </div>
    </section>}

    {(controller.error || controller.notice) && <div className="notebook-messages" aria-live="polite">
      {controller.error && <p className="notice" role="alert">{controller.error}</p>}
      {controller.notice && <p className="notice" role="status">{controller.notice}</p>}
    </div>}

    <div className="notebook-grid">
      <div className="notebook-main">
        <section className="card investigation-card" aria-labelledby="investigation-heading">
          <h2 id="investigation-heading"><Icon name="chevron" /> Investigation</h2>
          <div className="card-body">
            <label className="notebook-field">Draft title
              <input value={controller.title} maxLength={160} onChange={event => { controller.clearMessages(); controller.setTitle(event.target.value); }} />
            </label>
            <label className="notebook-field">Question
              <textarea value={controller.question} maxLength={2000} rows={3} placeholder="What are you trying to establish from the recorded evidence?"
                onChange={event => { controller.clearMessages(); controller.setQuestion(event.target.value); }} />
            </label>
            <div className="investigation-status">
              <span className={controller.dirty ? "status-pill unsaved" : "status-pill"}>{controller.dirty ? "Unsaved changes" : controller.savedAt ? "Saved on this device" : "Not saved on this device"}</span>
              <span className="muted">Local notebook · {dataset.version}</span>
            </div>
            {controller.importedVerification && <p className="muted">Imported content · verification: {controller.importedVerification}. Imported snapshots are never presented as verified evidence.</p>}
          </div>
        </section>

        <section className="card steps-card" aria-labelledby="steps-heading">
          <h2 id="steps-heading"><Icon name="chevron" /> Evidence steps</h2>
          <div className="card-body">
            {controller.notebook.steps.length === 0 ? <p className="empty">No evidence steps are stored yet. Pin a plot, comparison or trusted answer to add an ordered immutable snapshot.</p>
              : <ol className="notebook-steps">
                {controller.notebook.steps.map((step, index) => <li className="notebook-step" key={step.stepId}>
                  <span className="step-number" aria-hidden="true">{index + 1}</span>
                  <div className="step-body">
                    <div className="step-head">
                      <strong>{step.title}</strong>
                      <span className="pill">{stepTypeLabel(step)}</span>
                      {step.datasetVersion !== dataset.version && <span className="pill original-version">Original corpus {step.datasetVersion}</span>}
                    </div>
                    <p className="step-summary">{step.stepType === "plot" ? plotStepSummary(step)
                      : step.stepType === "comparison" ? comparisonStepSummary(step)
                        : answerStepSummary(step)}</p>
                    <p className="muted step-meta">{timestamp(step.createdAt)} · {step.resolvedRunIds.length} run{step.resolvedRunIds.length === 1 ? "" : "s"} · corpus {step.datasetVersion} · {step.sourceReferences.length} source reference{step.sourceReferences.length === 1 ? "" : "s"}</p>
                    <div className="step-actions">
                      {step.stepType === "plot" && <button className="button" type="button" onClick={() => props.onReopenPlot(step)}>Reopen view</button>}
                      {step.stepType === "comparison" && <button className="button" type="button" onClick={() => props.onOpenComparison(step.context.runIds)}>Open comparison</button>}
                      {step.stepType === "evidence-answer" && <button className="button" type="button" onClick={props.onOpenAssistant}>Open assistant</button>}
                      <span className="muted">{step.stepType === "plot" ? "Frozen axes, filters and source references" : step.stepType === "comparison" ? "Frozen ordered runs, conditions and outcomes" : "Stored answer snapshot; receipt verification remains not-verified"}</span>
                    </div>
                    {step.sourceReferences.length > 0 && <div className="step-sources" role="group" aria-label={`Sources stored with step ${index + 1}`}>
                      {step.sourceReferences.slice(0, 4).map(reference => {
                        const field = dataset.runs.find(run => run.id === reference.runId)?.fields.find(item => item.key === reference.fieldKey);
                        return field ? <Citation key={`${reference.runId}-${reference.fieldKey}-${reference.sourceId}`}
                          runId={reference.runId} field={field} inspect={props.inspect} /> : null;
                      })}
                    </div>}
                    <details className="step-limits"><summary>Stored limitations</summary>
                      <ul>{step.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
                    </details>
                    <details className="step-limits"><summary>Step identity</summary>
                      <p><code>{step.stepId}</code> · schema {controller.notebook.schemaVersion} · {step.sourceReferences.length} stable reference{step.sourceReferences.length === 1 ? "" : "s"}</p>
                    </details>
                  </div>
                </li>)}
              </ol>}
          </div>
        </section>

        <section className="card note-card" aria-labelledby="note-heading">
          <h2 id="note-heading"><Icon name="chevron" /> Personal note</h2>
          <div className="card-body">
            <label className="notebook-field">Your note
              <textarea value={noteDraft} maxLength={4000} rows={4} placeholder="Record what you want to check next. This text is user content, not evidence."
                onChange={event => setNoteDraft(event.target.value)} />
            </label>
            <div className="note-actions">
              <button className="button" type="button" disabled={!noteDraft.trim()} onClick={() => {
                if (controller.addNote(noteDraft.trim())) setNoteDraft("");
              }}>Add note</button>
              <span className="muted">Notes are kept outside public URLs and are saved only with the notebook.</span>
            </div>
            {controller.notebook.notes.length > 0 && <ul className="note-list">
              {controller.notebook.notes.map(note => <li key={note.noteId}>
                <div className="note-head"><strong>Personal note</strong><span className="muted">{timestamp(note.updatedAt)}</span></div>
                {editingNote === note.noteId
                  ? <>
                    <textarea value={editingText} maxLength={4000} rows={3} aria-label="Edit personal note" onChange={event => setEditingText(event.target.value)} />
                    <div className="note-actions">
                      <button className="button" type="button" onClick={() => {
                        if (controller.editNote(note.noteId, editingText.trim())) { setEditingNote(undefined); setEditingText(""); }
                      }}>Save note</button>
                      <button className="button" type="button" onClick={() => { setEditingNote(undefined); setEditingText(""); }}>Cancel</button>
                    </div>
                  </>
                  : <>
                    <p>{note.text}</p>
                    <div className="note-actions">
                      <button className="button" type="button" onClick={() => { setEditingNote(note.noteId); setEditingText(note.text); }}>Edit note</button>
                      <button className="button" type="button" onClick={() => controller.removeNote(note.noteId)}>Remove note</button>
                    </div>
                  </>}
              </li>)}
            </ul>}
            <p className="plot-note">Illustrative user content · not verified evidence. Editing a note does not change a pinned snapshot.</p>
          </div>
        </section>
      </div>

      <div className="notebook-side">
        <section className="card save-card" aria-labelledby="save-heading">
          <h2 id="save-heading"><Icon name="chevron" /> Save this investigation</h2>
          <div className="card-body">
            <p>Save only when you choose. Browser storage is local to this device and may be cleared.</p>
            <button className="primary" type="button" onClick={() => { if (controller.save()) focusElement("notebook-save-status"); }}>Save notebook on this device</button>
            <p id="notebook-save-status" tabIndex={-1} className="muted" role="status">
              {notebookSaveStatusText({
                saveFailed: controller.saveFailed,
                savedAtLabel: controller.savedAt ? timestamp(controller.savedAt) : "",
                dirty: controller.dirty,
              })}
            </p>
            <div className="save-tools">
              <button className="button" type="button" onClick={controller.exportJson}>Export JSON</button>
              <button className="button" type="button" onClick={() => fileInput.current?.click()}>Import JSON</button>
              <button className="button" type="button" onClick={controller.printReport}>Print report</button>
              <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Import a notebook JSON file"
                onChange={event => void onImport(event.target.files?.[0])} />
            </div>
            <p className="source-note">Exported JSON is the portable copy. Public view links do not include personal notes or conversation text.</p>
            {controller.importedReport && controller.importedReport.length > 0 && <details className="step-limits">
              <summary>Imported corpus versions</summary>
              <ul>{controller.importedReport.map(entry => <li key={entry.datasetVersion}>{entry.datasetVersion} · {controller.versionStatusLabel(entry.status)} · {entry.stepIds.length} step{entry.stepIds.length === 1 ? "" : "s"}</li>)}</ul>
            </details>}
          </div>
        </section>

        <section className="card saved-card" aria-labelledby="saved-heading">
          <h2 id="saved-heading"><Icon name="chevron" /> Your notebooks</h2>
          <div className="card-body">
            <p className="muted">Current draft · {controller.notebook.steps.length} step{controller.notebook.steps.length === 1 ? "" : "s"} · {controller.notebook.notes.length} note{controller.notebook.notes.length === 1 ? "" : "s"}</p>
            {controller.savedList.length === 0 ? <p className="muted">No saved notebooks on this device. Saved notebooks appear here after an explicit save.</p>
              : <ul className="saved-list">{controller.savedList.map((entry, index) => <li key={`${entry.notebook.id}-${index}`}>
                <strong>{entry.notebook.title}</strong>
                <span>{entry.notebook.steps.length} step{entry.notebook.steps.length === 1 ? "" : "s"} · {timestamp(entry.notebook.updatedAt)} · {entry.byteLength} bytes</span>
                <span className="muted">{entry.notebook.datasetVersions.join(", ")}</span>
                <div className="saved-actions">
                  <button className="button" type="button" onClick={() => confirmDiscard(() => controller.reopenSaved(entry.notebook.id))}>Reopen saved notebook</button>
                </div>
              </li>)}</ul>}
            <button className="text-button" type="button" onClick={controller.refreshSaved}>Refresh saved list</button>
          </div>
        </section>

        <section className="card guides-card" aria-labelledby="guides-heading">
          <h2 id="guides-heading"><Icon name="chevron" /> Prepared investigations</h2>
          <div className="card-body">
            {guideReport.compatible
              ? <p className="muted">Pinned corpus {guideReport.expectedDatasetVersion} · source {guideReport.sourceId}. Opening rebuilds every ordered step from this corpus; it does not save the draft.</p>
              : <p id="guide-disabled-reason" className="notice" role="alert">
                {guideReport.message ?? "The active corpus does not match the guides' pinned corpus."} Guide opening is disabled until the active corpus matches; your current draft is unchanged.
              </p>}
            {guides.length ? <ul className="guide-list">
              {guides.map(guide => {
                const runIds = guidedRunIds(guide);
                return <li key={guide.guideId}>
                  <strong>{guide.title}</strong>
                  <p>{guide.summary}</p>
                  <p className="muted">{guide.steps.length} step{guide.steps.length === 1 ? "" : "s"} · {runIds.join(", ")} · corpus {guide.datasetVersion}</p>
                  <button className="button" type="button" disabled={!guideReport.compatible}
                    aria-label={`Open ${guide.title} as an unsaved notebook draft`}
                    aria-describedby={!guideReport.compatible ? "guide-disabled-reason" : undefined}
                    onClick={() => openGuide(guide)}>Open as unsaved draft</button>
                  <span className="muted">Deterministic · zero AI calls · opens without saving</span>
                </li>;
              })}
            </ul>
              : <div className="guide-placeholder">
                <p>No prepared investigations are available in this build.</p>
                <button className="button" type="button" onClick={props.onOpenRuns}>Explore {props.runCount ? `${props.runCount} ` : ""}runs</button>
              </div>}
            <p className="muted">Each guide retains its ordered plot/comparison facts, source references and limitations. Use Save notebook on this device, Reopen saved notebook, Import JSON, Export JSON or Print report above for the normal notebook journey. Opening or exporting a guide consumes zero AI calls.</p>
            <p className="muted">Guides work without AI attempts. {props.aiEnabled ? "AI is available for ordinary conversation and optional read-only action planning, not for guide truth." : "AI is currently unavailable; the manual tools and guides still work."}</p>
          </div>
        </section>
      </div>
    </div>
  </>;
}
