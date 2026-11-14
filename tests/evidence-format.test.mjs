import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildEvidenceExport, exportEvidenceCsv, exportEvidenceJson, exportPrintableBrief,
} from "../src/lib/evidence-export.ts";
import { formatEvidenceValue } from "../src/lib/evidence-format.ts";
import { parseDataset } from "../src/lib/evidence.ts";

test("evidence display keeps source precision and removes binary subtraction tails", async () => {
  assert.equal(formatEvidenceValue(4.3, { original: "4.30" }), "4.30");
  assert.equal(formatEvidenceValue(0, { original: "0.00" }), "0.00");
  assert.equal(formatEvidenceValue(null, { original: "–" }), "Unknown");
  assert.equal(formatEvidenceValue(1e-12, { signed: true }), "+1e-12");
  assert.equal(formatEvidenceValue(-0.3700000000000001, { signed: true }), "-0.37");
  assert.equal(formatEvidenceValue(0.07999999999999996), "0.08");

  const dataset = parseDataset(JSON.parse(await readFile(new URL("../data/flex.json", import.meta.url), "utf8")));
  const evidence = buildEvidenceExport({ dataset, selection: { runIds: ["FLEX-001", "FLEX-002", "FLEX-004"] } });
  const json = exportEvidenceJson(evidence);
  const csv = exportEvidenceCsv(evidence);
  for (const raw of ["0.07999999999999996", "0.3700000000000001"]) {
    assert.ok(json.includes(raw));
    assert.ok(csv.includes(raw));
  }

  const html = exportPrintableBrief(evidence);
  assert.match(html, /\+0\.08 mm²\/s/);
  assert.match(html, /\+0\.37 mm/);
  assert.match(html, /\+2\.3 mmHg/);
  assert.doesNotMatch(html, /0\.07999999999999996|0\.3700000000000001/);
  assert.match(html, /4\.3 "s"/);
});
