import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { EvidenceClientError, explainEvidence, fetchEvidenceExport } from "../src/lib/evidence-client.ts";
import { buildExplanationPacket, createExplanationReceipt, explanationIdentity } from "../src/lib/evidence-packet.ts";
import { compareRuns, parseDataset } from "../src/lib/evidence.ts";

test("the browser and signed exports retain fallback provenance and the exact source target", async (t) => {
  const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const dataset = parseDataset(await readJson("../data/flex.json"));
  const { datasetSha256 } = await readJson("../data/flex.sources.json");
  const runIds = ["FLEX-002", "FLEX-009"];
  const question = "Did FLEX-009 burn for zero seconds?";
  const comparison = compareRuns(dataset, { runIds });
  const context = buildExplanationPacket(comparison);
  const [citationId] = Object.entries(context.citations)
    .find(([id, { fieldKey }]) => id.startsWith("field:") && fieldKey === "burn_time");
  const [fuelCitationId] = Object.entries(context.citations)
    .find(([id, { fieldKey }]) => id.startsWith("field:") && fieldKey === "fuel");
  const scope = context.packet.scope;
  const key = "synthetic-fallback-receipt-key";
  const fingerprint = explanationIdentity(datasetSha256, question, comparison, context);
  const claim = {
    text: "FLEX-009 burn time is unreported.", status: "insufficient", scope,
    citationIds: [citationId], measurements: [],
  };
  const legacy = { status: "insufficient", scope, claims: [claim], model: null };
  const fallback = {
    ...legacy,
    provenance: { kind: "deterministic-evidence", ruleVersion: "flex-evidence-1" },
    claims: [{ ...claim, citationTargets: [{ citationId, runId: "FLEX-009" }] }],
    model: {
      requested: "deepseek-flash", returned: "deepseek-flash",
      promptVersion: "evidence-1", configVersion: "fixture-config", usage: null,
    },
  };
  let next = fallback;
  let explanationRequests = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/evidence");
    const body = JSON.parse(init.body);
    if (body.action === "explain") {
      explanationRequests++;
      return Response.json({
        datasetVersion: dataset.version, datasetSha256, comparisonRuleVersion: comparison.comparisonRuleVersion,
        question, runIds, ...context, explanation: next,
        explanationReceipt: createExplanationReceipt(fingerprint, next, key),
      });
    }
    assert.equal(body.action, "export");
    return handleEvidenceRequest(new Request(new URL(url, "https://example.invalid"), init), {
      dataset, datasetSha256, deepSeek: {
        env: { DEEPSEEK_ENABLED: "false", DEEPSEEK_API_KEY: key },
        fetchImpl: async () => assert.fail("A signed export cannot call the provider"),
      },
    });
  });

  const explanation = await explainEvidence(question, runIds);
  assert.deepEqual(explanation.explanation, fallback);
  const input = { question, runIds, explanation };
  const json = await fetchEvidenceExport({ ...input, format: "json" });
  assert.equal(json.explanationStatus, "included");
  const { ai } = JSON.parse(await json.blob.text());
  assert.deepEqual(ai.explanation, fallback);
  const csv = await fetchEvidenceExport({ ...input, format: "csv" });
  const firstRow = (await csv.blob.text()).split("\r\n")[1];
  assert.ok(firstRow.endsWith(',"' + JSON.stringify(ai).replaceAll('"', '""') + '"'));
  const brief = await fetchEvidenceExport({ ...input, format: "brief" });
  const section = (await brief.blob.text()).split("Evidence-only fallback")[1];
  assert.match(section, /Evidence rule version flex-evidence-1/);
  assert.match(section, /Attempted model deepseek-flash/);
  assert.match(section, /CSV row 10, column N/);
  assert.doesNotMatch(section, /CSV row 3, column N/);
  assert.equal(explanationRequests, 1);

  next = legacy;
  const older = await explainEvidence(question, runIds);
  assert.deepEqual(older.explanation, legacy);
  const olderBrief = await fetchEvidenceExport({ ...input, explanation: older, format: "brief" });
  const olderHtml = await olderBrief.blob.text();
  assert.match(olderHtml, /Evidence-only result/);
  assert.doesNotMatch(olderHtml, /Attempted model/);

  next = { ...fallback, claims: [{ ...claim, citationTargets: [{ citationId, runId: "FLEX-001" }] }] };
  await assert.rejects(explainEvidence(question, runIds), (error) =>
    error instanceof EvidenceClientError && error.code === "invalid-response");

  const missingTargets = { ...fallback, claims: [claim] };
  const incompleteTargets = {
    ...fallback,
    claims: [{ ...fallback.claims[0], citationIds: [citationId, fuelCitationId] }],
  };
  for (const malformed of [missingTargets, incompleteTargets]) {
    next = malformed;
    await assert.rejects(explainEvidence(question, runIds), (error) =>
      error instanceof EvidenceClientError && error.code === "invalid-response");
    // Exercise the formatter with an already signed malformed result, bypassing browser parsing.
    const receipt = createExplanationReceipt(fingerprint, malformed, key);
    const exported = await fetchEvidenceExport({
      ...input, format: "brief", explanation: { ...explanation, explanationReceipt: receipt },
    });
    const fallbackHtml = (await exported.blob.text()).split("Evidence-only fallback")[1];
    assert.doesNotMatch(fallbackHtml, /CSV row 3, column N|CSV row (?:3|10), column E/);
    if (malformed === missingTargets) assert.doesNotMatch(fallbackHtml, /CSV row 10, column N/);
    else assert.match(fallbackHtml, /CSV row 10, column N/);
  }

  next = { ...fallback, claims: [{ ...claim, text: "The selected evidence is inconclusive.", citationIds: [] }] };
  const generic = await explainEvidence(question, runIds);
  assert.deepEqual(generic.explanation.claims[0].citationIds, []);
});
