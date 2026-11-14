"use client";

/**
 * U07 notebook controller. Owns the local draft, explicit save/load, import,
 * JSON export, printable report and explicit re-run, using the accepted
 * notebook engine and presentation helpers. It never writes storage except
 * through `saveNotebookToStorage`, and it never persists notes or questions in
 * public URL state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../../lib/evidence";
import {
  addNotebookNote, editNotebookNote, removeNotebookNote,
} from "../../lib/upgrades/notebook-presentation.ts";
import {
  appendNotebookStep, appendRerunStep, createBrowserNotebookStorage, createComparisonNotebookStep,
  createNotebook, createPlotNotebookStep, importNotebookFromBytes, loadNotebookFromStorage, notebookStorageKeyPrefix,
  reportNotebookVersionMismatch, saveNotebookToStorage, type NotebookStorage,
} from "../../lib/upgrades/notebook-engine.ts";
import {
  exportNotebookJson, notebookJsonFilename, renderPrintableNotebookHtml,
} from "../../lib/upgrades/notebook-presentation.ts";
import { notebookSchema, type Notebook, type NotebookStep, type NotebookVersionReportEntry } from "../../lib/upgrades/notebook.ts";
import { buildPlotResult } from "../../lib/upgrades/plot-engine.ts";
import { buildSelectedRunsContext } from "../../lib/upgrades/comparison-engine.ts";
import { createNotebookNote } from "../../lib/upgrades/notebook-presentation.ts";
import { openGuidedInvestigation } from "../../lib/upgrades/guided-investigations.ts";
import { downloadText, errorMessage, openPrintableReport } from "./files.ts";

type SavedEntry = { notebook: Notebook; byteLength: number };

type PreparedNotebookImport = {
  notebook: Notebook;
  filename: string;
  byteLength: number;
  versionReport: NotebookVersionReportEntry[] | null;
  verification: "not-verified";
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `nb-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The draft signature used for unsaved-work comparisons. The normalized title
 * and question are the values the save path materializes; `updatedAt` is
 * excluded so a save/load timestamp alone never makes a draft dirty.
 */
function signatureOf(notebook: Notebook, title: string, question: string): string {
  return JSON.stringify({
    ...notebook,
    title: title.trim() || notebook.title,
    question: question.trim(),
    updatedAt: undefined,
  });
}

/** Exported for the focused regression test; the controller uses the same value. */
export function notebookDraftSignature(notebook: Notebook, title: string, question: string): string {
  return signatureOf(notebook, title, question);
}

/**
 * A draft is dirty when it has no clean baseline (a guide or import that has
 * never been saved) or when its normalized content differs from that baseline.
 */
export function notebookDraftIsDirty(signature: string, cleanSignature: string | null): boolean {
  return cleanSignature === null || signature !== cleanSignature;
}

/**
 * Save-card status text. It deliberately depends only on the outcome of an
 * actual Save attempt and on persistence state, never on the shared operation
 * error used by import, notes, export or print.
 */
export function notebookSaveStatusText(input: {
  saveFailed: boolean;
  savedAtLabel: string;
  dirty: boolean;
}): string {
  if (input.saveFailed) return "Save did not complete; the draft remains open.";
  if (input.savedAtLabel) return `Last saved ${input.savedAtLabel}`;
  if (input.dirty) return "Unsaved changes; nothing has been written.";
  return "Nothing has been written yet.";
}

function versionStatusLabel(status: NotebookVersionReportEntry["status"]): string {
  if (status === "same-version") return "current corpus";
  if (status === "historical-version") return "historical version · available";
  return "unavailable version · snapshot only";
}

export function useNotebookController(dataset: Dataset, datasetSha256: string) {
  const [notebook, setNotebook] = useState<Notebook>(() => createNotebook({
    id: newId(),
    title: "Untitled investigation",
    datasetVersions: [dataset.version],
  }));
  const [title, setTitle] = useState(notebook.title);
  const [question, setQuestion] = useState(notebook.question);
  /**
   * Signature of the last clean draft. `null` means the current content was
   * loaded from a guide or import and has never been saved, so it always needs
   * replacement protection. `savedAt` remains the separate persistence status.
   */
  const [cleanSignature, setCleanSignature] = useState<string | null>(
    () => notebookDraftSignature(notebook, notebook.title, notebook.question),
  );
  const [savedAt, setSavedAt] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [savedList, setSavedList] = useState<SavedEntry[]>([]);
  const [importedReport, setImportedReport] = useState<NotebookVersionReportEntry[] | null>(null);
  const [importedVerification, setImportedVerification] = useState<"not-verified" | null>(null);
  const storageRef = useRef<NotebookStorage | null | undefined>(undefined);

  const versionContext = useMemo(() => ({
    activeDatasetVersion: dataset.version,
    availableDatasetVersions: [dataset.version],
  }), [dataset.version]);

  const versionReport = useMemo(() => reportNotebookVersionMismatch(notebook, versionContext), [notebook, versionContext]);
  const effectiveTitle = title.trim() || notebook.title;
  const effectiveQuestion = question.trim();
  const signature = notebookDraftSignature(notebook, title, question);
  const dirty = notebookDraftIsDirty(signature, cleanSignature);

  function getStorage(): NotebookStorage | null {
    if (storageRef.current === undefined) storageRef.current = createBrowserNotebookStorage();
    return storageRef.current;
  }

  const refreshSaved = useCallback(() => {
    const storage = getStorage();
    if (!storage) {
      setSavedList([]);
      return;
    }
    const entries: SavedEntry[] = [];
    try {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(notebookStorageKeyPrefix)) keys.push(key);
      }
      for (const key of keys) {
        const id = key.slice(notebookStorageKeyPrefix.length);
        const loaded = loadNotebookFromStorage(storage, id);
        if (loaded.ok) entries.push({ notebook: loaded.notebook, byteLength: loaded.serializedBytes });
      }
    } catch {
      setSavedList([]);
      return;
    }
    entries.sort((left, right) => Date.parse(right.notebook.updatedAt) - Date.parse(left.notebook.updatedAt));
    setSavedList(entries);
  }, []);

  useEffect(() => {
    refreshSaved();
  }, [refreshSaved]);

  function materialize(): Notebook | null {
    const parsed = notebookSchema.safeParse({
      ...notebook,
      title: effectiveTitle,
      question: effectiveQuestion,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(notebook.updatedAt))).toISOString(),
    });
    if (!parsed.success) {
      setError("The notebook draft is not valid. Keep a title and check the question length before continuing.");
      return null;
    }
    return parsed.data;
  }

  function clearMessages() {
    setError("");
    setNotice("");
    setSaveFailed(false);
  }

  /** Surface a non-notebook failure (for example a failed plot step snapshot). */
  function reportError(message: string) {
    setNotice("");
    setError(message);
    setSaveFailed(false);
  }

  function reportNotice(message: string) {
    setError("");
    setNotice(message);
    setSaveFailed(false);
  }

  function save(): boolean {
    clearMessages();
    const current = materialize();
    if (!current) {
      setSaveFailed(true);
      return false;
    }
    const saved = saveNotebookToStorage(getStorage(), current);
    if (!saved.ok) {
      setError(saved.message);
      setSaveFailed(true);
      return false;
    }
    setSaveFailed(false);
    setNotebook(saved.notebook);
    setCleanSignature(notebookDraftSignature(saved.notebook, saved.notebook.title, saved.notebook.question));
    setSavedAt(saved.notebook.updatedAt);
    setNotice(`Notebook saved on this device · ${saved.serializedBytes} bytes.`);
    refreshSaved();
    return true;
  }

  function append(step: NotebookStep): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    const appended = appendNotebookStep(current, step);
    if (!appended.ok) {
      setError(appended.message);
      return false;
    }
    setNotebook(appended.notebook);
    setNotice(`Step ${appended.notebook.steps.length} added to the notebook draft. Saving stays explicit.`);
    return true;
  }

  function appendAnswer(step: NotebookStep): boolean {
    return append(step);
  }

  function appendRerun(step: NotebookStep): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    try {
      let nextStep: NotebookStep;
      if (step.stepType === "plot") {
        const plotResult = buildPlotResult(dataset, step.plotSpec);
        nextStep = createPlotNotebookStep({
          stepId: newId(),
          title: `${step.title} (re-run)`.slice(0, 160),
          plotSpec: step.plotSpec,
          plotResult,
        });
      } else if (step.stepType === "comparison") {
        const context = buildSelectedRunsContext(dataset, step.request);
        nextStep = createComparisonNotebookStep({
          stepId: newId(),
          title: `${step.title} (re-run)`.slice(0, 160),
          context,
        });
      } else {
        setError("A stored evidence answer cannot be deterministically re-run. Ask the assistant for a current trusted answer; the original snapshot is kept.");
        return false;
      }
      const appended = appendRerunStep(current, nextStep, { activeDatasetVersion: dataset.version });
      if (!appended.ok) {
        setError(appended.message);
        return false;
      }
      setNotebook(appended.notebook);
      setNotice(`Re-run appended as step ${appended.notebook.steps.length} using the current corpus. The original snapshot is unchanged.`);
      return true;
    } catch (caught) {
      setError(errorMessage(caught, "This snapshot cannot be re-run against the current corpus."));
      return false;
    }
  }

  function addNote(text: string): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    const result = addNotebookNote(current, createNotebookNote({ noteId: newId(), text }));
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setNotebook(result.notebook);
    setNotice("Personal note added to the draft. It is not verified evidence and is saved only when you choose Save.");
    return true;
  }

  function editNote(noteId: string, text: string): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    const result = editNotebookNote(current, noteId, text);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setNotebook(result.notebook);
    setNotice("Personal note updated. Pinned snapshots are unchanged; saving stays explicit.");
    return true;
  }

  function removeNote(noteId: string): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    const result = removeNotebookNote(current, noteId);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setNotebook(result.notebook);
    setNotice("Personal note removed from the draft. Saving stays explicit.");
    return true;
  }

  function reopenSaved(id: string): boolean {
    clearMessages();
    const loaded = loadNotebookFromStorage(getStorage(), id, { versionContext });
    if (!loaded.ok) {
      setError(loaded.message);
      return false;
    }
    setNotebook(loaded.notebook);
    setTitle(loaded.notebook.title);
    setQuestion(loaded.notebook.question);
    setCleanSignature(notebookDraftSignature(loaded.notebook, loaded.notebook.title, loaded.notebook.question));
    setSavedAt(loaded.notebook.updatedAt);
    setImportedReport(null);
    setImportedVerification(null);
    setNotice(`Reopened saved notebook · ${loaded.notebook.steps.length} step${loaded.notebook.steps.length === 1 ? "" : "s"} · original corpus ${loaded.notebook.datasetVersions.join(", ")}.`);
    return true;
  }

  function startNew(): void {
    clearMessages();
    const created = createNotebook({ id: newId(), title: "Untitled investigation", datasetVersions: [dataset.version] });
    setNotebook(created);
    setTitle(created.title);
    setQuestion("");
    setCleanSignature(notebookDraftSignature(created, created.title, created.question));
    setSavedAt("");
    setImportedReport(null);
    setImportedVerification(null);
    setNotice("New local notebook draft. Nothing is written until you choose Save.");
  }

  /**
   * U09.1 — open one prepared investigation as a new unsaved draft.
   *
   * `openGuidedInvestigation` rebuilds every step from the supplied parsed
   * public corpus. This controller change only installs the returned immutable
   * notebook as browser state: it performs no storage write, no save, no URL
   * write, no download/print and no provider call. The normal Save/Reopen/
   * Import/Export/Print controls remain the only persistence actions.
   */
  function openGuide(guideId: string): boolean {
    clearMessages();
    const opened = openGuidedInvestigation(dataset, guideId);
    if (!opened.ok) {
      setError(opened.message);
      return false;
    }
    setNotebook(opened.notebook);
    setTitle(opened.notebook.title);
    setQuestion(opened.notebook.question);
    // The guide content has no persisted clean baseline until an explicit save.
    setCleanSignature(null);
    setSavedAt("");
    setImportedReport(null);
    setImportedVerification(null);
    setNotice(`Opened “${opened.guide.title}” as an unsaved draft · ${opened.guide.steps.length} steps · corpus ${opened.corpus.datasetVersion}. Nothing was written to storage or sent to a provider.`);
    return true;
  }

  /**
   * Validate a selected file without touching the current draft. The workspace
   * can ask for replacement confirmation only after this succeeds, so an
   * invalid file leaves the draft intact and still reports its validation error.
   */
  function prepareImport(bytes: Uint8Array, filename: string): PreparedNotebookImport | null {
    clearMessages();
    const imported = importNotebookFromBytes(bytes, { versionContext, datasets: [dataset] });
    if (!imported.ok) {
      const details = imported.issues?.slice(0, 3).join(" · ") ?? "";
      setError(`${imported.message}${details ? ` ${details}` : ""} The existing notebook and stored data are unchanged.`);
      return null;
    }
    return {
      notebook: imported.notebook,
      filename,
      byteLength: imported.byteLength,
      versionReport: imported.versionReport,
      verification: imported.verification,
    };
  }

  /** Commit one already-validated import. Performs no storage write. */
  function applyImport(prepared: PreparedNotebookImport): boolean {
    clearMessages();
    setNotebook(prepared.notebook);
    setTitle(prepared.notebook.title);
    setQuestion(prepared.notebook.question);
    // Imported content is an unsaved draft until an explicit save.
    setCleanSignature(null);
    setSavedAt("");
    setImportedReport(prepared.versionReport);
    setImportedVerification(prepared.verification);
    setNotice(`Imported ${prepared.filename} · ${prepared.byteLength} bytes · verification: not-verified. Nothing was written to storage.`);
    return true;
  }

  function exportJson(): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    const exported = exportNotebookJson(current);
    if (!exported.ok) {
      setError(exported.message);
      return false;
    }
    downloadText(exported.filename || notebookJsonFilename(current), exported.text);
    setNotice(`Portable notebook JSON prepared · ${exported.byteLength} bytes. Notes and conversation text stay out of public URLs.`);
    return true;
  }

  function printReport(): boolean {
    clearMessages();
    const current = materialize();
    if (!current) return false;
    try {
      const html = renderPrintableNotebookHtml(current, {
        datasets: [dataset],
        versionContext,
        generatedAt: new Date().toISOString(),
      });
      const outcome = openPrintableReport(html, `fire-evidence-notebook-${current.id}.html`);
      setNotice(outcome === "opened"
        ? "Printable report opened in a new tab. User text is escaped and no script or remote asset is emitted."
        : "The print tab was blocked, so the escaped printable report was downloaded instead.");
      return true;
    } catch (caught) {
      setError(errorMessage(caught, "The printable report could not be prepared."));
      return false;
    }
  }

  return {
    notebook,
    title,
    question,
    setTitle,
    setQuestion,
    dirty,
    savedAt,
    saveFailed,
    notice,
    error,
    savedList,
    importedReport,
    importedVerification,
    versionReport,
    versionStatusLabel,
    datasetSha256,
    clearMessages,
    reportError,
    reportNotice,
    refreshSaved,
    save,
    append,
    appendAnswer,
    appendRerun,
    addNote,
    editNote,
    removeNote,
    reopenSaved,
    startNew,
    openGuide,
    prepareImport,
    applyImport,
    exportJson,
    printReport,
    materialize,
  };
}

export type NotebookController = ReturnType<typeof useNotebookController>;
