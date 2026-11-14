import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { parseDataset } from "../src/lib/evidence.ts";

test("a single-run chat answer exports its exact receipt and groups identical source references", async () => {
  const readJson = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
  const dataset = parseDataset(await readJson("flex.json"));
  const provenance = await readJson("flex.sources.json");
  const runIds = ["FLEX-009"];
  const question = "What fuel was recorded for FLEX-009?";
  let calls = 0;
  const post = (body) => handleEvidenceRequest(new Request("https://example.invalid/api/evidence", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), {
    dataset, datasetSha256: provenance.datasetSha256, datasetProvenance: provenance,
    deepSeek: {
      env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "offline-chat-export-fixture-key" },
      fetchImpl: async () => {
        calls++;
        const content = JSON.stringify({
          status: "supported",
          claims: [
            { text: "The selected record identifies the fuel.", status: "reported", citationIds: ["field:1"] },
            { text: "The fuel and test end are recorded.", status: "reported", citationIds: ["field:1", "field:11"] },
          ],
        });
        return Response.json({
          model: "offline-export-fixture",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        });
      },
    },
  });

  const chat = await post({ action: "chat", ai: true, question, runIds });
  assert.equal(chat.status, 200, await chat.clone().text());
  const answer = await chat.json();
  assert.equal(answer.kind, "explanation");
  const { result } = answer;
  assert.equal(result.packet.scope, "selected-runs");
  assert.ok(result.explanationReceipt);
  const input = {
    action: "export", question: result.question, selection: { runIds: result.runIds },
    explanationReceipt: result.explanationReceipt,
  };
  const response = await post({ ...input, format: "json" });
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.equal(json.scope, "selected-runs");
  assert.equal(json.comparison, null);
  assert.deepEqual(json.runIds, runIds);
  assert.equal(json.runs[0].fields.find(({ key }) => key === "burn_time").value, null);
  assert.deepEqual(json.ai.explanation, result.explanation);
  assert.equal(json.question, result.question);

  const csv = await (await post({ ...input, format: "csv" })).text();
  assert.match(csv, /"fuel","Fuel","reported"/);
  const html = await (await post({ ...input, format: "brief" })).text();
  assert.match(html, /Recorded run evidence/);
  const explanation = html.split("Evidence explanation")[1];
  assert.match(explanation, /Sources \[1\], \[2\]/);
  assert.equal((explanation.match(/CSV row 10, column E/g) ?? []).length, 1);
  assert.equal((explanation.match(/CSV row 10, column O/g) ?? []).length, 1);

  const stale = await post({ ...input, question: "What pressure was recorded?", format: "json" });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "explanation-mismatch" });
  assert.equal(calls, 1);
});
