import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  compareEvidence, downloadEvidence, EvidenceClientError, explainEvidence, fetchEvidenceExport,
  getEvidenceOverview, getEvidenceRun, getEvidenceSource, proposeEvidenceFilters,
  readEvidenceSelection, searchEvidence, writeEvidenceSelection,
} from "../src/lib/evidence-client.ts";
import { handleEvidenceRequest } from "../src/lib/evidence-api.ts";
import { parseDataset } from "../src/lib/evidence.ts";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const dataset = parseDataset(await readJson("../data/flex.json"));
const provenance = await readJson("../data/flex.sources.json");
const identity = {
  datasetVersion: dataset.version, datasetSha256: provenance.datasetSha256, comparisonRuleVersion: "1",
};
const runIds = ["FLEX-005", "FLEX-001", "FLEX-004"];
const question = "  What recorded pressure changed?  ";
const isError = (code, status) => (error) =>
  error instanceof EvidenceClientError && error.code === code && error.status === status;

test("share links preserve order, unrelated parameters and the hash", () => {
  const url = new URL("https://example.invalid/compare?query=FLEX&run=old#sources");
  const shared = writeEvidenceSelection(url, runIds);
  assert.deepEqual(readEvidenceSelection(shared), runIds);
  assert.equal(shared.searchParams.get("query"), "FLEX");
  assert.equal(shared.hash, "#sources");
  assert.equal(url.searchParams.get("run"), "old");
  assert.deepEqual(readEvidenceSelection(writeEvidenceSelection(shared, [])), []);
  assert.deepEqual(readEvidenceSelection(new URL("https://example.invalid/?run=A&run=A")), []);
  assert.throws(() => writeEvidenceSelection(url, ["A"]), isError("invalid-selection"));
});

test("deterministic requests and downloads match the pinned server handler", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/evidence");
    if (init.method === "GET") {
      return Response.json({
        ...identity, provenance, runCount: dataset.runs.length, sources: dataset.sources,
        investigations: ["FLEX"], aiEnabled: false,
      });
    }
    return handleEvidenceRequest(new Request(new URL(url, "https://example.invalid"), init), {
      dataset, datasetSha256: provenance.datasetSha256, datasetProvenance: provenance,
      deepSeek: { env: { DEEPSEEK_ENABLED: "false" } },
    });
  });
  const overview = await getEvidenceOverview();
  assert.equal(overview.runCount, 31);
  assert.equal(overview.aiEnabled, false);
  const search = { query: "FLEX", filters: [{ key: "pressure", value: 760 }] };
  assert.ok((await searchEvidence(search)).runs.some(({ id }) => id === "FLEX-004"));
  assert.equal((await getEvidenceRun("FLEX-004")).run.id, "FLEX-004");
  const result = await getEvidenceSource("FLEX-004", "extinction_diameter");
  assert.match(result.field.locator, /CSV row 5, column L/);
  assert.equal(result.field.value, null);
  assert.deepEqual((await compareEvidence(runIds)).runIds, runIds);
  for (const [format, mime, extension] of [
    ["json", "application/json", "json"], ["csv", "text/csv", "csv"], ["brief", "text/html", "html"],
  ]) {
    const output = await fetchEvidenceExport({ format, runIds, question, search });
    assert.equal(output.filename, `fire-evidence-brief.${extension}`);
    assert.match(output.blob.type, new RegExp(`^${mime};`));
    assert.equal(output.explanationStatus, "not-requested");
    assert.match(await output.blob.text(), /FLEX-005/);
  }
  await assert.rejects(getEvidenceRun("MISSING"), isError("unknown-run", 404));
  await assert.rejects(proposeEvidenceFilters(question), isError("disabled", 503));
});

test("receipt binding is exact and rejection retries only the deterministic export", async (t) => {
  const calls = [];
  const serverReceipt = `fixture.${"x".repeat(43)}`;
  const model = {
    requested: "deepseek-flash", returned: null, usage: null,
    promptVersion: "evidence-1", configVersion: "deepseek-2",
  };
  let rejectReceipt = false;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    switch (body.action) {
      case "propose-filters":
        assert.equal(body.ai, true);
        return Response.json({ ...identity, question: question.trim(), model, filters: [{ key: "pressure", value: 760 }] });
      case "explain":
        assert.equal(body.ai, true);
        assert.deepEqual(body.selection.runIds, runIds);
        return Response.json({
          ...identity, question: question.trim(), runIds, packetVersion: 1,
          packet: { scope: "selected-comparison", evidence: [] }, citations: {},
          explanation: { scope: "selected-comparison", status: "insufficient", model, claims: [] },
          explanationReceipt: serverReceipt,
        });
      case "export":
        if (rejectReceipt && body.explanationReceipt) {
          return Response.json({ error: "explanation-mismatch" }, { status: 409 });
        }
        return Response.json({ explanationIncluded: Boolean(body.explanationReceipt) });
      default:
        assert.fail("Unexpected request");
    }
  });
  const proposed = await proposeEvidenceFilters(question);
  assert.deepEqual(proposed.filters, [{ key: "pressure", value: 760 }]);
  const explanation = await explainEvidence(question, runIds);
  const input = { format: "json", runIds, question, explanation };
  const matched = await fetchEvidenceExport(input);
  assert.equal(matched.explanationStatus, "included");
  assert.equal(calls.at(-1).explanationReceipt, serverReceipt);
  for (const stale of [
    { ...input, question: question.trim() },
    { ...input, runIds: [...runIds].reverse() },
    { ...input, explanation: { ...explanation, explanationReceipt: "malformed" } },
  ]) {
    assert.equal((await fetchEvidenceExport(stale)).explanationStatus, "omitted-mismatch");
    assert.equal(calls.at(-1).explanationReceipt, undefined);
  }
  rejectReceipt = true;
  assert.equal((await fetchEvidenceExport(input)).explanationStatus, "omitted-rejected");
  assert.deepEqual(calls.slice(-2).map(({ action, explanationReceipt }) => [action, explanationReceipt]), [
    ["export", serverReceipt], ["export", undefined],
  ]);
  assert.equal(calls.filter(({ action }) => action === "explain").length, 1);
});

test("rejects unsafe response shapes and keeps server text out of client errors", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "unknown-run", message: "<script>private text</script>" }, { status: 404 }));
  await assert.rejects(getEvidenceRun("MISSING"), (error) =>
    isError("unknown-run", 404)(error) && !error.message.includes("private text"));
  fetchMock.mock.mockImplementation(async () => Response.json({ ...identity, runIds: [...runIds].reverse(), rows: [] }));
  await assert.rejects(compareEvidence(runIds), isError("invalid-response"));
  fetchMock.mock.mockImplementation(async () => Response.json({ runs: null }));
  await assert.rejects(searchEvidence({}), isError("invalid-response", 200));
  fetchMock.mock.mockImplementation(async () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(fetchEvidenceExport({ runIds, format: "csv" }), isError("invalid-response", 200));
  const controller = new AbortController();
  controller.abort();
  fetchMock.mock.mockImplementation(async (_url, init) => init.signal.throwIfAborted());
  await assert.rejects(getEvidenceOverview({ signal: controller.signal }), isError("aborted"));
});

test("downloads via an attachment link and releases its object URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<!doctype html>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  const events = [];
  t.mock.method(URL, "createObjectURL", (blob) => {
    assert.equal(blob.type, "text/html;charset=utf-8");
    return "blob:fixture";
  });
  t.mock.method(URL, "revokeObjectURL", (url) => events.push(["revoke", url]));
  const link = {
    click() { events.push(["click", this.href, this.download]); },
    remove() { events.push(["remove"]); },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", {
    configurable: true, value: { createElement: () => link, body: { append: () => events.push(["append"]) } },
  });
  let cleanup;
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { setTimeout: (callback) => { cleanup = callback; } },
  });
  try {
    await downloadEvidence({ format: "brief", runIds });
    assert.deepEqual(events, [["append"], ["click", "blob:fixture", "fire-evidence-brief.html"], ["remove"]]);
    cleanup();
    assert.deepEqual(events.at(-1), ["revoke", "blob:fixture"]);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});
