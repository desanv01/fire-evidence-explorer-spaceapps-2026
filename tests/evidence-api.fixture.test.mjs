import assert from "node:assert/strict";
import { test } from "node:test";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { parseDataset } from "../src/lib/evidence.ts";

const source = {
  id: "synthetic", title: "Synthetic source", url: "https://example.invalid/fixture.csv",
  version: "fixture-1", license: "Synthetic test data",
};
const dataset = parseDataset({
  version: "synthetic-1", sources: [source],
  runs: [1, 2, 3].map((n) => ({
    id: `FIXTURE-${n}`, investigation: "Synthetic",
    fields: [{
      key: "pressure", label: "Pressure", kind: "condition", value: n, unit: "kPa",
      original: String(n), locator: `Fixture row ${n}`, sourceId: source.id,
    }],
  })),
});
const selection = { runIds: ["FIXTURE-1", "FIXTURE-2"] };
const question = "Which recorded pressure changed? <script>fixture</script>";
const key = "synthetic-fixture-key";
const reasoning = "Fixture private reasoning";
const claim = "The selected records include pressure observations.";

function post(body, options) {
  return handleEvidenceRequest(new Request("https://example.invalid/api/evidence", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { dataset, datasetSha256: "synthetic-hash", ...options });
}

test("mock provider responses stay tied to the server-built selection and can be exported without another call", async () => {
  let calls = 0;
  const options = {
    deepSeek: {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: key },
      fetchImpl: async (_url, init) => {
        calls++;
        const payload = JSON.parse(JSON.parse(init.body).messages[1].content);
        assert.equal(payload.question, question);
        assert.ok(!init.body.includes(key));
        let output;
        if (calls === 1) {
          assert.deepEqual(payload.supportedFields, { pressure: [1, 2, 3] });
          output = { filters: { pressure: 2 } };
        } else {
          assert.equal(payload.scope, "selected-comparison");
          assert.ok(!init.body.includes("FIXTURE-3"));
          assert.ok(!init.body.includes(source.url));
          assert.deepEqual(payload.evidence[0].numbers.map(({ value }) => value), [1, 2]);
          output = {
            status: "supported",
            claims: [{ status: "reported", text: claim, citationIds: ["field:1"] }],
          };
        }
        return Response.json({
          model: "synthetic-model",
          choices: [{ finish_reason: "stop", message: {
            role: "assistant", content: JSON.stringify(output), reasoning_content: reasoning,
          } }],
        });
      },
    },
  };
  const denied = await post({ action: "explain", question, selection, ai: false }, options);
  assert.equal(denied.status, 400);
  const proposal = await post({ action: "propose-filters", question, ai: true }, options);
  assert.equal(proposal.status, 200);
  assert.deepEqual((await proposal.json()).filters, [{ key: "pressure", value: 2 }]);
  const response = await post({ action: "explain", question, selection, ai: true }, options);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.explanation.claims[0].text, claim);
  assert.equal(result.citations["field:1"].sources[1].locator, "Fixture row 2");
  assert.ok(!JSON.stringify(result).includes(reasoning));
  assert.ok(!JSON.stringify(result).includes(key));

  const download = { action: "export", format: "json", question, selection, explanationReceipt: result.explanationReceipt };
  const exported = await post(download, options);
  assert.equal(exported.status, 200);
  const evidence = await exported.json();
  assert.deepEqual(evidence.ai.explanation, result.explanation);
  assert.deepEqual(evidence.ai.citations, result.citations);
  assert.equal(evidence.ai.explanation.model.returned, "synthetic-model");
  const brief = await post({ ...download, format: "brief" }, options);
  const html = await brief.text();
  assert.match(html, /Fixture row 2/);
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const stale = await post({ ...download, selection: { runIds: [...selection.runIds].reverse() } }, options);
  assert.equal(stale.status, 409);
  const token = result.explanationReceipt;
  const tampered = await post({ ...download, explanationReceipt: (token[0] === "a" ? "b" : "a") + token.slice(1) }, options);
  assert.equal(tampered.status, 409);
  assert.equal(calls, 2);
});
