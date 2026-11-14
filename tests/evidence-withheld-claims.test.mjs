import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { explainEvidence, fetchEvidenceExport } from "../src/lib/evidence-client.ts";
import { parseDataset } from "../src/lib/evidence.ts";

test("partial and complete explanations round-trip through the browser client and signed exports", async (t) => {
  const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const dataset = parseDataset(await readJson("../data/flex.json"));
  const provenance = await readJson("../data/flex.sources.json");
  const runIds = ["FLEX-001", "FLEX-004"];
  const question = "What fuel was recorded?";
  const accepted = { text: "The selected runs record methanol.", status: "reported", citationIds: ["field:1"] };
  const withheld = { ...accepted, text: "Both runs recorded 500 units of fuel." };
  let calls = 0;
  let claims = [accepted, withheld];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/evidence");
    return handleEvidenceRequest(new Request(new URL(url, "https://example.invalid"), init), {
      dataset, datasetSha256: provenance.datasetSha256, datasetProvenance: provenance,
      deepSeek: {
        env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "synthetic-withholding-fixture-key" },
        fetchImpl: async () => {
          calls++;
          return Response.json({
            model: "synthetic-withholding-fixture",
            choices: [{ finish_reason: "stop", message: {
              role: "assistant", content: JSON.stringify({ status: "supported", claims }),
            } }],
          });
        },
      },
    });
  });

  const partial = await explainEvidence(question, runIds);
  assert.equal(partial.explanation.withheldClaims, 1);
  assert.equal(partial.explanation.claims.length, 1);
  assert.ok(partial.explanationReceipt);
  const selection = { question, runIds, explanation: partial };
  const json = await fetchEvidenceExport({ ...selection, format: "json" });
  assert.equal(json.explanationStatus, "included");
  const evidence = JSON.parse(await json.blob.text());
  assert.deepEqual(evidence.ai.explanation, partial.explanation);
  assert.ok(!JSON.stringify(evidence).includes(withheld.text));
  const brief = await fetchEvidenceExport({ ...selection, format: "brief" });
  const html = await brief.blob.text();
  assert.match(html, /Partial explanation\. 1 claim was withheld because the prose contained quantities\./);
  assert.ok(html.includes(accepted.text));
  assert.ok(!html.includes(withheld.text));
  assert.equal(calls, 1);

  claims = [accepted];
  const complete = await explainEvidence(question, runIds);
  assert.ok(!Object.hasOwn(complete.explanation, "withheldClaims"));
  const completeBrief = await fetchEvidenceExport({ ...selection, explanation: complete, format: "brief" });
  assert.equal(completeBrief.explanationStatus, "included");
  const completeHtml = await completeBrief.blob.text();
  assert.ok(completeHtml.includes(accepted.text));
  assert.doesNotMatch(completeHtml, /Partial explanation/);
  assert.equal(calls, 2);
});
