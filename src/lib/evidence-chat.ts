import { z } from "zod";
import type { ConversationTurn, DeepSeekExplanation, EvidenceFollowUp } from "./deepseek.ts";
import type { ComparisonResult, Dataset } from "./evidence.ts";
import type { buildExplanationPacket } from "./evidence-packet.ts";

const canonicalRunId = /^FLEX-[0-9]{3}$/;
const runId = z.string().regex(canonicalRunId);
const scopeIds = z.array(runId).max(3)
  .refine((ids) => new Set(ids).size === ids.length, "Use distinct run IDs");
const turnText = z.string().trim().min(1).max(500);
export const chatRequestSchema = z.strictObject({
  action: z.literal("chat"),
  ai: z.literal(true),
  question: turnText,
  runIds: scopeIds.optional(),
  historyRunIds: scopeIds.optional(),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: turnText })).max(8)
    .refine((turns) => turns.reduce((size, turn) => size + turn.content.length, 0) <= 2000,
      "Keep chat history within 2000 characters").optional(),
});

type ChatRequest = z.infer<typeof chatRequestSchema>;
type Reply = { kind: "conversation"; reply: string } | { kind: "clarification"; reply: string };
type Dispatch =
  | Reply
  | { kind: "dialogue"; question: string; history: ConversationTurn[]; background: boolean }
  | { kind: "proposal"; question: string }
  | { kind: "explanation"; question: string; runIds: string[]; burnTime?: "order" | "reason"; followUp?: EvidenceFollowUp };

const greeting = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))(?: there)?[.!?\s]*$/i;
const smallTalk = /^(?:how are you|how's it going|(?:thanks|thank you)(?: for (?:the|your) help)?)[.!?\s]*$/i;
const help = /^(?:help(?: me)?|what can you do|how (?:do I|can I) use (?:this|the) (?:app|explorer|workbench)|how does (?:this|the) (?:app|explorer|workbench) work)[.!?\s]*$/i;
const coverage = /^(?:how many (?:reviewed )?(?:runs|tests)(?: (?:are there|do you have|are in (?:this|the) (?:dataset|collection)))?|what (?:is|does) (?:in )?(?:this|the) (?:dataset|collection)(?: cover)?)[.!?\s]*$/i;
const discovery = /^(?:find|search(?: for)?|show(?: me)?|list|filter(?: for)?)\b.*\b(?:runs|tests|filters|collection)\b|\b(?:suggest|propose)\s+filters\b/i;
const compare = /\b(?:compare|comparison|difference between|how (?:do|did) (?:these|those|they) differ|which (?:one |run )?(?:had|has|was|is)|which of (?:these|those))\b/i;
const bareFollowUp = /^(?:why|how so|what about (?:it|that|them)|tell me more|can you explain (?:that|it)|compare (?:them|these(?: two)?|those(?: two)?))[.!?\s]*$/i;
const topicFollowUp = /^(?:what about|how about|and)\s+\S/i;
const interpretation = /^(?:why\b|how so\b|what (?:does|do|can) (?:it|this|that|these|those|we) (?:mean|tell|show|learn|conclude|infer)\b|what should I take away\b)/i;
const reformulation = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:(?:rephrase|reword|restate|summarize|simplify)\b|(?:put|say|explain) (?:it|that|this)\b|make (?:it|that|this|your (?:last )?answer) (?:shorter|simpler|clearer)\b|(?:give me |a )?(?:a )?(?:shorter|simpler|clearer) version\b)/i;
const singularReference = /\b(?:its|(?:this|that) (?:run|test))\b/i;
const pluralReference = /\b(?:their|(?:these|those) (?:runs|tests))\b/i;
const evidenceTerms = /\b(?:recorded|reported|selected (?:runs|tests)|(?:this|that) (?:run|test)|(?:these|those) (?:runs|tests|records|results|measurements)|burn(?:ing)? (?:time|rate|duration)|extinction|diameter|mole fraction|pressure|fuel|oxygen)\b/i;
const scopedEvidence = /\b(?:recorded|reported|selected|in the (?:dataset|collection)|(?:these|those|this|that) (?:runs?|tests?|records?|results|measurements))\b/i;
const generalBackground = /^(?:in general\b|define\b|what (?:is|are|does)\b|(?:why|how) (?:do|does)\b|explain (?:the concept of|how)\b)/i;
const conceptualBackground = /^(?:in general\b|define\b|(?:why|how) (?:do|does)\b|explain (?:the concept of|how)\b)/i;
const appGuidance = /^(?:how (?:do|can|should) I|(?:can|could) you (?:help|walk|guide) me|where (?:do|can) I)\b.*\b(?:use|choose|find|search|browse|filter|compare|inspect|open|export|download|prepare|save|workbench|explorer|app)\b/i;
const sourceAction = /^(?:show(?: me)?|open|inspect|where is) (?:the |a )?(?:source|citation)[.!?\s]*$/i;
const briefAction = /^(?:prepare|make|build|export) (?:an? |the )?(?:evidence )?brief[.!?\s]*$/i;
const burnTimeOrder = /^which (?:(?:run|test|one) )?(?:had|has) (?:the )?longer burn(?:ing)? (?:time|duration)[.!?\s]*$/i;

function mentionedRuns(question: string) {
  const ids = question.matchAll(/(?<![\p{L}\p{M}\p{N}\p{Pd}_−])FLEX-[0-9]+(?![\p{L}\p{M}\p{N}\p{Pd}_−])/giu);
  return [...new Set(Array.from(ids, ([id]) => id.toUpperCase()))];
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function followUpIntent(text: string): EvidenceFollowUp | undefined {
  if (reformulation.test(text)) return "rephrase";
  if (interpretation.test(text)) return "interpret";
  if (bareFollowUp.test(text) || topicFollowUp.test(text)
    || singularReference.test(text) || pluralReference.test(text)) return "continue";
}

function isBackground(text: string, hasWorkspace: boolean) {
  return generalBackground.test(text) && !mentionedRuns(text).length && !scopedEvidence.test(text)
    && !compare.test(text) && !appGuidance.test(text) && !singularReference.test(text)
    && (!hasWorkspace || !evidenceTerms.test(text) || conceptualBackground.test(text));
}

function previousTopic(userTurns: string[], hasWorkspace: boolean) {
  const index = userTurns.findLastIndex((text) => !greeting.test(text) && !smallTalk.test(text)
    && !sourceAction.test(text) && !briefAction.test(text)
    && (!followUpIntent(text) || mentionedRuns(text).length > 0
      || evidenceTerms.test(text) || isBackground(text, hasWorkspace)));
  if (index < 0) return;
  const question = userTurns[index];
  const background = isBackground(question, hasWorkspace);
  const evidence = !background && !appGuidance.test(question) && !discovery.test(question)
    && (mentionedRuns(question).length > 0 || compare.test(question) || evidenceTerms.test(question));
  let ids = evidence ? mentionedRuns(question) : [];
  // Carry the explicit run through chained references within the active evidence topic.
  for (let cursor = index; evidence && !ids.length && cursor > 0 && followUpIntent(userTurns[cursor]); cursor--) {
    const earlier = userTurns[cursor - 1];
    if (greeting.test(earlier) || smallTalk.test(earlier) || appGuidance.test(earlier)
      || discovery.test(earlier) || isBackground(earlier, hasWorkspace)) break;
    ids = mentionedRuns(earlier);
  }
  return { question, background, evidence, ids };
}

export function resolveEvidenceChat(input: ChatRequest, dataset: Dataset): Dispatch {
  const { question, runIds = [], history = [], historyRunIds } = input;
  const clarify = (reply: string): Reply => ({ kind: "clarification", reply });
  const say = (reply: string): Reply => ({ kind: "conversation", reply });
  const dialogue = (background = false): Dispatch => ({ kind: "dialogue", question, history, background });
  if (greeting.test(question)) {
    return say("Hi! I can help you find reviewed NASA FLEX runs, compare what they recorded, or find the source for an evidence claim.");
  }
  if (/^(?:how are you|how's it going)[.!?\s]*$/i.test(question)) {
    return say("I’m here to help you explore the FLEX collection. What would you like to look at?");
  }
  if (/^(?:thanks|thank you)(?: for (?:the|your) help)?[.!?\s]*$/i.test(question)) {
    return say("You’re welcome. Ask another question whenever you’re ready.");
  }
  if (help.test(question)) {
    return say("Ask me to find reviewed FLEX runs or explain the recorded evidence. Name a run or choose runs in the explorer. Comparisons use two or three runs. You can open citations and include a validated answer in an evidence brief.");
  }
  if (coverage.test(question)) {
    return say(`This workbench covers ${dataset.runs.length} reviewed NASA FLEX runs. It draws its run findings from this curated collection.`);
  }
  if (sourceAction.test(question)) {
    return say("Open a citation on the evidence answer to inspect its exact source location. If you have a field in mind, name it and the run.");
  }
  if (briefAction.test(question)) {
    return say("Use the evidence answer’s brief control to review the selected runs and export the validated explanation with its citations.");
  }
  if (appGuidance.test(question)) return dialogue();
  if (discovery.test(question)) return { kind: "proposal", question };

  const explicit = mentionedRuns(question);
  const knownIds = new Set(dataset.runs.map(({ id }) => id));
  if ([...runIds, ...explicit].some((id) => !knownIds.has(id))) {
    return clarify("A run ID in this request is outside the reviewed FLEX collection. Choose an available run in the explorer.");
  }
  if (explicit.length > 3) return clarify("Choose up to three reviewed runs for this evidence question.");

  const userTurns = history.filter(({ role }) => role === "user").map(({ content }) => content);
  const previous = previousTopic(userTurns, Boolean((historyRunIds ?? runIds).length));
  const intent = followUpIntent(question);
  const wantsComparison = compare.test(question);
  if (isBackground(question, Boolean(runIds.length)) && (!intent || conceptualBackground.test(question))) {
    return dialogue(true);
  }
  if (intent && previous && !previous.evidence && !explicit.length && !wantsComparison && !scopedEvidence.test(question)) {
    return dialogue(previous.background);
  }
  const contextual = Boolean(intent && previous?.evidence && !explicit.length);
  const unchangedWorkspace = historyRunIds !== undefined && sameOrder(historyRunIds, runIds);
  if (contextual && historyRunIds && !unchangedWorkspace) {
    return clarify("The selected runs changed since the earlier question. Which runs should this follow-up use?");
  }
  const previousIds = contextual ? previous?.ids ?? [] : [];
  if (!explicit.length && previousIds.length && runIds.length
    && !unchangedWorkspace && !sameOrder(previousIds, runIds)) {
    return clarify("The earlier question and current selection refer to different runs. Name the runs for this follow-up.");
  }
  const selected = explicit.length ? explicit
    : unchangedWorkspace && previousIds.length ? previousIds
    : runIds.length ? runIds : previousIds;
  if (selected.length > 3 || selected.some((id) => !knownIds.has(id))) {
    return clarify("Choose up to three available reviewed FLEX runs for this evidence question.");
  }
  if (!explicit.length && singularReference.test(question) && selected.length !== 1) {
    return clarify("Which run do you mean? Name one reviewed FLEX run for this question.");
  }

  const needsPair = wantsComparison || (contextual && !singularReference.test(question)
    && previous !== undefined && compare.test(previous.question));
  if (needsPair && selected.length < 2) return clarify("Which runs should I compare? Select or name two or three reviewed FLEX runs.");
  if (intent && !previous && !explicit.length && !wantsComparison && !evidenceTerms.test(question)) {
    return clarify("Which earlier evidence question should I follow up on? You can restate it or name the runs.");
  }
  if (explicit.length || wantsComparison || evidenceTerms.test(question) || contextual) {
    if (!selected.length) return clarify("Which reviewed FLEX run should I use? Name a run or select it in the explorer.");
    const priorQuestion = contextual ? previous?.question : undefined;
    const resolved = priorQuestion ? `Earlier evidence question: ${priorQuestion}\nFollow-up: ${question}` : question;
    if (resolved.length > 500) return clarify("The follow-up context is too long. Restate the evidence question in a shorter message.");
    return {
      kind: "explanation", question: resolved, runIds: selected,
      followUp: contextual ? intent : undefined,
      burnTime: burnTimeOrder.test(question) ? "order"
        : priorQuestion && /^(?:why|how so)[.!?\s]*$/i.test(question) && burnTimeOrder.test(priorQuestion) ? "reason"
        : undefined,
    };
  }
  return dialogue(isBackground(question, Boolean(runIds.length)));
}

type Context = ReturnType<typeof buildExplanationPacket>;

/** Resolve a common ordered comparison from the selected fields, with unknowns kept explicit. */
export function explainRecordedBurnTime(
  comparison: ComparisonResult, context: Context, mode: "order" | "reason",
): DeepSeekExplanation | null {
  const row = comparison.rows.find(({ key }) => key === "burn_time");
  const entry = Object.entries(context.citations).find(([id, citation]) =>
    id.startsWith("field:") && citation.fieldKey === "burn_time");
  if (!row || !entry || row.status === "incompatible") return null;
  const [citationId, citation] = entry;
  if (!context.packet.evidence.some(({ id }) => id === citationId)
    || row.cells.some(({ runId, field, source }) => !field || source?.id !== field.sourceId
      || (field.value !== null && (typeof field.value !== "number" || field.unit !== "s"))
      || !citation.sources.some((anchor) => anchor.runId === runId
        && anchor.sourceId === field.sourceId && anchor.locator === field.locator))) return null;
  const measurements = row.cells.flatMap(({ runId, field }) => typeof field?.value === "number"
    ? [{ citationId, label: `Burn time (${runId})`, value: field.value, unit: "s" }] : []);
  const missing = row.cells.filter(({ field }) => field?.value === null).map(({ runId }) => runId);
  const longest = Math.max(...measurements.map(({ value }) => value));
  const longestRuns = row.cells.filter(({ field }) => field?.value === longest).map(({ runId }) => runId);
  const text = missing.length
    ? `Burn time is unreported for ${missing.join(", ")}. The recorded durations are insufficient to identify the longest burn time across this selection.`
    : longestRuns.length === measurements.length
      ? "The selected runs have the same recorded burn time."
      : `${longestRuns.join(" and ")} ${longestRuns.length === 1 ? "has" : "share"} the longest recorded burn time.`;
  const reason = missing.length
    ? `Ranking the full selection requires a reported duration for each run. The source leaves the burn-time field blank for ${missing.join(", ")}.`
    : longestRuns.length === measurements.length
      ? "The cited durations match in seconds, so the recorded burn times tie."
      : `The cited durations share the same unit, seconds. The duration recorded for ${longestRuns.join(" and ")} is greater than the other recorded duration${measurements.length > 2 ? "s" : ""}.`;
  const status = missing.length ? "insufficient" : "supported";
  return {
    status, scope: context.packet.scope, model: null,
    provenance: { kind: "deterministic-evidence", ruleVersion: "recorded-burn-time-1" },
    claims: [{
      text: `${mode === "reason" ? reason : text} The comparison cannot establish a cause for differences in burning duration.`,
      scope: context.packet.scope, status: missing.length ? "insufficient" : "reported",
      citationIds: [citationId],
      citationTargets: row.cells.map(({ runId }) => ({ citationId, runId })),
      measurements,
    }],
  };
}
