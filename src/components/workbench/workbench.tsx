"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readEvidenceSearch, writeEvidenceSearch, type Dataset, type Run, type RunSearchRequest } from "../../lib/evidence";
import {
  compareEvidence, describeProposedFilter, downloadEvidence, getEvidenceOverview, getEvidenceRun, getEvidenceSource,
  proposeEvidenceFilters, rankEvidence, readEvidenceSelection, requestedEvidenceAction, restoreEvidenceChatResponse, searchEvidence,
  sendEvidenceChat, writeEvidenceSelection,
  type EvidenceChatMessage, type EvidenceComparison, type EvidenceExplanation, type EvidenceExportFormat, type EvidenceOverview,
} from "../../lib/evidence-client";
import type { AssistantActionCard } from "../../lib/upgrades/action-cards";
import { createAssistantActionContext, createLocalAssistantActionApproval } from "../../lib/upgrades/action-registry";
import {
  createAssistantActionId, createAssistantActionLifecycle, type AssistantActionLifecycle,
  type AssistantActionProposalResult,
} from "../../lib/upgrades/action-lifecycle";
import type { AssistantActionContext } from "../../lib/upgrades/actions";
import type { ComparatorSearchResult, SelectedRunsContextResult } from "../../lib/upgrades/comparison-context";
import { buildSelectedRunsContext } from "../../lib/upgrades/comparison-engine";
import type { EvidenceAnswerSnapshot, NotebookStep, PlotNotebookStep } from "../../lib/upgrades/notebook";
import {
  createComparisonNotebookStep, createEvidenceAnswerNotebookStep, createPlotNotebookStep, snapshotEvidenceAnswer,
} from "../../lib/upgrades/notebook-engine";
import type { PlotResult, PlotSpec } from "../../lib/upgrades/plot";
import { buildPlotResult } from "../../lib/upgrades/plot-engine";
import { answerSources, Assistant, explanationLabel, type ChatTurn } from "./assistant";
import { acceptPlannedAssistantAction, assistantPlanResultMessage, requestAssistantActionPlan } from "./action-planning-client";
import { planLocalAssistantAction, type AssistantActionPlanner } from "./assistant-actions";
import { Comparison } from "./comparison";
import { ComparisonContextView } from "./comparison-context";
import { BriefPreview, Overview, RunWorkspace } from "./collection";
import { Explorer } from "./explorer";
import { Icon, type InspectSource } from "./elements";
import { focusElement } from "./files";
import { useNotebookController } from "./notebook-store";
import { NotebookWorkspace } from "./notebook-workspace";
import { fieldLabelFor, scatterPlotSpec } from "./plot-model";
import { PlotWorkspace } from "./plot-workspace";
import { SourceInspector, type SourceResult } from "./source-inspector";
import type { RecordedExample } from "./recorded-examples";

const defaultIds = ["FLEX-001", "FLEX-004"];
const defaultSearch = { investigation: "FLEX" };
const destinations = [
  { id: "overview", label: "Collection", icon: "file" },
  { id: "compare", label: "Compare", icon: "grid" },
  { id: "explore", label: "Runs", icon: "table" },
  { id: "sources", label: "Sources", icon: "file" },
] as const;
const exportFormats = [
  { id: "json", label: "JSON" },
  { id: "csv", label: "CSV" },
  { id: "brief", label: "Printable HTML" },
] as const;

type View = "compare" | "explore" | "overview" | "detail" | "brief" | "explain" | "notebook";
type Panel =
  | { type: "source"; runId: string; fieldKey: string }
  | { type: "answer-brief"; turnId: string }
  | { type: "sources" | "exports" };
type Details = { source?: SourceResult; error: string };
type Ranking = Awaited<ReturnType<typeof rankEvidence>>;
type SearchWithQuestion = { search: RunSearchRequest; question?: string; pushHistory?: boolean };
type AppliedSearch = SearchWithQuestion & { request: SearchWithQuestion };
type Conversation = { id: string; turns: ChatTurn[] };
type FrozenPlot = { spec: PlotSpec; result: PlotResult };
const chatStorageKey = "fire-evidence-chat-v1";
const maxStoredTurns = 12;
const maxStoredCharacters = 480_000;

function restoreConversation(): Conversation {
  const fallback = { id: crypto.randomUUID(), turns: [] };
  try {
    const stored = sessionStorage.getItem(chatStorageKey);
    if (!stored || stored.length > maxStoredCharacters) return fallback;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
        || !("turns" in value) || !Array.isArray(value.turns) || value.turns.length > maxStoredTurns) return fallback;
    const ids = new Set<string>();
    const turns: ChatTurn[] = [];
    for (const item of value.turns) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || ids.has(item.id)
          || typeof item.question !== "string" || !item.question.trim() || item.question.length > 500
          || !Array.isArray(item.runIds) || item.runIds.length > 3
          || item.runIds.some((id: unknown) => typeof id !== "string" || !/^FLEX-\d{3}$/.test(id))
          || new Set(item.runIds).size !== item.runIds.length
          || (item.mode !== "chat" && item.mode !== "proposal")
          || !["pending", "complete", "failed", "stopped"].includes(item.status)) continue;
      let response: ChatTurn["response"];
      if (item.status === "complete") {
        try { response = restoreEvidenceChatResponse(item.response); } catch { continue; }
      }
      const requestedAction = requestedEvidenceAction(item.question);
      const action: ChatTurn["action"] = item.mode === "chat" && item.status === "complete" && requestedAction
        && item.action?.kind === requestedAction.kind ? {
          ...requestedAction,
          answerTurnId: turns.some(turn => turn.id === item.action.answerTurnId && turn.response?.kind === "explanation")
            ? item.action.answerTurnId : undefined,
        } : undefined;
      ids.add(item.id);
      // Typed action cards are session-local and are never restored from storage.
      turns.push({ id: item.id, question: item.question, runIds: item.runIds, mode: item.mode,
        planning: item.planning === true ? true : undefined,
        status: item.status === "pending" ? "stopped" : item.status,
        error: item.status === "pending" ? "Request interrupted by a reload."
          : typeof item.error === "string" ? item.error.slice(0, 500) : undefined,
        response, action });
    }
    return { id: value.id, turns };
  } catch {
    return fallback;
  }
}

function recentHistory(turns: readonly ChatTurn[]) {
  const history: EvidenceChatMessage[] = [];
  let historyRunIds: string[] | undefined;
  let characters = 0;
  for (const { question, response, runIds, action } of [...turns].reverse()) {
    if (!response || action || history.length >= 8) continue;
    const text = response.kind === "explanation" ? response.result.explanation.claims.map(claim => claim.text).join(" ")
      : response.kind === "proposal" ? [response.reply, ...response.result.filters.map(describeProposedFilter)].filter(Boolean).join("\n")
      : response.reply;
    const reply = text.trim().slice(0, 500);
    if (history.length + (reply ? 2 : 1) > 8 || characters + question.length + reply.length > 2_000) break;
    if (reply) history.unshift({ role: "assistant", content: reply });
    history.unshift({ role: "user", content: question });
    characters += question.length + reply.length;
    if (response.kind === "explanation") historyRunIds ??= runIds;
  }
  return { history, historyRunIds };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "The evidence service could not complete the request.";
}

function proposalFailure(result: AssistantActionProposalResult): string {
  if (result.ok) return "";
  return result.outcome.kind === "invalid"
    ? `I could not prepare that action: ${result.outcome.issues[0]?.message ?? "the request is invalid."}`
    : "I could not prepare that action for the current workspace.";
}

function plotStepTitle(spec: PlotSpec): string {
  const label = (key: string) => fieldLabelFor(key);
  const title = spec.kind === "scatter"
    ? `${label(spec.axes.x.field)} × ${label(spec.axes.y.field)}`
    : `${label(spec.axes.y.field)} by selected run`;
  return title.slice(0, 160);
}

type ModeRowProps = {
  ariaLabel: string;
  options: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  onOpenNotebook: () => void;
};

function ModeRow({ ariaLabel, options, active, onSelect, onOpenNotebook }: ModeRowProps) {
  return <div className="workspace-controls mode-controls">
    <div className="mode-cluster">
      <div className="segmented" role="group" aria-label={ariaLabel}>
        {options.map(option => <button key={option.id} type="button" aria-pressed={active === option.id}
          onClick={() => onSelect(option.id)}>{option.label}</button>)}
      </div>
      <span className="mode-source">NASA PSI / FLEX</span>
    </div>
    <button className="button notebook-action" type="button" onClick={onOpenNotebook}><Icon name="file" /> Notebook</button>
  </div>;
}

export type WorkbenchProps = {
  /** Public curated corpus; parsed on the server and passed as serializable props. */
  dataset: Dataset;
  /** Manifest hash used to compare this corpus with the served overview identity. */
  datasetSha256: string;
  /** Optional local planner override; the deterministic local planner is the default. */
  planAction?: AssistantActionPlanner;
};

export function Workbench({ dataset, datasetSha256, planAction }: WorkbenchProps) {
  const [view, setView] = useState<View>("compare");
  const [runsMode, setRunsMode] = useState<"table" | "plot">("table");
  const [compareMode, setCompareMode] = useState<"measurements" | "context">("measurements");
  const [plotSpec, setPlotSpec] = useState<PlotSpec>(() => scatterPlotSpec("diameter", "burn_time", { kind: "all-reviewed-runs" }));
  const [frozenPlot, setFrozenPlot] = useState<FrozenPlot>();
  const [inspectedPlotRunId, setInspectedPlotRunId] = useState<string>();
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [actionCards, setActionCards] = useState<AssistantActionCard[]>([]);
  const [cardBusyActionId, setCardBusyActionId] = useState<string>();
  const [appliedComparator, setAppliedComparator] = useState<{ result: ComparatorSearchResult; key: string }>();
  const [runIds, setRunIds] = useState(defaultIds);
  const [selected, setSelected] = useState(defaultIds);
  const [overview, setOverview] = useState<EvidenceOverview>();
  const [overviewError, setOverviewError] = useState("");
  const [overviewAttempt, setOverviewAttempt] = useState(0);
  const [linkNotice, setLinkNotice] = useState("");
  const [searchRequest, setSearchRequest] = useState<SearchWithQuestion>({ search: defaultSearch });
  const [appliedSearch, setAppliedSearch] = useState<AppliedSearch>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [searchError, setSearchError] = useState("");
  const [searchBusy, setSearchBusy] = useState(true);
  const [rankingReference, setRankingReference] = useState("");
  const [ranking, setRanking] = useState<Ranking>();
  const [rankError, setRankError] = useState("");
  const [comparison, setComparison] = useState<EvidenceComparison>();
  const [compareError, setCompareError] = useState("");
  const [panel, setPanel] = useState<Panel>();
  const [details, setDetails] = useState<Details>({ error: "" });
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<Run>();
  const [detailError, setDetailError] = useState("");
  const [draft, setDraft] = useState("");
  const [conversation, setConversation] = useState<Conversation>();
  const [compactChatRunIds, setCompactChatRunIds] = useState<string[]>(defaultIds);
  const [recordedExample, setRecordedExample] = useState<RecordedExample>();
  const [pendingTurnId, setPendingTurnId] = useState<string>();
  const [planningTurnId, setPlanningTurnId] = useState<string>();
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [includedExplanationId, setIncludedExplanationId] = useState<string>();
  const aiRequest = useRef<{ controller: AbortController; turnId: string } | null>(null);
  const plannerRequest = useRef<{ controller: AbortController; turnId: string } | null>(null);
  const draftRevision = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const currentView = useRef<View>("compare");
  const trustedSnapshots = useRef(new Map<string, EvidenceAnswerSnapshot>());
  const lifecycleRef = useRef<AssistantActionLifecycle | null>(null);
  const datasetRef = useRef(dataset);
  datasetRef.current = dataset;
  const workspaceId = useRef(`workbench-${crypto.randomUUID()}`).current;
  const turns = conversation?.turns ?? [];
  const notebook = useNotebookController(dataset, datasetSha256);
  const contextRunIds = view === "explain" ? compactChatRunIds
    : view === "detail" ? (detailId ? [detailId] : []) : view === "explore" ? selected : runIds;

  const corpusReady = !overview
    || (overview.datasetVersion === dataset.version && overview.datasetSha256 === datasetSha256);
  const corpusNotice = overview && !corpusReady
    ? "The corpus in this workspace does not match the served overview identity. Deterministic tools are paused until they match."
    : "";

  const specKey = JSON.stringify(plotSpec);
  const frozenActive = frozenPlot !== undefined && JSON.stringify(frozenPlot.spec) === specKey;
  const plotBuild = useMemo(() => {
    if (!corpusReady) return { error: "" };
    if (plotSpec.kind === "point-comparison"
      && (plotSpec.scope.kind !== "explicit-runs" || plotSpec.scope.runIds.length === 0)) return { error: "" };
    try {
      return { result: buildPlotResult(dataset, plotSpec), error: "" };
    } catch (error) {
      return { error: message(error) };
    }
  }, [dataset, plotSpec, corpusReady]);
  const plotResult = frozenActive ? frozenPlot.result : plotBuild.result;
  const plotError = frozenActive ? "" : plotBuild.error;
  const planningComparison = useMemo(() => {
    if (!corpusReady || runIds.length < 2) return undefined;
    try {
      return buildSelectedRunsContext(dataset, { version: "comparison-context-request-1", kind: "selected-runs", runIds });
    } catch {
      return undefined;
    }
  }, [dataset, runIds, corpusReady]);

  const activeContext = createAssistantActionContext({
    workspaceId,
    turnId: turns.at(-1)?.id ?? "no-turn",
    datasetVersion: dataset.version,
    selectedRunIds: contextRunIds,
    selectionRevision,
  });
  const activeContextRef = useRef<AssistantActionContext>(activeContext);
  activeContextRef.current = activeContext;
  /**
   * Latest committed corpus facts for asynchronous planner callbacks. The ref
   * is refreshed on every render so a response is checked against the corpus
   * the user is actually looking at, not the render that sent it.
   */
  const liveState = useRef({ corpusReady, datasetVersion: dataset.version });
  liveState.current = { corpusReady, datasetVersion: dataset.version };

  useEffect(() => { setConversation(restoreConversation()); }, []);

  useEffect(() => {
    if (!conversation) return;
    try {
      const turns = [...conversation.turns];
      let serialized = JSON.stringify({ ...conversation, turns });
      while (turns.length && serialized.length > maxStoredCharacters) {
        turns.shift();
        serialized = JSON.stringify({ ...conversation, turns });
      }
      sessionStorage.setItem(chatStorageKey, serialized);
    } catch {
      // Chat remains usable if this tab cannot save browser storage.
    }
  }, [conversation]);

  useEffect(() => {
    const controller = new AbortController();
    setOverviewError("");
    getEvidenceOverview({ signal: controller.signal }).then(setOverview, error => {
      if (!controller.signal.aborted) setOverviewError(message(error));
    });
    return () => controller.abort();
  }, [overviewAttempt]);

  useEffect(() => {
    function readLocation() {
      const url = new URL(window.location.href);
      const ids = readEvidenceSelection(url);
      const search = readEvidenceSearch(url);
      const nextIds = ids.length ? ids : defaultIds;
      const nextView = url.searchParams.get("view") === "explore" ? "explore" : "compare";
      currentView.current = nextView;
      setView(nextView);
      setRunIds(current => current.join() === nextIds.join() ? current : nextIds);
      setSelected(current => current.join() === nextIds.join() ? current : nextIds);
      setSelectionRevision(revision => revision + 1);
      setRankingReference(reference => nextIds.includes(reference) ? reference : "");
      setSearchBusy(true);
      setSearchRequest({ search: search ?? defaultSearch });
      setLinkNotice((url.searchParams.has("search") && !search) || (url.searchParams.has("run") && !ids.length)
        ? "Some settings in this link could not be restored. Defaults were used for those settings." : "");
      setIncludedExplanationId(undefined);
      setFrozenPlot(undefined);
    }
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => {
      window.removeEventListener("popstate", readLocation);
      aiRequest.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setComparison(undefined);
    setCompareError("");
    compareEvidence(runIds, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setComparison(result);
    }, error => {
      if (!controller.signal.aborted) setCompareError(message(error));
    });
    return () => controller.abort();
  }, [runIds]);

  useEffect(() => {
    const controller = new AbortController();
    setSearchError("");
    setSearchBusy(true);
    searchEvidence(searchRequest.search, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setRuns(result.runs);
      setAppliedSearch({ search: result.search, question: searchRequest.question, request: searchRequest });
      setSearchBusy(false);
      if (searchRequest.pushHistory) {
        const current = new URL(window.location.href);
        const next = writeEvidenceSearch(current, result.search);
        if (currentView.current === "explore") next.searchParams.set("view", "explore");
        else next.searchParams.delete("view");
        if (next.href !== current.href) window.history.pushState(null, "", next);
      }
    }, error => {
      if (controller.signal.aborted) return;
      setSearchError(message(error));
      setSearchBusy(false);
    });
    return () => controller.abort();
  }, [searchRequest]);

  useEffect(() => {
    const controller = new AbortController();
    setRanking(undefined);
    setRankError("");
    if (rankingReference && selected.includes(rankingReference) && appliedSearch?.request === searchRequest && !searchBusy && !searchError) {
      rankEvidence(rankingReference, appliedSearch.search, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) setRanking(result);
      }, error => {
        if (!controller.signal.aborted) setRankError(message(error));
      });
    }
    return () => controller.abort();
  }, [rankingReference, selected, appliedSearch, searchRequest, searchBusy, searchError]);

  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController();
    getEvidenceRun(detailId, { signal: controller.signal }).then(({ run }) => {
      if (!controller.signal.aborted) setDetail(run);
    }, error => {
      if (!controller.signal.aborted) setDetailError(message(error));
    });
    return () => controller.abort();
  }, [detailId]);

  useEffect(() => {
    const controller = new AbortController();
    setDetails({ error: "" });
    if (panel?.type === "source") {
      getEvidenceSource(panel.runId, panel.fieldKey, { signal: controller.signal }).then(source => {
        if (!controller.signal.aborted) setDetails({ source, error: "" });
      }, error => {
        if (!controller.signal.aborted) setDetails({ error: message(error) });
      });
    }
    return () => controller.abort();
  }, [panel]);

  useEffect(() => {
    if (panel) paneRef.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (plotSpec.kind !== "point-comparison") return;
    const current = plotSpec.scope.kind === "explicit-runs" ? plotSpec.scope.runIds : [];
    if (current.join() === selected.join()) return;
    setPlotSpec({ ...plotSpec, scope: { kind: "explicit-runs", runIds: [...selected] } });
  }, [selected, plotSpec]);

  function openPanel(next: Panel, trigger?: HTMLElement) {
    if (!panel) returnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDetails({ error: "" });
    if (next.type === "exports" || next.type === "answer-brief") {
      setDownloadError("");
      setDownloadNotice("");
    }
    setPanel(next);
  }

  function closePanel() {
    const focus = returnFocus.current;
    setPanel(undefined);
    requestAnimationFrame(() => focus?.focus());
  }

  const inspect: InspectSource = (runId, fieldKey, trigger) => openPanel({ type: "source", runId, fieldKey }, trigger);

  function navigate(next: View) {
    setPanel(undefined);
    currentView.current = next;
    setView(next);
    window.scrollTo(0, 0);
  }

  function openRun(id: string) {
    if (id !== detailId) {
      setDetail(undefined);
      setDetailError("");
      setDetailId(id);
    }
    navigate("detail");
  }

  function updateTurn(id: string, patch: Partial<ChatTurn>) {
    setConversation(current => current && ({ ...current,
      turns: current.turns.map(turn => turn.id === id ? { ...turn, ...patch } : turn) }));
  }

  function stop() {
    const activeRequest = aiRequest.current;
    const activePlan = plannerRequest.current;
    if (!activeRequest && !activePlan) return;
    if (activeRequest) {
      activeRequest.controller.abort();
      aiRequest.current = null;
      setPendingTurnId(undefined);
      updateTurn(activeRequest.turnId, { status: "stopped" });
    }
    if (activePlan) {
      activePlan.controller.abort();
      plannerRequest.current = null;
      setPlanningTurnId(undefined);
      updateTurn(activePlan.turnId, {
        status: "stopped",
        error: "AI planning was cancelled. Nothing was registered.",
      });
    }
  }

  function clearChat(keepDraft: boolean) {
    stop();
    setConversation({ id: crypto.randomUUID(), turns: [] });
    setActionCards([]);
    setTrustedSnapshots(new Map());
    setIncludedExplanationId(undefined);
    if (!keepDraft) changeDraft("");
  }

  function setTrustedSnapshots(map: Map<string, EvidenceAnswerSnapshot>) {
    trustedSnapshots.current = map;
  }

  function applySelection(ids: string[], inspectRunId?: string) {
    setSelected(ids);
    setSelectionRevision(revision => revision + 1);
    if (inspectRunId) setInspectedPlotRunId(inspectRunId);
  }

  function chooseRun(id: string) {
    if (rankingReference === id && selected.includes(id)) changeRankingReference("");
    const next = selected.includes(id)
      ? selected.filter(item => item !== id)
      : selected.length < 3 ? [...selected, id] : selected;
    if (next !== selected) applySelection(next, id);
  }

  function updatePlotSpec(next: PlotSpec) {
    setFrozenPlot(undefined);
    setPlotSpec(next);
  }

  function submitSearch(search: RunSearchRequest, question?: string) {
    setSearchBusy(true);
    setSearchError("");
    setRankError("");
    setRanking(undefined);
    setSearchRequest({ search, question, pushHistory: true });
    setLinkNotice("");
  }

  function changeRankingReference(id: string) {
    setRankError("");
    setRanking(undefined);
    setRankingReference(id);
  }

  function pushSelection(ids: string[]) {
    const current = new URL(window.location.href);
    const next = writeEvidenceSelection(current, ids);
    next.searchParams.delete("view");
    if (next.href !== current.href) window.history.pushState(null, "", next);
  }

  function resetComparison() {
    const current = new URL(window.location.href);
    const next = writeEvidenceSelection(current, []);
    if (next.searchParams.has("search") && !readEvidenceSearch(next)) next.searchParams.delete("search");
    next.searchParams.delete("view");
    if (next.href !== current.href) window.history.pushState(null, "", next);
    applySelection([...defaultIds]);
    if (!defaultIds.includes(rankingReference)) changeRankingReference("");
    setRunIds([...defaultIds]);
    setAppliedComparator(undefined);
    setIncludedExplanationId(undefined);
    setLinkNotice("");
    setCompareMode("measurements");
    navigate("compare");
  }

  function compareSelected() {
    if (selected.length < 2) return;
    if (runIds.join() !== selected.join()) {
      setIncludedExplanationId(undefined);
      setComparison(undefined);
      setRunIds(selected);
    }
    setAppliedComparator(undefined);
    pushSelection(selected);
    setCompareMode("measurements");
    navigate("compare");
  }

  function changeDraft(next: string) {
    draftRevision.current++;
    setDraft(next);
  }

  async function requestTurn(turn: ChatTurn, prior: ChatTurn[], sentRevision?: number) {
    if (aiRequest.current || plannerRequest.current || (turn.mode === "proposal" && !overview?.aiEnabled)) return;
    const controller = new AbortController();
    aiRequest.current = { controller, turnId: turn.id };
    setPendingTurnId(turn.id);
    try {
      const response = turn.mode === "proposal"
        ? { kind: "proposal" as const, result: await proposeEvidenceFilters(turn.question, { signal: controller.signal }) }
        : await sendEvidenceChat({ question: turn.question, runIds: turn.runIds, ...recentHistory(prior) }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      updateTurn(turn.id, { status: "complete", response });
      if (draftRevision.current === sentRevision) setDraft("");
    } catch (error) {
      if (!controller.signal.aborted) updateTurn(turn.id, { status: "failed", error: message(error) });
    } finally {
      if (aiRequest.current?.controller === controller) {
        aiRequest.current = null;
        setPendingTurnId(undefined);
      }
    }
  }

  function lifecycle(): AssistantActionLifecycle {
    if (!lifecycleRef.current) {
      lifecycleRef.current = createAssistantActionLifecycle({
        getDataset: () => datasetRef.current ?? null,
        readActiveContext: () => activeContextRef.current,
        onRecord: (_record, card) => {
          setActionCards(current => [...current.filter(item => item.actionId !== card.actionId), card]);
        },
      });
    }
    return lifecycleRef.current;
  }

  function actionContext(turnId: string): AssistantActionContext {
    const context = createAssistantActionContext({
      workspaceId,
      turnId,
      datasetVersion: dataset.version,
      selectedRunIds: contextRunIds,
      selectionRevision,
    });
    activeContextRef.current = context;
    return context;
  }

  /** Latest committed context for an asynchronous planner response. */
  function currentLiveContext(): AssistantActionContext {
    return activeContextRef.current;
  }

  /**
   * U09.3 — one explicit user action asks the server planner for at most one
   * read-only proposal. No retry, auto-apply or notebook effect is implied.
   */
  function planWithAi() {
    if (!overview?.aiEnabled || aiRequest.current || plannerRequest.current || !conversation) return;
    const question = draft.trim();
    if (!question) return;
    const turn: ChatTurn = { id: crypto.randomUUID(), question, mode: "chat", runIds: [...contextRunIds], status: "pending", planning: true };
    const plannedContext = actionContext(turn.id);
    const actionId = createAssistantActionId();
    const controller = new AbortController();
    plannerRequest.current = { controller, turnId: turn.id };
    setPlanningTurnId(turn.id);
    setConversation(current => current
      ? { ...current, turns: [...current.turns, turn].slice(-maxStoredTurns) }
      : current);
    void requestAiPlan(turn, question, actionId, plannedContext, controller, draftRevision.current);
  }

  async function requestAiPlan(
    turn: ChatTurn,
    question: string,
    actionId: string,
    plannedContext: AssistantActionContext,
    controller: AbortController,
    sentRevision: number,
  ) {
    try {
      const plan = await requestAssistantActionPlan({
        question,
        actionId,
        context: plannedContext,
        datasetVersion: liveState.current.datasetVersion,
        datasetSha256,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (plan.status !== "proposed") {
        updateTurn(turn.id, plan.status === "cancelled"
          ? { status: "stopped", error: assistantPlanResultMessage(plan) }
          : { status: "complete", response: { kind: "conversation", reply: assistantPlanResultMessage(plan) } });
        return;
      }
      // Recheck corpus, workspace, turn and ordered selection against the
      // latest committed state before the lifecycle records the proposal.
      const acceptance = acceptPlannedAssistantAction({
        plan,
        plannedContext,
        actionId,
        activeContext: currentLiveContext(),
        dataset: datasetRef.current,
        datasetSha256,
        corpusReady: liveState.current.corpusReady,
        lifecycle: lifecycle(),
      });
      if (!acceptance.ok) {
        updateTurn(turn.id, { status: "complete", response: { kind: "conversation", reply: acceptance.message } });
        return;
      }
      updateTurn(turn.id, {
        status: "complete",
        cardActionId: acceptance.card.actionId,
        cardOrigin: "ai",
        response: {
          kind: "conversation",
          reply: "I planned one read-only action. It is bound to this workspace, corpus and ordered selection; review it and confirm to run. Opening the result or its sources spends no further AI calls.",
        },
      });
      if (draftRevision.current === sentRevision) setDraft("");
    } catch (error) {
      if (!controller.signal.aborted) updateTurn(turn.id, { status: "failed", error: message(error) });
    } finally {
      if (plannerRequest.current?.controller === controller) {
        plannerRequest.current = null;
        setPlanningTurnId(undefined);
      }
    }
  }

  function plannedTurn(turn: ChatTurn, reply: string): ChatTurn {
    return { ...turn, status: "complete", response: { kind: "conversation", reply } };
  }

  function send(mode: ChatTurn["mode"], trigger?: HTMLElement) {
    const question = draft.trim();
    if (!question || !conversation || aiRequest.current || plannerRequest.current
      || (mode === "proposal" && !overview?.aiEnabled)) return;
    const turn: ChatTurn = { id: crypto.randomUUID(), question, mode, runIds: [...contextRunIds], status: "pending" };
    const action = mode === "chat" ? requestedEvidenceAction(question) : undefined;
    if (action) {
      const recent = turns.slice(-(maxStoredTurns - 1));
      const answer = recent.findLast(item => item.response?.kind === "explanation");
      const result = answer?.response?.kind === "explanation" && isCurrentEvidence(answer.response.result)
        ? answer.response.result : undefined;
      const sources = action.kind === "source" && result ? answerSources(result, action.runId) : [];
      const source = sources.length === 1 ? sources[0] : undefined;
      const target = action.kind === "source" ? (sources.length > 0 ? answer?.id : undefined) : (result ? answer?.id : undefined);
      const reply = !result ? "Ask me about a FLEX run first, then I can open its source or prepare a brief."
        : action.kind === "brief" ? "I’ve opened a brief for that answer. You can review it before downloading."
        : source ? "I’ve opened the source for that answer."
        : sources.length ? "That answer cites more than one source. Which one would you like to open?"
        : action.runId ? `That answer has no citation for ${action.runId}.` : "I couldn’t find a source citation in that answer.";
      setConversation({ ...conversation, turns: [...recent, { ...turn, status: "complete",
        action: { ...action, answerTurnId: target }, response: { kind: "conversation", reply } }] });
      setDraft("");
      if (source) openPanel({ type: "source", runId: source.runId, fieldKey: source.fieldKey }, trigger);
      if (action.kind === "brief" && target) openPanel({ type: "answer-brief", turnId: target }, trigger);
      return;
    }

    if (mode === "chat") {
      const recent = turns.slice(-(maxStoredTurns - 1));
      const trustedAnswer = turns.flatMap(item => item.response?.kind === "explanation" ? [item.response.result] : [])
        .filter(answer => canPinAnswer(answer)).at(-1);
      let planned;
      try {
        planned = (planAction ?? planLocalAssistantAction)({
          question,
          dataset,
          context: actionContext(turn.id),
          selectedRunIds: contextRunIds,
          search: searchRequest.search,
          currentPlot: plotResult && corpusReady && !frozenActive ? { spec: plotSpec, result: plotResult } : undefined,
          currentComparison: planningComparison,
          trustedAnswer,
          nextActionId: createAssistantActionId,
          nextStepId: () => crypto.randomUUID(),
        });
      } catch (error) {
        planned = { reply: `I could not prepare a typed action: ${message(error)}` };
      }
      if (planned) {
        let nextTurn = plannedTurn(turn, planned.reply);
        if (planned.request) {
          const proposal = lifecycle().propose(planned.request);
          if (proposal.ok) {
            nextTurn = { ...nextTurn, cardActionId: planned.request.actionId };
            if (planned.request.kind === "prepare_notebook_step" && planned.trustedAnswerSnapshot) {
              trustedSnapshots.current.set(planned.request.actionId, planned.trustedAnswerSnapshot);
            }
          } else {
            nextTurn = plannedTurn(turn, proposalFailure(proposal));
          }
        }
        setConversation({ ...conversation, turns: [...recent, nextTurn] });
        setDraft("");
        return;
      }
    }

    setConversation({ ...conversation, turns: [...turns, turn].slice(-maxStoredTurns) });
    void requestTurn(turn, turns, draftRevision.current);
  }

  function retry(turn: ChatTurn) {
    if (aiRequest.current || plannerRequest.current || turn.planning
      || (turn.mode === "proposal" && !overview?.aiEnabled)) return;
    const index = turns.findIndex(item => item.id === turn.id);
    if (index < 0) return;
    updateTurn(turn.id, { status: "pending", error: undefined });
    void requestTurn(turn, turns.slice(0, index), draft.trim() === turn.question ? draftRevision.current : undefined);
  }

  function canPrepareBrief(answer: EvidenceExplanation) {
    return Boolean(comparison && answer.explanationReceipt && answer.datasetSha256 === comparison.datasetSha256
      && answer.comparisonRuleVersion === comparison.comparisonRuleVersion
      && answer.runIds.length === runIds.length && answer.runIds.every((id, index) => id === runIds[index]));
  }

  function canDownloadAnswer(answer: EvidenceExplanation) {
    return Boolean(answer.explanationReceipt && isCurrentEvidence(answer));
  }

  function canPinAnswer(answer: EvidenceExplanation) {
    return Boolean(answer.explanationReceipt && isCurrentEvidence(answer));
  }

  function isCurrentEvidence(answer: EvidenceExplanation) {
    return answer.datasetSha256 === overview?.datasetSha256 && answer.comparisonRuleVersion === overview?.comparisonRuleVersion;
  }

  function pinAnswer(turnId: string, answer: EvidenceExplanation, _trigger: HTMLButtonElement) {
    if (!corpusReady || !canPinAnswer(answer)) return;
    const turn: ChatTurn = {
      id: crypto.randomUUID(),
      question: "Review this trusted answer as a notebook step.",
      mode: "chat",
      runIds: [...answer.runIds],
      status: "complete",
      response: { kind: "conversation", reply: "I’ve prepared a stored-answer snapshot for review. Adding it to the notebook draft requires confirmation; saving stays explicit." },
    };
    setConversation(current => current ? { ...current, turns: [...current.turns, turn].slice(-maxStoredTurns) } : current);
    void turnId;
    try {
      const step = createEvidenceAnswerNotebookStep({
        stepId: crypto.randomUUID(),
        title: `Answer · ${answer.runIds.join(" · ")}`.slice(0, 160),
        answer,
      });
      const request = {
        version: "assistant-action-1" as const,
        actionId: createAssistantActionId(),
        kind: "prepare_notebook_step" as const,
        context: actionContext(turn.id),
        step,
      };
      const proposal = lifecycle().propose(request);
      if (proposal.ok) {
        trustedSnapshots.current.set(request.actionId, snapshotEvidenceAnswer(answer));
        updateTurn(turn.id, { cardActionId: request.actionId });
      } else {
        updateTurn(turn.id, { response: { kind: "conversation", reply: proposalFailure(proposal) } });
      }
    } catch (error) {
      updateTurn(turn.id, { response: { kind: "conversation", reply: message(error) } });
    }
  }

  async function confirmCard(actionId: string, trigger: HTMLButtonElement) {
    const card = lifecycle().getCard(actionId);
    if (!card || !corpusReady) return;
    setCardBusyActionId(actionId);
    try {
      const approval = card.requiresUserApproval ? createLocalAssistantActionApproval(card.request) : undefined;
      const result = await lifecycle().confirm(actionId, approval, {
        trustedAnswerSnapshot: trustedSnapshots.current.get(actionId),
        activeDatasetSha256: datasetSha256,
      });
      setActionCards(current => [...current.filter(item => item.actionId !== result.card.actionId), result.card]);
      if (result.applied && result.outcome?.kind === "plot-result" && card.request.kind === "create_plot") {
        setFrozenPlot(undefined);
        setPlotSpec(card.request.plot);
        setRunsMode("plot");
        navigate("explore");
      } else if (result.applied && result.outcome?.kind === "comparison-context") {
        const ids = [...result.outcome.result.runIds];
        applySelection(ids);
        setRunIds(ids);
        pushSelection(ids);
        setCompareMode("context");
        navigate("compare");
      } else if (result.applied && result.outcome?.kind === "comparator-search") {
        setAppliedComparator({ result: result.outcome.result, key: crypto.randomUUID() });
        setCompareMode("context");
        navigate("compare");
      } else if (result.applied && result.outcome?.kind === "notebook-step") {
        notebook.append(result.outcome.step);
      }
      focusElement(`card-${actionId}`);
    } catch (error) {
      notebook.reportError(message(error));
    } finally {
      setCardBusyActionId(undefined);
    }
    void trigger;
  }

  function cancelCard(actionId: string) {
    try {
      const result = lifecycle().cancel(actionId);
      setActionCards(current => [...current.filter(item => item.actionId !== result.card.actionId), result.card]);
      focusElement(`card-${actionId}`);
    } catch {
      // A missing lifecycle entry leaves the transcript unchanged.
    }
  }

  function openActionWorkspace(card: AssistantActionCard) {
    if (card.kind === "prepare_notebook_step") {
      navigate("notebook");
      return;
    }
    if (card.kind === "create_plot") {
      if (card.request.kind === "create_plot") {
        setFrozenPlot(undefined);
        setPlotSpec(card.request.plot);
      }
      setRunsMode("plot");
      navigate("explore");
      return;
    }
    setCompareMode("context");
    navigate("compare");
  }

  function pinPlot(spec: PlotSpec, result: PlotResult) {
    if (!corpusReady) return;
    if (result.resolvedRunIds.length === 0) {
      notebook.reportError("An empty plot cannot be pinned as a notebook step. Change the scope or filters first.");
      navigate("notebook");
      return;
    }
    try {
      const step = createPlotNotebookStep({
        stepId: crypto.randomUUID(),
        title: plotStepTitle(spec),
        plotSpec: spec,
        plotResult: result,
      });
      notebook.append(step);
      navigate("notebook");
    } catch (error) {
      notebook.reportError(message(error));
      navigate("notebook");
    }
  }

  function pinComparison(context: SelectedRunsContextResult) {
    if (!corpusReady) return;
    try {
      const step = createComparisonNotebookStep({
        stepId: crypto.randomUUID(),
        title: `${context.runIds.join(" vs ")} context`.slice(0, 160),
        context,
      });
      notebook.append(step);
      navigate("notebook");
    } catch (error) {
      notebook.reportError(message(error));
      navigate("notebook");
    }
  }

  function openPlotStep(step: PlotNotebookStep) {
    setFrozenPlot({ spec: step.plotSpec, result: step.plotResult });
    setPlotSpec(step.plotSpec);
    setRunsMode("plot");
    navigate("explore");
  }

  function openComparisonRuns(ids: string[]) {
    const ordered = ids.filter(id => dataset.runs.some(run => run.id === id)).slice(0, 3);
    if (ordered.length < 2) return;
    applySelection(ordered);
    setRunIds(ordered);
    setAppliedComparator(undefined);
    pushSelection(ordered);
    setCompareMode("context");
    navigate("compare");
  }

  const briefAnswers = turns.filter(turn => turn.response?.kind === "explanation" && canPrepareBrief(turn.response.result));
  const briefTurn = briefAnswers.at(-1);
  const explanation = briefTurn?.response?.kind === "explanation" ? briefTurn.response.result : undefined;
  const answerBriefTurnId = panel?.type === "answer-brief" ? panel.turnId : undefined;
  const answerBriefResponse = answerBriefTurnId && turns.find(turn => turn.id === answerBriefTurnId)?.response;
  const answerBrief = answerBriefResponse && answerBriefResponse.kind === "explanation" && isCurrentEvidence(answerBriefResponse.result)
    ? answerBriefResponse.result : undefined;

  async function download(format: EvidenceExportFormat) {
    if (downloadBusy) return;
    if (panel?.type === "answer-brief" ? !answerBrief || !canDownloadAnswer(answerBrief)
      : !comparison || comparison.runIds.join() !== runIds.join()) return;
    setDownloadBusy(true);
    setDownloadNotice("");
    setDownloadError("");
    try {
      const result = await downloadEvidence(answerBrief ? { format, runIds: answerBrief.runIds,
        question: answerBrief.requestQuestion, explanation: answerBrief, requireExplanation: true }
        : { format, runIds, search: appliedSearch?.search,
        question: explanation?.requestQuestion ?? appliedSearch?.question,
        explanation: briefTurn?.id === includedExplanationId ? explanation : undefined });
      const omitted = result.explanationStatus === "omitted-mismatch" || result.explanationStatus === "omitted-rejected";
      setDownloadNotice(omitted ? "Recorded evidence prepared. The saved explanation could not be included." : `Download prepared · ${result.filename}`);
    } catch (error) {
      setDownloadError(message(error));
    } finally {
      setDownloadBusy(false);
    }
  }

  const active = panel?.type === "sources" || panel?.type === "source" ? "sources" : view === "detail" ? "explore" : view;
  const nav = destinations.map(({ id, label, icon }) => <button key={id} type="button" aria-current={active === id ? "page" : undefined}
    onClick={event => id === "sources" ? openPanel({ type: "sources" }, event.currentTarget) : navigate(id)}><Icon name={icon} />{label}</button>);
  const assistant = <Assistant enabled={overview?.aiEnabled === true} dataset={dataset} runIds={contextRunIds}
    cards={actionCards} cardBusyActionId={cardBusyActionId}
    confirmAction={(actionId, trigger) => void confirmCard(actionId, trigger)}
    cancelAction={cancelCard} openActionWorkspace={openActionWorkspace}
    pinAnswer={pinAnswer} canPinAnswer={canPinAnswer}
    pending={Boolean(pendingTurnId) || Boolean(planningTurnId)} planning={Boolean(planningTurnId)}
    planWithAi={planWithAi} visible={!panel} draft={draft} turns={turns}
    changeDraft={changeDraft} send={trigger => send("chat", trigger)} propose={() => send("proposal")} cancel={stop}
    openAnswerBrief={(turnId, trigger) => openPanel({ type: "answer-brief", turnId }, trigger)}
    canReviewAnswer={isCurrentEvidence} canDownloadAnswer={canDownloadAnswer}
    downloadAnswer={async answer => {
      await downloadEvidence({ format: "json", runIds: answer.runIds, question: answer.requestQuestion,
        explanation: answer, requireExplanation: true });
    }}
    openComparison={() => navigate("compare")}
    retry={retry} clear={clearChat}
    checkAvailability={() => setOverviewAttempt(attempt => attempt + 1)}
    apply={(question, filters) => {
      submitSearch({ investigation: "FLEX", filters }, question);
      setRunsMode("table");
      navigate("explore");
    }} inspect={inspect} recordedExample={recordedExample} showRecordedExample={setRecordedExample}
    datasetSha256={overview?.datasetSha256} />;
  const headings = {
    compare: ["Comparison", "Your comparison, at a glance", `${runIds.join(" and ")} · recorded conditions and outcomes`],
    explore: ["Run explorer", "Explore the FLEX collection", overview ? `${overview.runCount} reviewed experiments. Select the evidence you need.` : "Select the evidence you need."],
    overview: ["Collection", "The FLEX collection", "Reviewed experiments from NASA Physical Sciences Informatics."],
    detail: ["Run detail", detailId, "Recorded conditions and outcomes"],
    brief: ["Evidence brief", "Evidence brief", "A reviewable account of the selected comparison."],
    explain: ["Assistant", "Evidence assistant", contextRunIds.join(" · ")],
    notebook: ["Notebook", "Your investigation, kept together", "Snapshots preserve the evidence you saw at each step."],
  };
  const [breadcrumb, title, subtitle] = headings[view];
  const exportExplanationLabel = explanation && explanationLabel(explanation.explanation);
  const selection = {
    datasetVersion: dataset.version,
    runIds: selected,
    revision: selectionRevision,
  };

  return <div className="workbench" data-panel={Boolean(panel)}>
    <aside className="rail"><button type="button" className="brand" aria-label="Fire Evidence Explorer" onClick={() => navigate("overview")}><Icon name="spark" /></button>
      <nav aria-label="Workspace">{nav}</nav><span className="rail-mark" aria-hidden="true">FE</span>
    </aside>
    <main className="center">
      <header className="topbar"><Icon name="menu" /><span>FLEX</span><span aria-hidden="true">›</span><strong>{breadcrumb}</strong>
        <button className="button compact-assistant" type="button" aria-label="Ask about the evidence" onClick={() => { setCompactChatRunIds([...contextRunIds]); navigate("explain"); }}><Icon name="spark" /></button>
        <button className="button top-action" type="button" aria-label="Open evidence brief" onClick={() => navigate("brief")}><Icon name="file" /></button>
      </header>
      <div className="content">
        {linkNotice && <p className="notice" role="status">{linkNotice}</p>}
        {corpusNotice && <p className="notice" role="alert">{corpusNotice}</p>}
        <div className="page-heading"><div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {(view === "compare" || view === "overview") && <button type="button" className="primary" aria-label={view === "overview" ? "Explore runs" : "Add runs"} onClick={() => { setRunsMode("table"); navigate("explore"); }}><Icon name="plus" /><span>{view === "overview" ? "Explore runs" : "Add runs"}</span></button>}
        {view === "brief" && <button type="button" className="primary" disabled={!comparison} onClick={event => openPanel({ type: "exports" }, event.currentTarget)}>Export brief</button>}
        </div>
        {view === "overview" && <Overview overview={overview} runs={runs} comparison={comparison} error={overviewError}
          retry={() => setOverviewAttempt(attempt => attempt + 1)} explore={() => { setRunsMode("table"); navigate("explore"); }}
          compare={() => { setCompareMode("measurements"); navigate("compare"); }} openRun={openRun} />}
        {view === "detail" && <RunWorkspace id={detailId} run={detail} error={detailError} selected={selected}
          select={() => chooseRun(detailId)} compare={compareSelected} explore={() => { setRunsMode("table"); navigate("explore"); }} inspect={inspect} />}
        {view === "brief" && (comparison ? <BriefPreview result={comparison} overview={overview} inspect={inspect} />
          : <p className="notice" role={compareError ? "alert" : "status"}>{compareError || "Loading comparison…"}</p>)}
        {view === "explain" && <div className="card assistant-workspace">{assistant}</div>}
        {view === "notebook" && <NotebookWorkspace controller={notebook} dataset={dataset} runCount={overview?.runCount}
          onOpenRuns={() => { setRunsMode("table"); navigate("explore"); }}
          onOpenCompare={() => { setCompareMode("context"); navigate("compare"); }}
          onReopenPlot={openPlotStep} onOpenComparison={openComparisonRuns}
          onOpenAssistant={() => { setCompactChatRunIds([...runIds]); navigate("explain"); }}
          inspect={inspect} aiEnabled={overview?.aiEnabled === true} />}
        {view === "compare" && (compareMode === "context"
          ? <ComparisonContextView dataset={dataset} runIds={runIds} corpusReady={corpusReady} corpusNotice={corpusNotice}
            inspect={inspect} onOpenNotebook={() => navigate("notebook")}
            onOpenMeasurements={() => setCompareMode("measurements")}
            onOpenRuns={() => { setRunsMode("table"); navigate("explore"); }}
            onPinComparison={pinComparison} onOpenPair={openComparisonRuns} appliedComparator={appliedComparator} />
          : <>
            <ModeRow ariaLabel="Comparison workspace mode" active="measurements"
              options={[{ id: "measurements", label: "Measurements" }, { id: "context", label: "Context" }]}
              onSelect={id => id === "context" ? setCompareMode("context") : setCompareMode("measurements")}
              onOpenNotebook={() => navigate("notebook")} />
            <div className="comparison-content">
              {compareError ? <div className="notice"><p role="alert">{compareError}</p>
                <button className="button" type="button" onClick={resetComparison}>Restore default runs</button></div>
                : comparison ? <Comparison result={comparison} inspect={inspect} />
                  : <p className="empty" role="status">Loading comparison…</p>}
            </div>
          </>)}
        {view === "explore" && (runsMode === "plot"
          ? <PlotWorkspace dataset={dataset} spec={plotSpec} onSpecChange={updatePlotSpec}
            result={plotResult} error={plotError}
            selection={selection} onSelectionChange={ids => applySelection(ids)}
            inspectedRunId={inspectedPlotRunId} onInspectRun={setInspectedPlotRunId}
            search={searchRequest.search} searchBusy={searchBusy} onSearch={submitSearch}
            onCompare={compareSelected} onSelectTableMode={() => setRunsMode("table")}
            onOpenNotebook={() => navigate("notebook")} onPinPlot={pinPlot} inspect={inspect}
            corpusReady={corpusReady} corpusNotice={corpusNotice} frozenNotice={frozenActive
              ? "Showing a frozen notebook snapshot with its original corpus. Changing an axis, scope or filter rebuilds the view from the current corpus."
              : ""} />
          : <>
            <ModeRow ariaLabel="Runs workspace mode" active="table"
              options={[{ id: "table", label: "Table" }, { id: "plot", label: "Plot" }]}
              onSelect={id => id === "plot" ? setRunsMode("plot") : setRunsMode("table")}
              onOpenNotebook={() => navigate("notebook")} />
            <Explorer runs={runs} total={overview?.runCount} selected={selected} search={searchRequest.search}
              busy={searchBusy} error={searchError} onSearch={submitSearch} onSelect={chooseRun}
              onCompare={compareSelected} onRun={openRun} inspect={inspect} rankingReference={rankingReference}
              ranking={ranking} rankError={rankError} references={selected} onRank={changeRankingReference} />
          </>)}
      </div>
    </main>
    <aside className="side-panel" aria-label="Evidence and assistant" ref={paneRef} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape" && panel) { event.stopPropagation(); closePanel(); }
    }}>
      {panel?.type === "source" && <SourceInspector result={details.source} error={details.error} close={closePanel} />}
      {panel?.type === "sources" && <div className="evidence-detail">
        <header className="evidence-heading"><h2><Icon name="file" /> Sources</h2><button type="button" className="button" onClick={closePanel}>Close</button></header>
        {overview ? <>
          <p className="source-id">{overview.runCount} reviewed FLEX runs · {overview.provenance.source.dataRows} source records</p>
          <ul className="source-list">{overview.sources.map(source => <li key={source.id}>
            <a className="source-link" href={source.url} target="_blank" rel="noreferrer">{source.title} <Icon name="link" /></a>
            <p className="muted">{source.version} · {source.license}</p>
          </li>)}</ul>
          <a className="source-link" href={overview.provenance.interpretationReference.url} target="_blank" rel="noreferrer">NASA technical report <Icon name="link" /></a>
          <dl><dt>Corpus revision</dt><dd>{overview.datasetVersion}</dd><dt>Comparison rule</dt><dd>{overview.comparisonRuleVersion}</dd></dl>
        </> : <p role={overviewError ? "alert" : "status"}>{overviewError || "Loading dataset coverage…"}</p>}
      </div>}
      {panel?.type === "exports" && <div className="evidence-detail">
        <header className="evidence-heading"><h2><Icon name="file" /> Evidence brief</h2><button type="button" className="button" onClick={closePanel}>Close</button></header>
        <p className="source-id">{runIds.join(" · ")}</p>
        <p className="source-note">Download the selected evidence, comparison and source references.</p>
        {explanation?.explanationReceipt && <label className="proposal-choice">
          <input type="checkbox" checked={briefTurn?.id === includedExplanationId} onChange={event => setIncludedExplanationId(event.target.checked ? briefTurn?.id : undefined)} /> Include the matching {exportExplanationLabel === "DeepSeek explanation" ? exportExplanationLabel : exportExplanationLabel?.toLowerCase()}
        </label>}
        {explanation && <p className="source-note">{explanation.question}</p>}
        <div className="download-controls">{exportFormats.map(format => <button key={format.id} type="button" className="button" disabled={downloadBusy || !comparison}
          onClick={() => void download(format.id)}>{format.label}</button>)}</div>
        {downloadError && <p className="notice" role="alert">{downloadError}</p>}
        <p role="status" className="source-note">{downloadBusy ? "Preparing download…" : downloadNotice}</p>
      </div>}
      {panel?.type === "answer-brief" && <div className="evidence-detail">
        <header className="evidence-heading"><h2><Icon name="file" /> Evidence brief</h2>
          <button type="button" className="button" onClick={closePanel}>Close</button></header>
        {answerBrief ? <>
          <p className="source-id">{answerBrief.runIds.join(" · ")}</p>
          <p className="source-note">{answerBrief.question}</p>
          {answerBrief.explanation.claims.length > 0 && <ul className="answer-brief-claims">
            {answerBrief.explanation.claims.map((claim, index) => <li key={index}>{claim.text}</li>)}
          </ul>}
          {canDownloadAnswer(answerBrief) ? <div className="download-controls">
            {exportFormats.map(format => <button key={format.id} type="button" className="button" disabled={downloadBusy}
              onClick={() => void download(format.id)}>{format.label}</button>)}
          </div> : <p className="source-note">A signed answer is required to download this brief.</p>}
        </> : <p className="notice" role="status">This answer is no longer available to review.</p>}
        {downloadError && <p className="notice" role="alert">{downloadError}</p>}
        <p role="status" className="source-note">{downloadBusy ? "Preparing download…" : downloadNotice}</p>
      </div>}
      {view !== "explain" && <div hidden={Boolean(panel)} style={{ height: "100%" }}>{assistant}</div>}
    </aside>
    <nav className="mobile-nav" aria-label="Workspace">{nav}</nav>
  </div>;
}
