# Fire Evidence Explorer quickstart

Start the app with `npm run dev` from the repository root. The examples use Node.js 24 and the default local port, 3000.

## Browser workflow

1. Open `http://localhost:3000/`. The default comparison uses `FLEX-001` and `FLEX-004`. The recorded burn-time difference from the first run to the second is +3.34 s.
2. Open **Runs**. Search for `30CAL02` with fuel **Methanol** and pressure `760` to find `FLEX-004`. Open its run detail to see the missing visible-extinction diameter.
3. Clear the search and filters and run **Search** again. Choose `FLEX-001` as the ranking reference. The full collection gives 30 candidates, excluding the reference. Inspect a candidate's field-by-field matches and coverage.
4. Select `FLEX-001`, `FLEX-004` and `FLEX-005` in that order and use **Compare selected runs**. To open the same comparison directly, go to `http://localhost:3000/?run=FLEX-001&run=FLEX-004&run=FLEX-005`. In the **Burn time** row, open the source for `FLEX-004`. The inspector shows CSV row 5, column N.
5. Choose **Open evidence brief**, then **Export brief**. Reopen the JSON, CSV or printable HTML and check the selected runs, comparison and sources. An export can include a matching validated explanation when one is available.

## API example

Save the following as `quickstart.mjs` and run `node quickstart.mjs` in a second terminal. It checks readiness and dataset coverage, searches and ranks real runs, compares three runs, resolves a source location and writes JSON, CSV and a printable HTML brief to the current directory.

```js
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const base = process.env.EVIDENCE_ORIGIN ?? "http://localhost:3000";
const evidenceUrl = `${base}/api/evidence`;

async function requireOk(response) {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function evidence(input) {
  return requireOk(await fetch(evidenceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

const health = await requireOk(await fetch(`${base}/api/health`));
assert.equal((await health.json()).status, "ok");

const overviewResponse = await requireOk(await fetch(evidenceUrl));
const overview = await overviewResponse.json();
assert.equal(overview.runCount, 31);
console.log(overview.datasetVersion, overview.datasetSha256);

const search = {
  query: "30CAL02",
  investigation: "FLEX",
  filters: [{ key: "fuel", value: "Methanol" }, { key: "pressure", value: 760 }],
};
const { runs } = await (await evidence({ action: "search", search })).json();
assert.deepEqual(runs.map(({ id }) => id), ["FLEX-004"]);

const ranking = await (await evidence({
  action: "rank", referenceRunId: "FLEX-001", search: { investigation: "FLEX" },
})).json();
assert.equal(ranking.referenceRunId, "FLEX-001");
assert.equal(ranking.rankingRuleVersion, "1");
assert.equal(ranking.candidates.length, 30);
assert.ok(ranking.candidates.every(({ runId }) => runId !== ranking.referenceRunId));

const selection = { runIds: ["FLEX-001", "FLEX-004", "FLEX-005"] };
const comparison = await (await evidence({ action: "compare", selection })).json();
assert.deepEqual(comparison.runIds, selection.runIds);
const pressure = comparison.rows.find(({ key }) => key === "pressure");
assert.ok(Math.abs(pressure.differences[0].delta - 2.3) < 1e-10);

const { field } = await (await evidence({
  action: "source", runId: "FLEX-004", fieldKey: "extinction_diameter",
})).json();
assert.equal(field.value, null);
assert.match(field.locator, /CSV row 5, column L/);

const question = "How do the recorded pressures compare?";
for (const [format, extension] of [["json", "json"], ["csv", "csv"], ["brief", "html"]]) {
  const download = await evidence({ action: "export", format, question, selection, search });
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (format === "json") {
    const exported = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(exported.datasetSha256, overview.datasetSha256);
    assert.deepEqual(exported.comparison.rows, comparison.rows);
    assert.deepEqual(exported.search, search);
  }
  const file = `fire-evidence-brief.${extension}`;
  await writeFile(file, bytes);
  console.log(`Wrote ${file}`);
}
```

The pressure difference between `FLEX-001` and `FLEX-004` is 2.3 mmHg. The source locator points to the CSV cell where the diameter for `FLEX-004` is unknown. The search describes how the example located one run. The explicit selection determines which runs are compared and exported.

## Request reference

`GET /api/health` checks readiness. `GET /api/evidence` returns the run count, sources, provenance, dataset and rule identities, and an `aiEnabled` configuration flag.

Send one action per `POST /api/evidence` request with `Content-Type: application/json`. Request bodies are limited to 64 KiB.

| Action | Fields |
| --- | --- |
| `search` | `search` with optional `query`, `investigation` and `filters`. Filters use known field keys and typed values. Use JSON `null` to match unknown values. |
| `run` | `runId` |
| `source` | `runId`, `fieldKey` |
| `compare` | `selection: { runIds }` with two or three distinct run IDs |
| `rank` | `referenceRunId` and optional `search`. Candidates include condition statuses, coverage counts, score and ranking-rule revision. |
| `propose-filters` | `question`, `ai: true` |
| `explain` | `question`, `selection`, `ai: true` |
| `chat` | `ai: true`, `question`, and optional `runIds`, `history`, and `historyRunIds` |
| `export` | `selection`, `format` of `json`, `csv` or `brief`, and optional `question`, `search` and `explanationReceipt` |

Ranking scores the fraction of comparable recorded conditions that match exactly. Unknown and incompatible fields are counted separately. Results sort by score, comparable-field count, then run ID. Matching conditions alone cannot establish scientific equivalence.

Exports include dataset and comparison-rule identity, selected evidence and source locations. JSON preserves typed data. CSV repeats run and query identity and stores full provenance and any explanation JSON in the first row. Formula-like text is prefixed for spreadsheet safety. The printable brief is a standalone HTML download.

## Chat requests and exports

Send one turn to `POST /api/evidence` with `action: "chat"` and `ai: true`. Existing action payloads are unchanged.

| Field | Contract |
| --- | --- |
| `question` | Current user message, trimmed, up to 500 characters. Keep it separate from history. |
| `runIds` | Optional ordered workspace selection of zero to three distinct canonical FLEX IDs. Omitted means empty. Explicit known IDs in the current question take precedence. |
| `history` | Optional recent suffix of up to eight earlier messages, oldest first. Each has `role: "user"` or `"assistant"` and `content`. Trim content to 500 characters per message and 2,000 total. |
| `historyRunIds` | Optional ordered IDs for the prior evidence turn's workspace scope, using the same format as `runIds`. A changed scope can make short follow-ups ambiguous. |

The browser keeps the transcript in the current tab session for reload recovery and sends bounded history with each request. DeepSeek receives the recent user and assistant messages in order for general conversation, so it can respond to requests to clarify or revise its previous answer. The share link carries comparison state. Previous assistant prose stays outside the trusted evidence and action context.

| Response kind | Payload |
| --- | --- |
| `conversation` | Plain-text `reply`, with `model` metadata only for provider-backed conversation. |
| `clarification` | Plain-text `reply` asking for context or suggesting a next step. |
| `explanation` | `result` with resolved `question`, ordered `runIds`, packet, citations, provenance, and any signed `explanationReceipt`. A record question can use one run. A comparison still requires two or three. |
| `proposal` | `result` with proposed filters. Applying them requires a separate user action. |

For a signed export of an explanation, send `action: "export"`, the desired `format`, `question: result.question`, `selection: { runIds: result.runIds }`, and `explanationReceipt: result.explanationReceipt`. The receipt binds the validated answer and evidence revision to the resolved question and exact run order. Use the result values even if the draft or current selection has changed. A mismatched receipt returns HTTP 409. Exporting the signed answer makes no additional provider request. Conversation and clarification replies have no evidence receipt.

Greetings, app help and coverage questions have local responses. A chat action can dispatch at most one DeepSeek request. Existing API error responses and provider availability and quota controls apply.

## Optional DeepSeek configuration

For local use, copy `.env.example` to `.env.local` in the repository root if it does not already exist. Set the API key privately in that file. Keep `.env.local` out of version control and keep the key server-side. Restart the server after changing settings.

| Variable | Setting |
| --- | --- |
| `DEEPSEEK_API_KEY` | Set to your DeepSeek API key. Keep the value out of browser code, logs and shared files. |
| `DEEPSEEK_ENABLED` | Defaults to disabled. Set exactly `true` to permit provider calls. |
| `DEEPSEEK_BASE_URL` | Defaults to `https://api.deepseek.com`. The adapter accepts the official API origin with an optional `/v1` path. |
| `DEEPSEEK_MODEL` | Defaults to `deepseek-flash`. The adapter also accepts `deepseek-v4-pro`. |
| `DEEPSEEK_TIMEOUT_MS` | Defaults to `12000`. Accepts integers from 1 through 30000 milliseconds. |

### Hosted opt-in

The initial public deployment can run with DeepSeek disabled. To enable hosted calls, configure `DEEPSEEK_REQUIRE_ATTEMPT_BUDGET=true`, `DEEPSEEK_MODEL=deepseek-flash`, and the server-only `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Use the same single-primary Redis database for all environments allowed to spend from the same release budget. Use a token with write permission.

Seed `fire-evidence-explorer:deepseek:remaining-attempts` once with the approved positive integer allowance and no expiry.

```text
SET fire-evidence-explorer:deepseek:remaining-attempts <approved-allowance> NX
```

Store `DEEPSEEK_API_KEY` in the intended environment's server-side secret store and set `DEEPSEEK_ENABLED=true` when the budget is ready. Create a deployment with the updated settings and verify a bounded call before enabling public AI. Each outbound attempt consumes one shared reservation. Exhaustion returns HTTP 429. Missing, invalid or unavailable budget state blocks provider calls with HTTP 503. Deterministic features remain available.

Each AI request requires `ai: true`. Review proposed filters before sending the selected filters to `search`. Explanations send the question and a bounded packet of selected evidence to DeepSeek. If an explanation succeeds, pass its `explanationReceipt` to `export` with the same question and the same ordered run IDs. Export reuses the signed result without calling DeepSeek again. A mismatched receipt returns HTTP 409. Key rotation invalidates receipts. Omit the receipt to export deterministic evidence.

`aiEnabled: true` means that the flag is enabled and the server has a nonblank key. Live availability requires a successful provider request. AI requests return HTTP 503 when disabled or when the server configuration is incomplete or invalid.

## Verification

After `npm run build`, run `node tests/evidence-api.nasa.mjs` to smoke-test the production build on a local loopback port with DeepSeek disabled. This covers search, source lookups, comparisons, all three export formats and AI-disabled behavior. The automated provider tests use injected responses.

A separate live request through a local production build returned HTTP 200 with a validated `deepseek-flash` explanation for `FLEX-001`, `FLEX-004` and `FLEX-005`. The check resolved citations to NASA source cells and verified the explanation receipt. A preceding attempt returned HTTP 502 for an invalid response. Hosted AI qualification and public availability require deployment-specific verification.
