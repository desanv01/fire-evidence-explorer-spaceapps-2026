import { useEffect, useRef, useState } from "react";
import { describeProposedFilter, type EvidenceChatResponse, type EvidenceExplanation, type EvidenceFilterProposal } from "../../lib/evidence-client";
import type { Dataset, RunSearchRequest } from "../../lib/evidence";
import { formatEvidenceValue } from "../../lib/evidence-format";
import type { AssistantActionCard } from "../../lib/upgrades/action-cards";
import { AssistantActionCardView } from "./assistant-cards";
import { coordinates, Icon, type InspectSource } from "./elements";
import { recordedExamples, type RecordedExample } from "./recorded-examples";

const claimLabels = { reported: "Observation", derived: "Computed difference", inferred: "Interpretation", insufficient: "Insufficient evidence" };

export type ChatTurn = {
  id: string;
  question: string;
  runIds: string[];
  mode: "chat" | "proposal";
  status: "pending" | "complete" | "failed" | "stopped";
  error?: string;
  response?: EvidenceChatResponse;
  action?: { kind: "source" | "brief"; runId?: string; answerTurnId?: string };
  /** One typed assistant action card attached to this reply. */
  cardActionId?: string;
  /** True for the explicit optional AI planning action (one request, no retry). */
  planning?: boolean;
  /** Set when the attached card came from the explicit AI planner. */
  cardOrigin?: "ai";
};

type Props = {
  enabled: boolean;
  dataset: Dataset;
  cards: readonly AssistantActionCard[];
  cardBusyActionId?: string;
  confirmAction: (actionId: string, trigger: HTMLButtonElement) => void;
  cancelAction: (actionId: string) => void;
  openActionWorkspace: (card: AssistantActionCard) => void;
  pinAnswer: (turnId: string, answer: EvidenceExplanation, trigger: HTMLButtonElement) => void;
  canPinAnswer: (answer: EvidenceExplanation) => boolean;
  turns: ChatTurn[];
  runIds: readonly string[];
  pending: boolean;
  visible: boolean;
  draft: string;
  changeDraft: (draft: string) => void;
  send: (returnFocus?: HTMLTextAreaElement) => void;
  propose: () => void;
  /** Explicit opt-in AI planning; one invocation sends at most one request. */
  planWithAi: () => void;
  planning: boolean;
  apply: (question: string, filters: NonNullable<RunSearchRequest["filters"]>) => void;
  inspect: InspectSource;
  cancel: () => void;
  retry: (turn: ChatTurn) => void;
  clear: (keepDraft: boolean) => void;
  checkAvailability: () => void;
  openAnswerBrief: (turnId: string, trigger: HTMLButtonElement) => void;
  canReviewAnswer: (answer: EvidenceExplanation) => boolean;
  canDownloadAnswer: (answer: EvidenceExplanation) => boolean;
  downloadAnswer: (answer: EvidenceExplanation) => Promise<void>;
  openComparison: () => void;
  recordedExample?: RecordedExample;
  showRecordedExample: (example: RecordedExample | undefined) => void;
  datasetSha256?: string;
};

function ProposedFilters({ proposal, apply }: { proposal: EvidenceFilterProposal; apply: Props["apply"] }) {
  const [selected, setSelected] = useState(() => proposal.filters.map(() => true));
  return <div>
    <h3>Review suggested filters</h3>
    {proposal.filters.length === 0 ? <p>No filters were suggested for this question.</p> : <form onSubmit={event => {
      event.preventDefault();
      apply(proposal.question, proposal.filters.filter((_, index) => selected[index]));
    }}>
      {proposal.filters.map(({ key, value }, index) => <label className="proposal-choice" key={key}>
        <input type="checkbox" checked={selected[index]} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => current.map((item, position) => position === index ? checked : item));
        }} /> {describeProposedFilter({ key, value })}
      </label>)}
      <button className="button" disabled={!selected.some(Boolean)} type="submit">Apply selected filters</button>
    </form>}
  </div>;
}

export function explanationLabel(explanation: EvidenceExplanation["explanation"]) {
  if (explanation.provenance?.kind === "deterministic-evidence") return "Evidence-only fallback";
  return explanation.model ? "DeepSeek explanation" : "Evidence explanation";
}

export function answerSources(result: EvidenceExplanation, forRun?: string) {
  const sources = new Map<string, { runId: string; fieldKey: string; locator: string }>();
  for (const claim of result.explanation.claims) {
    const targets = claim.citationTargets ?? claim.citationIds.flatMap(citationId =>
      (result.citations[citationId]?.sources ?? []).map(({ runId }) => ({ citationId, runId })));
    for (const { citationId, runId } of targets) {
      if (forRun && runId !== forRun) continue;
      const citation = result.citations[citationId];
      const source = citation?.sources.find(item => item.runId === runId);
      if (source) sources.set(JSON.stringify([runId, citation.fieldKey, source.sourceId, source.locator]), {
        runId, fieldKey: citation.fieldKey, locator: source.locator,
      });
    }
  }
  return [...sources].map(([key, source]) => ({ key, ...source }));
}

function SourceChoices({ sources, inspect, chooser = false }: {
  sources: ReturnType<typeof answerSources>; inspect: InspectSource; chooser?: boolean;
}) {
  return <div className="chat-sources" role="group" aria-label={chooser ? "Choose a source from the answer" : "Sources for this answer"}>
    {sources.map(({ key, runId, fieldKey, locator }) => {
      const field = fieldKey.replaceAll("_", " ");
      const cell = coordinates(locator)?.cell;
      return <button className={chooser ? "button" : "citation"} type="button" key={key}
        aria-label={`Inspect ${runId} ${field} source${cell ? `, cell ${cell}` : ""}`}
        onClick={event => inspect(runId, fieldKey, event.currentTarget)}>
        {runId} · {chooser ? `${field}${cell ? ` · ${cell}` : ""}` : cell ?? "Source"} <Icon name="link" />
      </button>;
    })}
  </div>;
}

function Explanation({ result, inspect, canInspect }: { result: EvidenceExplanation; inspect: InspectSource; canInspect: boolean }) {
  const sources = answerSources(result);
  return <>
    <p className="muted">{explanationLabel(result.explanation)} · {result.runIds.join(", ")}</p>
    {result.explanation.withheldClaims !== undefined && <p className="notice" role="status">
      Some claims did not pass evidence checks and were withheld.
    </p>}
    {result.explanation.claims.map((claim, index) => <article className="claim" key={index}>
      <h3>{claimLabels[claim.status]}</h3><p>{claim.text}</p>
      {claim.measurements.length > 0 && <ul>{claim.measurements.map(({ label, value, unit, citationId }, index) => <li key={`${citationId}-${index}`}>{label}: {formatEvidenceValue(value)} {unit}</li>)}</ul>}
    </article>)}
    {sources.length > 0 && !canInspect && <p className="muted">Sources are available when this answer’s dataset revision is verified.</p>}
    {sources.length > 0 && canInspect && <SourceChoices sources={sources} inspect={inspect} />}
    {result.packet.limitations?.length ? <details><summary>Evidence limits</summary><ul>{result.packet.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details> : null}
  </>;
}

function ConversationTurn({ turn, props }: { turn: ChatTurn; props: Props }) {
  const response = turn.response;
  const actionAnswerId = turn.action?.answerTurnId;
  const actionResponse = actionAnswerId && props.turns.find(item => item.id === actionAnswerId)?.response;
  const actionAnswer = actionResponse && actionResponse.kind === "explanation"
    && actionResponse.result.datasetSha256 === props.datasetSha256 ? actionResponse.result : undefined;
  const canReview = response?.kind === "explanation" && props.canReviewAnswer(response.result);
  const canDownload = response?.kind === "explanation" && props.canDownloadAnswer(response.result);
  const canPin = response?.kind === "explanation" && props.canPinAnswer(response.result);
  const card = turn.cardActionId ? props.cards.find(item => item.actionId === turn.cardActionId) : undefined;
  const copyText = response?.kind === "explanation"
    ? response.result.explanation.claims.map(claim => [claim.text, ...claim.measurements.map(
      ({ label, value, unit }) => `${label}: ${formatEvidenceValue(value)} ${unit}`.trim(),
    )].join("\n")).join("\n\n")
    : response?.kind === "conversation" || response?.kind === "clarification" ? response.reply : "";
  const [copyStatus, setCopyStatus] = useState("");
  const [downloadStatus, setDownloadStatus] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyStatus("Answer copied.");
    } catch {
      setCopyStatus("Copy unavailable. Select the answer text to copy it.");
    }
  }
  async function downloadAnswer() {
    if (response?.kind !== "explanation" || downloading) return;
    setDownloading(true);
    setDownloadStatus("");
    setDownloadError("");
    try {
      await props.downloadAnswer(response.result);
      setDownloadStatus("Answer download prepared.");
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The answer could not be downloaded.");
    } finally {
      setDownloading(false);
    }
  }
  return <li className="chat-turn">
    <p className="user-message chat-text"><span className="sr-only">You. </span>{turn.question}</p>
    <div className={response?.kind === "explanation" ? "chat-reply chat-evidence" : "chat-reply"}>
      <span className="sr-only">Assistant. </span>
      {turn.status === "pending" && <div className="notice">
        <p role="status">{turn.mode === "proposal" ? "Preparing filter suggestions…"
          : turn.planning ? "Planning one read-only action with DeepSeek…" : "Preparing a reply…"}</p>
        <button className="button" type="button" onClick={props.cancel}>Stop</button>
      </div>}
      {(turn.status === "failed" || turn.status === "stopped") && <div className="notice">
        <p role={turn.status === "failed" ? "alert" : "status"}>{turn.error ?? "Request stopped."}</p>
        {!turn.planning && <button className="button" type="button" disabled={props.pending} onClick={() => props.retry(turn)}>Retry</button>}
        {turn.planning && <span className="muted">Use Plan with AI again if you want another proposal. Manual Send is unchanged.</span>}
      </div>}
      {response?.kind === "explanation" && <Explanation result={response.result} inspect={props.inspect}
        canInspect={props.datasetSha256 === response.result.datasetSha256} />}
      {response?.kind === "proposal" && <>
        {response.reply && <p className="chat-text">{response.reply}</p>}
        <ProposedFilters proposal={response.result} apply={props.apply} />
      </>}
      {(response?.kind === "conversation" || response?.kind === "clarification") && <>
        <p className="chat-text">{response.reply}</p>
        {response.kind === "conversation" && response.model && <small className="muted">DeepSeek conversation</small>}
      </>}
      {turn.action?.kind === "source" && actionAnswer && <SourceChoices sources={answerSources(actionAnswer, turn.action.runId)} inspect={props.inspect} chooser />}
      {turn.action?.kind === "brief" && actionAnswer && actionAnswerId && <button className="button" type="button"
        onClick={event => props.openAnswerBrief(actionAnswerId, event.currentTarget)}>Review brief</button>}
      {card && turn.cardOrigin === "ai" && <p className="muted">
        AI-planned read-only proposal · validated against this corpus, workspace and ordered selection. It is not applied until you confirm; reviewing the card or its sources makes no further AI request.
      </p>}
      {card && <AssistantActionCardView card={card} busy={props.cardBusyActionId === card.actionId}
        dataset={props.dataset} inspect={props.inspect} onConfirm={props.confirmAction}
        onCancel={props.cancelAction} onOpenWorkspace={props.openActionWorkspace} />}
      {((copyText && !turn.action) || canReview || canDownload || canPin) && <div className="card-actions">
        {copyText && !turn.action && <button className="button" type="button" onClick={() => void copy()}>Copy answer</button>}
        {canReview && <button className="button" type="button" onClick={event => props.openAnswerBrief(turn.id, event.currentTarget)}>Prepare brief</button>}
        {canPin && response?.kind === "explanation" && <button className="button" type="button"
          onClick={event => props.pinAnswer(turn.id, response.result, event.currentTarget)}>Review &amp; pin answer</button>}
        {canDownload && <button className="button" type="button" disabled={downloading} onClick={() => void downloadAnswer()}>
          {downloading ? "Preparing download…" : "Download answer (JSON)"}
        </button>}
      </div>}
      {downloadError && <p role="alert">{downloadError}</p>}
      {downloadStatus && <p role="status">{downloadStatus}</p>}
      {copyStatus && <p role="status">{copyStatus}</p>}
    </div>
  </li>;
}

function RecordedExamples({ recordedExample, showRecordedExample, datasetSha256, inspect }: Pick<Props,
  "recordedExample" | "showRecordedExample" | "datasetSha256" | "inspect">) {
  if (!recordedExamples.length) return null;
  const examples = recordedExamples.filter(example => example.datasetSha256 === datasetSha256);
  if (!examples.length) return <div className="notice">
    <p>{datasetSha256
      ? "Recorded examples are unavailable for this dataset revision."
      : "Recorded examples will be available once the dataset version can be verified."}</p>
  </div>;
  const active = recordedExample && examples.includes(recordedExample) ? recordedExample : undefined;
  return <div className="notice">
    <div className="card-actions">{examples.map(example => <button className="button" type="button"
      key={example.id} aria-expanded={active === example}
      onClick={() => showRecordedExample(active === example ? undefined : example)}>{example.runIds.join(" and ")}</button>)}</div>
    {active && <>
      <h3>Recorded DeepSeek example</h3>
      <p className="muted">{active.runIds.join(" · ")}<br />{active.model.returned ?? active.model.requested}</p>
      <p className="user-message">{active.question}</p>
      {active.claims.map((claim, index) => <article className="claim" key={index}>
        <strong>{claimLabels[claim.status]}</strong><p>{claim.text}</p>
        {claim.measurements.length > 0 && <ul>{claim.measurements.map(({ label, value, unit }, index) =>
          <li key={index}>{label}: {value} {unit}</li>)}</ul>}
        {[...new Map(claim.anchors.map(source => [`${source.runId}-${source.fieldKey}`, source])).values()].map(source => <button className="citation" type="button" key={`${source.runId}-${source.fieldKey}`}
          aria-label={`Inspect recorded example source for ${source.runId} ${source.fieldKey}`}
          onClick={event => inspect(source.runId, source.fieldKey, event.currentTarget)}>
          {source.runId} · {coordinates(source.locator)?.cell ?? "Source"} <Icon name="link" />
        </button>)}
      </article>)}
    </>}
  </div>;
}

export function Assistant(props: Props) {
  const composing = useRef(false);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const ready = !props.pending && Boolean(props.draft.trim());
  function latest() {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }
  useEffect(() => {
    if (props.visible && followLatest.current) latest();
  }, [props.turns, props.visible]);
  function reset(keepDraft: boolean) {
    props.clear(keepDraft);
    followLatest.current = true;
    composer.current?.focus();
  }
  return <section className="assistant" aria-labelledby="assistant-title">
    <header className="assistant-head"><Icon name="menu" /><h2 id="assistant-title">Evidence assistant</h2>
      <button className="button" type="button" onClick={() => reset(false)}>New chat</button>
    </header>
    <div className="assistant-body" ref={thread} onScroll={event => {
      const body = event.currentTarget;
      followLatest.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    }}>
      {!props.enabled && <div className="notice"><p>DeepSeek is unavailable. Manual Send still handles local plot, comparison, comparator and notebook intents, and prepared investigations remain available. Filter suggestions and AI action planning require DeepSeek.</p>
          <div className="card-actions"><button className="button" onClick={props.checkAvailability}>Check availability</button>
            <button className="button" onClick={props.openComparison}>View recorded evidence</button></div>
        </div>}
      {!props.turns.length && <p className="chat-text">Ask me about the FLEX collection or the runs you’re looking at.</p>}
      <ol className="chat-turns" aria-label="Conversation" aria-live="polite">
        {props.turns.map(turn => <ConversationTurn key={turn.id} turn={turn} props={props} />)}
      </ol>
      <details className="chat-examples" open={props.recordedExample ? true : undefined}>
        <summary>Recorded DeepSeek examples</summary>
        <RecordedExamples recordedExample={props.recordedExample} showRecordedExample={props.showRecordedExample}
          datasetSha256={props.datasetSha256} inspect={props.inspect} />
      </details>
    </div>
    <form className="composer" onSubmit={event => {
      event.preventDefault();
      if (ready && !composing.current) { followLatest.current = true; props.send(composer.current ?? undefined); }
    }}>
      <p className="muted chat-context">{props.runIds.length ? `Active context: ${props.runIds.join(", ")}` : "Active context: no runs selected"}</p>
      <span className="sr-only">Chat history stays in this tab.</span>
      <textarea ref={composer} aria-label="Question about the evidence" aria-describedby="composer-keys"
        placeholder="Ask about selected evidence…" maxLength={500} value={props.draft}
        onChange={event => props.changeDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== "Enter" || event.shiftKey || composing.current
              || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat && ready) event.currentTarget.form?.requestSubmit();
        }} />
      <span id="composer-keys" className="sr-only">Enter sends the question. Shift+Enter inserts a new line.</span>
      <div className="composer-actions">
        <button className="button" type="button" disabled={!ready || !props.enabled}
          onClick={() => { if (!composing.current) { followLatest.current = true; props.propose(); } }}>Suggest filters</button>
        <button className="button" type="submit" disabled={!ready}>Send <Icon name="arrow" /></button>
      </div>
      <div className="composer-actions">
        <button className="button" type="button" disabled={!ready || !props.enabled || props.planning}
          aria-describedby="ai-plan-note"
          onClick={() => { if (!composing.current) { followLatest.current = true; props.planWithAi(); } }}>
          {props.planning ? "Planning…" : "Plan with AI"}
        </button>
      </div>
      <p id="ai-plan-note" className="muted">{props.enabled
        ? "One explicit provider request proposes a read-only action. Nothing runs or saves until you confirm."
        : "AI planning is unavailable. Normal Send and local intents still work."}</p>
      {props.turns.length > 0 && <div className="composer-actions">
        <button className="button" type="button" onClick={() => reset(true)}>Clear conversation</button>
        <button className="button" type="button" onClick={() => { followLatest.current = true; latest(); }}>Latest reply</button>
      </div>}
    </form>
  </section>;
}
