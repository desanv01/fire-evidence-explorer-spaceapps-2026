import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareRuns, parseDataset } from "../src/lib/evidence.ts";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { buildExplanationPacket } from "../src/lib/evidence-packet.ts";
import { explainSelectedFlexEvidence } from "../src/lib/evidence-explanation.ts";

const corpus = JSON.parse(await readFile(new URL("../data/flex.json", import.meta.url), "utf8"));
const provenance = JSON.parse(await readFile(new URL("../data/flex.sources.json", import.meta.url), "utf8"));
const dataset = parseDataset(corpus);
const cases = [
  {
    id: "U01", runIds: ["FLEX-002", "FLEX-009"],
    question: "Did FLEX-009 burn for zero seconds?",
    paraphrase: "Was FLEX-009’s burn time zero?",
    status: "insufficient", text: /burn time for FLEX-009 is unreported/,
    cells: ["N10"], measurements: [],
  },
  {
    id: "U03", runIds: ["FLEX-004", "FLEX-005"],
    question: "Do FLEX-004 and FLEX-005 prove that initial droplet size caused the outcome difference?",
    paraphrase: "Can we conclude that the initial droplet size caused the difference between FLEX-004 and FLEX-005?",
    status: "supported", text: /unreported for FLEX-004.*cannot establish that initial droplet size caused/,
    cells: ["K5", "K6", "L5", "L6"], measurements: [[2.06, "mm"], [1.92, "mm"], [0.81, "mm"]],
  },
  {
    id: "U04", runIds: ["FLEX-030", "FLEX-029"],
    question: "Does visible flame extinction alone prove all combustion stopped in FLEX-030?",
    paraphrase: "Does FLEX-030’s visible extinction mean all combustion ceased?",
    status: "supported", text: /visible flame extinction.*cannot establish that all combustion stopped/i,
    cells: ["L31", "O31"], measurements: [[1.32, "mm"]],
  },
];

let outbound = 0;
const disabled = { DEEPSEEK_ENABLED: "false", DEEPSEEK_API_KEY: "fixture-signing-key" };
const noTransport = async () => { outbound++; throw new Error("unexpected transport"); };
function post(action, env = disabled, fetchImpl = noTransport) {
  return handleEvidenceRequest(new Request("https://fixture.example/api/evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  }), {
    dataset, datasetSha256: provenance.datasetSha256, datasetProvenance: provenance,
    deepSeek: { env, fetchImpl },
  });
}

test("answers U01, U03 and U04 with targeted source anchors and signs deterministic provenance without provider calls", async () => {
  for (const { id, question, runIds, status, text, cells, measurements } of cases) {
    const selection = { runIds };
    const response = await post({ action: "explain", ai: true, question, selection });
    assert.equal(response.status, 200, id);
    const { explanation, explanationReceipt, citations } = await response.json();
    assert.equal(explanation.status, status, id);
    assert.equal(explanation.model, null);
    assert.deepEqual(explanation.provenance, { kind: "deterministic-evidence", ruleVersion: "flex-evidence-1" });
    assert.match(explanation.claims.map((claim) => claim.text).join(" "), text);
    assert.deepEqual(explanation.claims.flatMap((claim) =>
      claim.measurements.map(({ value, unit }) => [value, unit])), measurements);

    const cited = new Set();
    for (const claim of explanation.claims) {
      assert.ok(claim.citationTargets.length);
      for (const target of claim.citationTargets) {
        assert.ok(claim.citationIds.includes(target.citationId));
        const citation = citations[target.citationId];
        const anchor = citation.sources.find((source) => source.runId === target.runId);
        assert.ok(anchor);
        const source = await post({ action: "source", runId: target.runId, fieldKey: citation.fieldKey });
        assert.equal(source.status, 200);
        const original = await source.json();
        assert.equal(anchor.locator, original.field.locator);
        assert.equal(anchor.sourceId, original.source.id);
        const [, row, column] = anchor.locator.match(/CSV row (\d+), column ([A-Z])/) ?? [];
        cited.add(`${column}${row}`);
        if (id === "U01" || (id === "U03" && column === "L" && row === "5")) {
          assert.equal(original.field.original, null);
          assert.equal(original.field.value, null);
        }
      }
    }
    assert.deepEqual([...cited].sort(), cells);
    assert.ok(explanationReceipt);
    const request = { action: "export", selection, question, format: "json", explanationReceipt };
    const signed = await post(request);
    assert.equal(signed.status, 200);
    assert.deepEqual((await signed.json()).ai.explanation, explanation);
    assert.equal((await post({ ...request, question: question + " Please elaborate." })).status, 409);
    assert.equal((await post({ ...request, selection: { runIds: [...runIds].reverse() } })).status, 409);
  }
  assert.equal(outbound, 0);
});

test("recognizes bounded paraphrases and sends unrelated, mixed or out-of-scope requests to the normal adapter", async () => {
  for (const { question, paraphrase, runIds } of cases) {
    const comparison = compareRuns(dataset, { runIds });
    const context = buildExplanationPacket(comparison);
    const exact = explainSelectedFlexEvidence(question, comparison, context);
    assert.ok(exact);
    assert.deepEqual(explainSelectedFlexEvidence(paraphrase, comparison, context), exact);
  }
  for (const [question, runIds] of [
    ["Compare the burn times.", cases[0].runIds],
    ["Was FLEX-010's burn time zero?", cases[0].runIds],
    ["Did FLEX-009 burn for zero seconds? Also compare fuel.", cases[0].runIds],
    ["Can we conclude that the initial droplet size caused the difference between FLEX-004 and FLEX-010?", cases[1].runIds],
    ["Does FLEX-030's visible extinction mean all combustion ceased, and what was the chamber pressure?", cases[2].runIds],
  ]) {
    const response = await post({ action: "explain", ai: true, question, selection: { runIds } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "disabled");
  }
  assert.equal(outbound, 0);
});

test("requires selected source anchors and leaves keyless results unsigned", async () => {
  const { question, runIds } = cases[0];
  const comparison = compareRuns(dataset, { runIds });
  const context = buildExplanationPacket(comparison);
  assert.equal(explainSelectedFlexEvidence("Compare the burn times.", comparison, context), null);
  assert.equal(explainSelectedFlexEvidence("Did FLEX-010 burn for zero seconds?", comparison, context), null);
  assert.equal(explainSelectedFlexEvidence("Did FLEX-002 burn for zero seconds?", comparison, context), null);
  const anchor = Object.values(context.citations).find((citation) => citation.fieldKey === "burn_time");
  anchor.sources = anchor.sources.filter((source) => source.runId !== "FLEX-009");
  assert.equal(explainSelectedFlexEvidence(question, comparison, context), null);
  const keyless = await post({ action: "explain", ai: true, question, selection: { runIds } }, {});
  assert.equal(keyless.status, 200);
  const body = await keyless.json();
  assert.equal(body.explanation.model, null);
  assert.equal(body.explanationReceipt, null);
  assert.equal(outbound, 0);
});

test("signs the evidence-only fallback without model claims when every finding is withheld", async () => {
  const selection = { runIds: ["FLEX-001", "FLEX-004"] };
  const question = "What does the pressure evidence support?";
  const env = { ...disabled, DEEPSEEK_ENABLED: "true" };
  const rejected = "The recorded pressure in FLEX-999 was 900 mmHg.";
  const comparison = compareRuns(dataset, selection);
  const { citations } = buildExplanationPacket(comparison);
  const pressure = Object.keys(citations).find((id) => citations[id].fieldKey === "pressure");
  assert.ok(pressure);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: {
        role: "assistant",
        content: JSON.stringify({ status: "supported", claims: [
          { status: "reported", text: rejected, citationIds: [pressure] },
        ] }),
      } }],
    });
  };
  const response = await post({ action: "explain", ai: true, selection, question }, env, fetchImpl);
  assert.equal(response.status, 200);
  const { explanation, explanationReceipt } = await response.json();
  assert.equal(explanation.status, "insufficient");
  assert.deepEqual(explanation.provenance, { kind: "deterministic-evidence", ruleVersion: "claim-withholding-1" });
  assert.equal(explanation.model.returned, "deepseek-flash");
  assert.equal(explanation.claims.length, 1);
  assert.deepEqual(explanation.claims[0].citationIds, []);
  assert.deepEqual(explanation.claims[0].measurements, []);
  assert.ok(!JSON.stringify(explanation).includes(rejected));
  assert.ok(explanationReceipt);
  const exported = await post({ action: "export", selection, question, format: "json", explanationReceipt }, env, fetchImpl);
  assert.equal(exported.status, 200);
  assert.deepEqual((await exported.json()).ai.explanation, explanation);
  assert.equal(calls, 1);
});
