import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { DeepSeekError, explainEvidence } from "../src/lib/deepseek.ts";
import { compareRuns, parseDataset } from "../src/lib/evidence.ts";
import { buildExplanationPacket } from "../src/lib/evidence-packet.ts";

const root = new URL("../", import.meta.url);
const corpus = await readFile(new URL("data/flex.json", root));
const datasetSha256 = createHash("sha256").update(corpus).digest("hex");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const child = spawn(process.execPath, [
  "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
], { cwd: root, stdio: "inherit", windowsHide: true, env: {
  ...process.env, DEEPSEEK_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
} });
const closed = once(child, "close");
const url = `http://127.0.0.1:${port}/api/evidence`;
const post = (body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000),
});
const search = {
  query: "30CAL02", investigation: "FLEX",
  filters: [{ key: "fuel", value: "Methanol" }, { key: "pressure", value: 760 }],
};
const selection = { runIds: ["FLEX-001", "FLEX-004", "FLEX-005"] };
const question = "How do the recorded pressures compare?";

try {
  let response;
  const until = Date.now() + 20_000;
  while (!response && Date.now() < until && child.exitCode === null) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch {
      await setTimeout(200);
    }
  }
  assert.equal(response?.status, 200, "Expected a response from the production build");
  const overview = await response.json();
  assert.equal(overview.runCount, 31);
  assert.equal(overview.datasetSha256, datasetSha256);
  assert.equal(overview.aiEnabled, false);

  const matches = await post({ action: "search", search });
  assert.deepEqual((await matches.json()).runs.map(({ id }) => id), ["FLEX-004"]);
  const details = await post({ action: "run", runId: "FLEX-004" });
  assert.equal((await details.json()).run.id, "FLEX-004");
  const referenced = await post({ action: "source", runId: "FLEX-004", fieldKey: "extinction_diameter" });
  const { field, source, provenance } = await referenced.json();
  assert.equal(field.value, null);
  assert.match(field.locator, /CSV row 5, column L/);
  assert.match(source.url, /psi\.nasa\.gov/);
  assert.match(provenance.transforms.burning_rate, /mm²\/s from Table IX/);
  assert.match(provenance.transforms.extinction_diameter, /estimates/);
  const compared = await post({ action: "compare", selection });
  const comparison = await compared.json();
  assert.deepEqual(comparison.runIds, selection.runIds);
  const pressure = comparison.rows.find(({ key }) => key === "pressure");
  assert.equal(pressure.cells[0].field.original, "757.7");
  assert.ok(Math.abs(pressure.differences[0].delta - 2.3) < 1e-10);

  const download = { action: "export", question, selection, search };
  const exportResponse = await post({ ...download, format: "json" });
  assert.match(exportResponse.headers.get("content-disposition"), /^attachment;/);
  const evidence = await exportResponse.json();
  assert.equal(evidence.datasetSha256, datasetSha256);
  assert.equal(evidence.question, question);
  assert.deepEqual(evidence.search, search);
  assert.deepEqual(evidence.comparison.rows, comparison.rows);
  assert.deepEqual(evidence.datasetProvenance, provenance);
  const csv = await post({ ...download, format: "csv" });
  assert.match(await csv.text(), /CSV row 5, column L/);
  const brief = await post({ ...download, format: "brief" });
  const html = await brief.text();
  assert.match(html, /<!doctype html>/);
  assert.match(html, /NASA\/TP-2015-216046/);
  const disabled = await post({ action: "explain", ai: true, question, selection });
  assert.equal(disabled.status, 503);
  assert.deepEqual((await disabled.json()).error, "disabled");
  assert.equal((await post({ action: "run", runId: "UNKNOWN" })).status, 404);
  const unknownFilter = await post({ action: "search", search: { filters: [{ key: "unknown", value: 1 }] } });
  assert.equal(unknownFilter.status, 400);
  assert.equal((await unknownFilter.json()).error, "unknown-filter-field");
  const wrongType = await post({ action: "search", search: { filters: [{ key: "pressure", value: "760" }] } });
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json()).error, "invalid-filter-type");
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("a".repeat(65_537))).status, 413);

  console.log("NASA FLEX HTTP smoke passed: 31 runs, source locators, comparison and all export formats, AI disabled.");
} finally {
  child.kill();
  await closed;
}

const comparison = compareRuns(parseDataset(JSON.parse(corpus)), selection);
const { packet, citations } = buildExplanationPacket(comparison);
assert.equal(packet.evidence.filter(({ id }) => id.startsWith("field:")).length, comparison.rows.length);
assert.equal(citations["field:2"].sources.length, 3);
assert.ok(packet.evidence.length <= 16);
let serializedBytes = 0;
await assert.rejects(explainEvidence(question, packet, {
  env: { DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "offline-measurement-placeholder" },
  fetchImpl: async (_url, init) => {
    serializedBytes = Buffer.byteLength(init.body);
    throw new Error("Offline request measurement. No network transport.");
  },
}), (error) => error instanceof DeepSeekError && error.code === "network");
assert.ok(serializedBytes > 0 && serializedBytes <= 16 * 1024);
console.log(`NASA three-run request serialization passed: ${packet.evidence.length} items, ${serializedBytes} bytes. No provider response.`);
