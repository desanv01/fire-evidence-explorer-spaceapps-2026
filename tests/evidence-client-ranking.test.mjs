import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { EvidenceClientError, rankEvidence } from "../src/lib/evidence-client.ts";
import { parseDataset } from "../src/lib/evidence.ts";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("ranks the filtered FLEX corpus and validates handler errors and ranking responses", async (t) => {
  const dataset = parseDataset(await readJson("../data/flex.json"));
  const provenance = await readJson("../data/flex.sources.json");
  const referenceRunId = "FLEX-001";
  const search = { query: "30CAL02", filters: [{ key: "pressure", value: 760 }] };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/evidence");
    const body = JSON.parse(init.body);
    assert.equal(body.action, "rank");
    return handleEvidenceRequest(new Request(new URL(url, "https://example.invalid"), init), {
      dataset, datasetSha256: provenance.datasetSha256,
      deepSeek: { env: { DEEPSEEK_ENABLED: "false" } },
    });
  });

  const ranking = await rankEvidence(referenceRunId, search);
  assert.equal(ranking.referenceRunId, referenceRunId);
  assert.equal(ranking.rankingRuleVersion, "1");
  assert.equal(ranking.datasetSha256, provenance.datasetSha256);
  assert.deepEqual(ranking.search, search);
  assert.deepEqual(ranking.candidates.map(({ runId }) => runId), ["FLEX-004"]);
  const [candidate] = ranking.candidates;
  assert.ok(candidate.comparableCount > 0);
  assert.equal(candidate.comparableCount, candidate.sameCount + candidate.differentCount);
  assert.equal(candidate.score, candidate.sameCount / candidate.comparableCount);
  const pressure = candidate.conditions.find(({ key }) => key === "pressure");
  assert.equal(pressure?.status, "different");
  assert.equal(pressure?.reason, "Recorded values differ.");
  assert.deepEqual((await rankEvidence(referenceRunId, { query: "no-matching-run" })).candidates, []);
  const expectError = (code, status) => (error) =>
    error instanceof EvidenceClientError && error.code === code && error.status === status;
  await assert.rejects(rankEvidence("MISSING"), expectError("unknown-run", 404));
  await assert.rejects(rankEvidence(referenceRunId, { filters: [{ key: "pressure", value: "760" }] }),
    expectError("invalid-filter-type", 400));
  fetchMock.mock.mockImplementation(async () => Response.json({
    ...ranking, candidates: [{ ...candidate, score: 1.2 }],
  }));
  await assert.rejects(rankEvidence(referenceRunId), expectError("invalid-response", 200));
});
