import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDataset } from "../src/lib/evidence.ts";
import { buildSelectedRunsContext, searchComparators } from "../src/lib/upgrades/comparison-engine.ts";
import {
  buildComparisonExportPayload,
  buildComparisonLimitationCards,
  buildComparisonPresentation,
  buildComparisonUnavailablePresentation,
  comparisonExportJson,
  comparisonExportPayloadSchema,
  comparisonExportSignatureNote,
  comparisonPresentationSchema,
  comparisonPresentationUnionSchema,
  ComparisonPresentationError,
  validateComparisonPresentationInput,
} from "../src/lib/upgrades/comparison-presentation.ts";
import {
  gasCompositionLimitations,
  resolveStableFieldReference,
} from "../src/lib/upgrades/index.ts";

const dataset = parseDataset(JSON.parse(
  await readFile(new URL("../data/flex.json", import.meta.url), "utf8"),
));
const sourceId = "psi-69-flex-table-v1";

const selectedRequest = (runIds) => ({
  version: "comparison-context-request-1",
  kind: "selected-runs",
  runIds,
});

const comparatorRequest = (overrides = {}) => ({
  version: "comparison-context-request-1",
  kind: "comparator",
  referenceRunId: "FLEX-001",
  focusCondition: "diameter",
  candidateScope: { kind: "explicit-runs", runIds: ["FLEX-004"] },
  ...overrides,
});

const reference = (runId, fieldKey) => ({ datasetVersion: dataset.version, runId, fieldKey, sourceId });

function allCards(presentation) {
  return [
    ...presentation.globalCards,
    ...presentation.contexts.flatMap(({ cards }) => cards),
  ];
}

function findCard(presentation, predicate) {
  return allCards(presentation).find(predicate);
}

test("FLEX-001 → FLEX-004 cards expose the +3.34 s difference, unknown extinction and full gas group", () => {
  const context = buildSelectedRunsContext(dataset, selectedRequest(["FLEX-001", "FLEX-004"]));
  const presentation = buildComparisonPresentation(dataset, context);
  assert.doesNotThrow(() => comparisonPresentationSchema.parse(presentation));
  assert.doesNotThrow(() => comparisonPresentationUnionSchema.parse(presentation));

  assert.equal(presentation.status, "available");
  assert.equal(presentation.presentationVersion, "comparison-presentation-1");
  assert.equal(presentation.resultKind, "selected-runs-context");
  assert.equal(presentation.datasetVersion, dataset.version);
  assert.equal(presentation.comparisonRuleVersion, "1");
  assert.equal(presentation.contextRuleVersion, "comparison-context-1");
  assert.deepEqual(presentation.request, selectedRequest(["FLEX-001", "FLEX-004"]));
  assert.deepEqual(presentation.roles, {
    mode: "selected-runs",
    referenceRunId: null,
    inspectedRunIds: ["FLEX-001", "FLEX-004"],
    focusCondition: null,
  });
  assert.equal(presentation.matching, null);
  assert.deepEqual(presentation.requiredMatchFieldKeys, []);
  assert.equal(presentation.searchState, "not-applicable");
  assert.equal(presentation.coverage, null);
  assert.deepEqual(presentation.globalCards, []);
  assert.equal(presentation.contexts.length, 1);

  const [contextPresentation] = presentation.contexts;
  assert.equal(contextPresentation.role, "selected-runs");
  assert.equal(contextPresentation.disposition, null);
  assert.equal(contextPresentation.candidate, null);
  assert.deepEqual(contextPresentation.runIds, ["FLEX-001", "FLEX-004"]);
  assert.deepEqual(contextPresentation.conditions.map(({ key }) => key), [
    "fuel", "pressure", "oxygen", "nitrogen", "carbon_dioxide", "helium", "diameter",
  ]);
  assert.deepEqual(contextPresentation.outcomes.map(({ key }) => key), [
    "extinction_diameter", "burning_rate", "burn_time", "test_end",
  ]);
  assert.deepEqual(contextPresentation.contextLimitations, context.limitations);

  const burnTime = findCard(presentation, (card) => card.fieldKeys.includes("burn_time"));
  assert.ok(burnTime);
  assert.equal(burnTime.kind, "recorded-difference");
  assert.equal(burnTime.severity, "information");
  assert.match(burnTime.title, /Burn time/);
  assert.match(burnTime.text, /FLEX-001 4\.3 s/);
  assert.match(burnTime.text, /FLEX-004 7\.64 s/);
  assert.match(burnTime.text, /\+3\.34 s/);
  assert.match(burnTime.text, /FLEX-004 minus FLEX-001/);
  assert.deepEqual(burnTime.deltas, context.outcomes.find(({ key }) => key === "burn_time").deltas);
  assert.deepEqual(burnTime.sourceReferences, [
    reference("FLEX-001", "burn_time"),
    reference("FLEX-004", "burn_time"),
  ]);

  const extinction = findCard(presentation, (card) => card.fieldKeys.includes("extinction_diameter"));
  assert.ok(extinction);
  assert.equal(extinction.kind, "missing-measurement");
  assert.equal(extinction.severity, "caution");
  assert.match(extinction.text, /FLEX-004/);
  assert.match(extinction.text, /unknown/i);
  assert.match(extinction.text, /never counts as a match/);
  assert.deepEqual(extinction.deltas, []);
  assert.deepEqual(extinction.sourceReferences, [
    reference("FLEX-001", "extinction_diameter"),
    reference("FLEX-004", "extinction_diameter"),
  ]);

  const gas = findCard(presentation, (card) => card.kind === "gas-composition");
  assert.ok(gas);
  assert.equal(gas.severity, "not-established");
  assert.equal(gas.title, "Gas composition is linked");
  assert.equal(gas.text, context.gasComposition.limitation);
  assert.deepEqual(gas.fieldKeys, ["oxygen", "nitrogen", "carbon_dioxide", "helium"]);
  assert.deepEqual(gas.runIds, ["FLEX-001", "FLEX-004"]);
  assert.equal(gas.sourceReferences.length, 8);

  const extinctionLimit = findCard(presentation, (card) => card.kind === "extinction-estimate");
  assert.ok(extinctionLimit);
  assert.equal(extinctionLimit.severity, "not-established");
  const causality = findCard(presentation, (card) => card.kind === "causality");
  assert.ok(causality);
  assert.equal(causality.severity, "not-established");
  assert.match(causality.text, /cannot establish a causal conclusion/);

  assert.deepEqual(presentation.limitations, context.limitations);
  for (const card of allCards(presentation)) {
    for (const sourceReference of card.sourceReferences) {
      assert.equal(resolveStableFieldReference(dataset, sourceReference).status, "resolved");
    }
  }
  assert.equal(buildComparisonLimitationCards(dataset, context).length, allCards(presentation).length);

  const payload = buildComparisonExportPayload(dataset, context);
  assert.doesNotThrow(() => comparisonExportPayloadSchema.parse(payload));
  assert.equal(payload.format, "fire-evidence-comparison-export");
  assert.equal(payload.formatVersion, "comparison-export-1");
  assert.equal(payload.authority, "deterministic-comparison");
  assert.equal(payload.verification, "not-verified");
  assert.equal(payload.signed, false);
  assert.equal(payload.signatureNote, comparisonExportSignatureNote);
  assert.deepEqual(payload.request, presentation.request);
  assert.deepEqual(payload.presentation, presentation);
  assert.deepEqual(payload.presentation.contexts[0].conditions,
    contextPresentation.conditions);
  assert.deepEqual(payload.presentation.contexts[0].gasComposition,
    contextPresentation.gasComposition);

  const json = comparisonExportJson(payload);
  assert.deepEqual(JSON.parse(json), payload);
  assert.ok(json.endsWith("\n"));
});

test("presentation preserves run order and native delta direction when the request is reversed", () => {
  const context = buildSelectedRunsContext(dataset, selectedRequest(["FLEX-004", "FLEX-001"]));
  const presentation = buildComparisonPresentation(dataset, context);
  assert.deepEqual(presentation.roles.inspectedRunIds, ["FLEX-004", "FLEX-001"]);
  assert.deepEqual(presentation.contexts[0].runIds, ["FLEX-004", "FLEX-001"]);
  assert.deepEqual(presentation.contexts[0].cards
    .filter(({ fieldKeys }) => fieldKeys.includes("burn_time"))
    .map(({ text }) => text), [
    "Recorded values: FLEX-004 7.64 s; FLEX-001 4.3 s. Native deltas: FLEX-001 minus FLEX-004 = -3.34 s.",
  ]);
  assert.deepEqual(
    findCard(presentation, ({ fieldKeys }) => fieldKeys.includes("burn_time")).deltas,
    context.outcomes.find(({ key }) => key === "burn_time").deltas,
  );
});

test("tolerance presentation keeps the rule, eligible candidate and the recorded difference", () => {
  const comparator = searchComparators(dataset, comparatorRequest({
    matching: { mode: "tolerance", tolerances: [{ field: "pressure", tolerance: 2.3 }] },
  }));
  assert.equal(comparator.outcome.kind, "eligible-match");
  const presentation = buildComparisonPresentation(dataset, comparator);
  assert.doesNotThrow(() => comparisonPresentationSchema.parse(presentation));

  assert.equal(presentation.resultKind, "comparator-search");
  assert.equal(presentation.searchState, "eligible");
  assert.deepEqual(presentation.roles, {
    mode: "comparator",
    referenceRunId: "FLEX-001",
    inspectedRunIds: ["FLEX-004"],
    focusCondition: "diameter",
  });
  assert.deepEqual(presentation.matching, {
    mode: "tolerance",
    tolerances: [{
      field: "pressure",
      tolerance: 2.3,
      unit: "mmHg",
      label: "Ambient pressure",
    }],
  });
  assert.deepEqual(presentation.requiredMatchFieldKeys, [
    "fuel", "pressure", "oxygen", "nitrogen", "carbon_dioxide", "helium",
  ]);
  assert.deepEqual(presentation.coverage, {
    scopeKind: "explicit-runs",
    activeFilters: [],
    resolvedCandidateRunIds: ["FLEX-004"],
    evaluatedCount: 1,
    displayedCandidateRunIds: ["FLEX-004"],
    displayedCount: 1,
    notDisplayedCandidateRunIds: [],
    truncated: false,
    empty: false,
  });
  assert.equal(presentation.contexts.length, 1);
  const [candidateContext] = presentation.contexts;
  assert.equal(candidateContext.role, "eligible-candidate");
  assert.equal(candidateContext.disposition, "eligible");
  assert.deepEqual(candidateContext.runIds, ["FLEX-001", "FLEX-004"]);
  assert.equal(candidateContext.candidate.runId, "FLEX-004");
  assert.deepEqual(candidateContext.candidate.mismatchedFieldKeys, []);
  assert.deepEqual(candidateContext.candidateLimitations,
    comparator.outcome.candidates[0].limitations);

  const matchingCard = findCard(presentation, ({ kind }) => kind === "matching-rule");
  assert.ok(matchingCard);
  assert.deepEqual(matchingCard.matching, presentation.matching);
  assert.match(matchingCard.title, /inclusive tolerance/);
  assert.match(matchingCard.text, /matching tolerance is a search rule/);
  assert.match(matchingCard.text, /Ambient pressure ±2\.3 mmHg/);
  const outcomeCard = findCard(presentation, ({ kind }) => kind === "search-outcome");
  assert.ok(outcomeCard);
  assert.match(outcomeCard.text, /1 candidate satisfied the tolerance matching rule/);
  assert.deepEqual(outcomeCard.runIds, ["FLEX-004"]);

  // The tolerance decided eligibility but did not rewrite the recorded values.
  const candidateCards = presentation.contexts.flatMap(({ cards }) => cards);
  const pressureCard = candidateCards.find(({ fieldKeys }) => fieldKeys.includes("pressure"));
  assert.ok(pressureCard);
  assert.equal(pressureCard.kind, "recorded-difference");
  assert.match(pressureCard.text, /\+2\.3 mmHg/);
  const diameterCard = candidateCards.find(({ fieldKeys }) => fieldKeys.includes("diameter"));
  assert.ok(diameterCard);
  assert.match(diameterCard.text, /\+0\.37 mm/);

  const payload = buildComparisonExportPayload(dataset, comparator);
  assert.doesNotThrow(() => comparisonExportPayloadSchema.parse(payload));
  assert.deepEqual(payload.presentation.matching, presentation.matching);
  assert.deepEqual(payload.presentation.limitations, comparator.limitations);
  assert.match(comparisonExportJson(payload), /"tolerance": 2\.3/);

  // Exact eligibility is a distinct state: the same candidate cannot satisfy
  // the required pressure condition without the declared tolerance.
  const exactComparator = searchComparators(dataset, comparatorRequest());
  assert.equal(exactComparator.outcome.kind, "no-eligible-match");
  const exact = buildComparisonPresentation(dataset, exactComparator);
  assert.equal(exact.searchState, "no-eligible");
  assert.deepEqual(exact.matching, { mode: "exact", tolerances: [] });
  assert.equal(findCard(exact, ({ kind }) => kind === "matching-rule").title, "Matching rule: exact");
  assert.equal(findCard(exact, ({ kind }) => kind === "search-outcome").title, "No eligible match");
  assert.equal(findCard(exact, ({ kind }) => kind === "nearest-ineligible").disposition, "nearest");
});

test("nearest, coverage, empty and unavailable states remain distinct", () => {
  const exact = searchComparators(dataset, comparatorRequest({
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-002", "FLEX-005"] },
  }));
  const nearest = buildComparisonPresentation(dataset, exact);
  assert.equal(nearest.searchState, "no-eligible");
  assert.equal(nearest.contexts.length, 2);
  assert.deepEqual(nearest.contexts.map(({ disposition }) => disposition), ["nearest", "nearest"]);
  assert.deepEqual(nearest.contexts.map(({ candidate }) => candidate.runId), ["FLEX-005", "FLEX-002"]);
  assert.deepEqual(nearest.contexts.map(({ candidate }) => candidate.mismatchedFieldKeys), [
    ["pressure"], ["pressure"],
  ]);
  const nearestCards = nearest.globalCards.filter(({ kind }) => kind === "nearest-ineligible");
  assert.equal(nearestCards.length, 2);
  assert.deepEqual(nearestCards.map(({ contextRunIds }) => contextRunIds), [
    ["FLEX-001", "FLEX-005"],
    ["FLEX-001", "FLEX-002"],
  ]);
  assert.deepEqual(nearestCards.map(({ title }) => title), [
    "Nearest ineligible candidate: FLEX-005",
    "Nearest ineligible candidate: FLEX-002",
  ]);
  assert.ok(nearestCards.every(({ text }) => text.startsWith("Not an eligible match")));
  assert.equal(nearest.coverage.truncated, false);
  assert.equal(nearest.coverage.displayedCount, 2);

  const wide = searchComparators(dataset, comparatorRequest({
    candidateScope: { kind: "all-reviewed-runs" },
  }));
  const coveragePresentation = buildComparisonPresentation(dataset, wide);
  assert.equal(coveragePresentation.searchState, "no-eligible");
  assert.equal(coveragePresentation.coverage.evaluatedCount, 30);
  assert.equal(coveragePresentation.coverage.displayedCount, 5);
  assert.equal(coveragePresentation.coverage.notDisplayedCandidateRunIds.length, 25);
  assert.equal(coveragePresentation.coverage.truncated, true);
  assert.equal(coveragePresentation.contexts.length, 5);
  const coverageCard = findCard(coveragePresentation, ({ kind }) => kind === "candidate-coverage");
  assert.ok(coverageCard);
  assert.match(coverageCard.text, /Displayed 5 of 30 evaluated candidates/);
  assert.match(coverageCard.text, /five nearest ineligible/);
  assert.deepEqual(
    coveragePresentation.coverage.notDisplayedCandidateRunIds,
    wide.resolvedCandidateRunIds.filter((runId) => (
      !coveragePresentation.coverage.displayedCandidateRunIds.includes(runId)
    )),
  );

  const emptyComparator = searchComparators(dataset, comparatorRequest({
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-001"] },
  }));
  const empty = buildComparisonPresentation(dataset, emptyComparator);
  assert.equal(empty.searchState, "empty");
  assert.deepEqual(empty.contexts, []);
  assert.deepEqual(empty.roles.inspectedRunIds, []);
  assert.equal(empty.coverage.empty, true);
  assert.equal(empty.coverage.evaluatedCount, 0);
  assert.equal(empty.globalCards.filter(({ kind }) => kind === "empty-candidate-scope").length, 1);
  assert.equal(empty.globalCards.filter(({ kind }) => kind === "nearest-ineligible").length, 0);
  assert.equal(empty.globalCards.filter(({ kind }) => kind === "candidate-coverage").length, 0);
  assert.doesNotThrow(() => comparisonExportPayloadSchema.parse(
    buildComparisonExportPayload(dataset, emptyComparator),
  ));

  const unavailable = buildComparisonUnavailablePresentation({
    code: "budget-exhausted",
    message: "No comparison was computed.",
  });
  assert.doesNotThrow(() => comparisonPresentationUnionSchema.parse(unavailable));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.code, "budget-exhausted");
  assert.equal(unavailable.message, "No comparison was computed.");
  assert.deepEqual(unavailable.cards.map(({ kind }) => kind), ["unavailable"]);
  assert.equal(unavailable.cards[0].reasonCode, "budget-exhausted");
  assert.equal(unavailable.datasetVersion, undefined);
  assert.equal(unavailable.coverage, undefined);
  // An unavailable state must not receive the deterministic export envelope.
  assert.equal(comparisonExportPayloadSchema.safeParse(unavailable).success, false);
});

test("incomplete gas and incompatible measurements remain distinct caution cards", () => {
  const modified = structuredClone(dataset);
  const helium = modified.runs
    .find(({ id }) => id === "FLEX-004")
    .fields.find(({ key }) => key === "helium");
  helium.value = null;
  helium.original = null;
  const burningRate = modified.runs
    .find(({ id }) => id === "FLEX-004")
    .fields.find(({ key }) => key === "burning_rate");
  burningRate.unit = "mm";

  const context = buildSelectedRunsContext(modified, selectedRequest(["FLEX-001", "FLEX-004"]));
  const presentation = buildComparisonPresentation(modified, context);
  assert.doesNotThrow(() => comparisonPresentationSchema.parse(presentation));
  assert.equal(presentation.contexts[0].gasComposition.complete, false);

  const incompleteGas = presentation.contexts[0].cards
    .find(({ title }) => title === "Incomplete gas composition");
  assert.ok(incompleteGas);
  assert.equal(incompleteGas.kind, "missing-measurement");
  assert.equal(incompleteGas.text, gasCompositionLimitations.incomplete);
  assert.deepEqual(incompleteGas.runIds, ["FLEX-004"]);
  assert.equal(incompleteGas.sourceReferences.length, 4);
  assert.ok(incompleteGas.sourceReferences.every(({ runId }) => runId === "FLEX-004"));

  const incompatible = presentation.contexts[0].cards
    .find(({ kind }) => kind === "incompatible-measurement");
  assert.ok(incompatible);
  assert.deepEqual(incompatible.fieldKeys, ["burning_rate"]);
  assert.equal(incompatible.severity, "caution");
  assert.match(incompatible.text, /Incompatible/);
  assert.match(incompatible.text, /native unit/);
  assert.deepEqual(incompatible.deltas, []);
});

test("malformed or dataset-mismatched results are rejected instead of exported", () => {
  const context = buildSelectedRunsContext(dataset, selectedRequest(["FLEX-001", "FLEX-004"]));
  assert.deepEqual(validateComparisonPresentationInput(dataset, context), []);

  assert.throws(
    () => buildComparisonPresentation(dataset, { version: "comparison-context-result-1" }),
    (error) => error instanceof ComparisonPresentationError && error.code === "invalid-result",
  );
  assert.deepEqual(
    validateComparisonPresentationInput(dataset, { version: "comparison-context-result-1" })
      .map(({ code }) => code),
    ["invalid-value"],
  );

  assert.throws(
    () => buildComparisonPresentation(dataset, { ...context, datasetVersion: "other-corpus" }),
    (error) => error instanceof ComparisonPresentationError
      && error.code === "mismatched-result"
      && error.details.issues.some(({ code }) => code === "version-mismatch"),
  );

  const changedValue = structuredClone(context);
  changedValue.outcomes.find(({ key }) => key === "burn_time").cells[0].value = 100;
  try {
    buildComparisonPresentation(dataset, changedValue);
    assert.fail("Expected a mismatched-result failure");
  } catch (error) {
    assert.equal(error instanceof ComparisonPresentationError, true);
    assert.equal(error.code, "mismatched-result");
    assert.ok(error.details.issues.some(({ code }) => code === "invalid-value"));
  }

  const changedDelta = structuredClone(context);
  changedDelta.outcomes.find(({ key }) => key === "burn_time").deltas[0].delta = 99;
  assert.throws(
    () => buildComparisonExportPayload(dataset, changedDelta),
    (error) => error instanceof ComparisonPresentationError
      && error.code === "mismatched-result"
      && error.details.issues.some(({ code }) => code === "invalid-value"),
  );

  const comparator = searchComparators(dataset, comparatorRequest({
    candidateScope: { kind: "explicit-runs", runIds: ["FLEX-002", "FLEX-005"] },
  }));
  const wrongScope = structuredClone(comparator);
  wrongScope.resolvedCandidateRunIds = ["FLEX-005"];
  wrongScope.evaluatedCount = 1;
  assert.throws(
    () => buildComparisonPresentation(dataset, wrongScope),
    (error) => error instanceof ComparisonPresentationError
      && error.code === "mismatched-result"
      && error.details.issues.some(({ code }) => code === "binding-mismatch"),
  );

  const payload = buildComparisonExportPayload(dataset, context);
  assert.throws(() => comparisonExportJson({ ...payload, signed: true }));
});
