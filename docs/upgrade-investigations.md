# Guided investigations (U08-A/r1 + U09.1)

Status: the three U08.1–U08.5 guide definitions are integrated into the workbench
by U09.1–U09.4. The Notebook view's **Prepared investigations** card now lists
the guides, reports the dataset mismatch state, and opens an unsaved draft from
the active parsed public corpus. This document describes the integrated
workflow and the checks that were actually run in this packet. It is not a live
deployment claim. U09.5 background browser acceptance and U09.6 GitHub CI belong
to Codex after delivery. U08.6 private media and handoff work also belongs to
Codex. Codex owns GitHub, Vercel, hosted settings, quota, production, release and
submission.

The application description and existing documentation structure are unchanged;
this page is the documented upgrade journey for the three deterministic
investigations.

## What the guided journey is

A guide is a typed, corpus-pinned definition: a stable ID, title, question, an
ordered list of bounded plot/comparison steps, the relevant axes and scopes, and
explicit scientific limitations. Opening a guide rebuilds every plotted point,
comparison status, native delta and gas-composition row from the supplied
dataset through the accepted U03/U04/U05 helpers. It does not copy stored facts
from an earlier corpus.

The chain is:

```
guide definition -> openGuidedInvestigation -> immutable notebook-1 steps
                -> exportNotebookJson -> re-importable JSON
                -> renderPrintableNotebookHtml -> printable report
```

Opening is distinct from saving. `openGuidedInvestigation` returns a new
notebook value and never calls browser storage, a server route, a provider or a
signing key. Saving remains the existing explicit
`saveNotebookToStorage` action. The three guides require no AI attempt and no
server write.

## Notebook entry point (U09.1)

The Notebook view renders a **Prepared investigations** card. It imports the
accepted guide listing (`listGuidedInvestigations`) and corpus report
(`guidedInvestigationDatasetReport`), then opens a selected guide through
`openGuidedInvestigation` using the parsed public corpus passed to the
workbench.

- The card shows the pinned corpus version and source ID. If the active corpus
  version or pinned source does not match, the report message is shown and the
  open buttons are disabled; the current draft is left unchanged.
- Each entry shows the guide title, summary, ordered run IDs, step count and
  pinned corpus. **Open as unsaved draft** rebuilds every immutable step from
  the current corpus and installs it in the notebook view. No storage write
  occurs at this point.
- If the current notebook draft has unsaved changes, the app asks before
  replacing it. Cancelling the prompt preserves the draft.
- Save notebook on this device, Reopen saved notebook, Import JSON, Export JSON
  and Print report remain the normal notebook controls. Saving stays explicit,
  and opening or exporting a guide consumes zero AI calls.
- Personal notes, questions and conversation text are not written to URL state.

## The three guides

| Guide ID | Question | Ordered runs | Steps |
| --- | --- | --- | --- |
| `burn-time-condition-differences` | How do the recorded burn times of FLEX-001 and FLEX-004 differ, and which recorded conditions differ for the same pair? | FLEX-001, FLEX-004 | burn-time point-comparison plot; selected-runs comparison |
| `missing-burning-rate` | Which comparison does FLEX-014's missing burning rate prevent, and what can still be compared with FLEX-013? | FLEX-013, FLEX-014 | burning-rate plot; burn-time plot; selected-runs comparison |
| `visible-flame-extinction` | What do the reviewed records support about visible flame extinction across different test-end labels? | FLEX-001, FLEX-002, FLEX-020, FLEX-025 | extinction-diameter plot; two selected-runs comparisons |

All plots use `plot-spec-1` with an explicit run scope and `grouping: "none"`.
A `point-comparison` plot has one native-unit measurement axis; the categorical
axis is run identity, not a test-end score. All comparisons use
`comparison-context-request-1` selected-runs requests with the ordered run list
shown above. The complete four-field gas group
(`oxygen`, `nitrogen`, `carbon_dioxide`, `helium`) is retained in every
comparison result.

### Burn time and recorded conditions

Verified corpus values:

| Field | FLEX-001 | FLEX-004 | Native delta (later minus earlier) |
| --- | --- | --- | --- |
| Burn time | 4.3 s | 7.64 s | +3.34 s |
| Ambient pressure | 757.7 mmHg | 760 mmHg | +2.3 mmHg |
| Initial droplet diameter | 1.69 mm | 2.06 mm | +0.37 mm |
| Burning rate | 0.52 mm²/s | 0.6 mm²/s | +0.08 mm²/s |
| Visible-extinction diameter | 0.89 mm | null (unknown) | not computed |
| Test end | Disruption | Extinction | categorical difference |
| Fuel / gas group | Methanol; O₂ 0.21, N₂ 0.79, CO₂ 0, He 0 | Methanol; O₂ 0.21, N₂ 0.79, CO₂ 0, He 0 | linked group recorded; no difference |

The comparison statuses are `different` for burn time, pressure, diameter,
burning rate and test end; `same` for fuel and each gas fraction; and `unknown`
for the visible-extinction diameter. FLEX-004's null cell is not zero.

Exact source anchors:

- FLEX-001 burn time: `PSI-69_Experimental table_FLEX.csv, CSV row 2, column N (Burn time; s), FLEX Test #1 (20CAL08)`
- FLEX-004 burn time: `PSI-69_Experimental table_FLEX.csv, CSV row 5, column N (Burn time; s), FLEX Test #4 (30CAL02)`
- FLEX-004 visible-extinction diameter: `PSI-69_Experimental table_FLEX.csv, CSV row 5, column L (Visible flame extinction diameter; mm), FLEX Test #4 (30CAL02)`

### A missing burning rate

FLEX-014 records `null` for burning rate. The burning-rate point-comparison plot
includes FLEX-013 at 0.49 mm²/s and omits FLEX-014 with the frozen reason
`missing-y`; there is no zero point. The selected-runs comparison reports
`burning_rate` as `unknown` with cells `[0.49, null]` and no native delta. It also
reports `burn_time` as `different` with a recorded delta of +0.5 s, and
`extinction_diameter` as `unknown` because both cells are null.

Conditions for the pair: both Methanol; pressure 2074.2 vs 2055.6 mmHg
(−18.6 mmHg); initial diameter 2.59 vs 3.7 mm (+1.11 mm); O₂ 0.21, N₂ 0.09,
CO₂ 0.7, He 0 for both; test end Extinction for both. The missing burning rate
prevents a recorded burning-rate comparison; it does not mean a zero rate and it
does not make the burn-time comparison a substitute measurement.

Exact source anchors:

- FLEX-013 burning rate: `PSI-69_Experimental table_FLEX.csv, CSV row 14, column M (Burning rate; mm), FLEX Test #13 (256R002)`
- FLEX-013 burn time: `PSI-69_Experimental table_FLEX.csv, CSV row 14, column N (Burn time; s), FLEX Test #13 (256R002)`
- FLEX-014 burning rate: `PSI-69_Experimental table_FLEX.csv, CSV row 15, column M (Burning rate; mm), FLEX Test #14 (256F007)`
- FLEX-014 burn time: `PSI-69_Experimental table_FLEX.csv, CSV row 15, column N (Burn time; s), FLEX Test #14 (256F007)`

### Visible flame extinction

The four plotted recorded diameters are FLEX-001 0.89 mm (Disruption),
FLEX-002 0.94 mm (Extinction), FLEX-020 1.56 mm (Completion) and
FLEX-025 0.59 mm (Completion). The FLEX-001/FLEX-002 comparison reports
`extinction_diameter` as `different` (+0.05 mm) and test end as `different`.
The FLEX-020/FLEX-025 comparison reports `extinction_diameter` as `different`
(−0.97 mm), test end as `same` (Completion), oxygen as `different`
(0.34 → 0.30 mole fraction, −0.04) and nitrogen as `different`
(0.66 → 0.70, +0.04). Carbon dioxide and helium are recorded as 0 for both, not
unknown.

Across the selected subset, 12 of 31 runs record a visible-extinction diameter;
19 store `null`. Thirteen runs carry the test-end label Extinction, and 7 of
those 13 record an extinction diameter; conversely, 5 runs with a non-Extinction
label record one. The test-end label and the presence of this measurement are
therefore not interchangeable facts.

Exact source anchors:

- FLEX-001: `PSI-69_Experimental table_FLEX.csv, CSV row 2, column L (Visible flame extinction diameter; mm), FLEX Test #1 (20CAL08)`
- FLEX-002: `PSI-69_Experimental table_FLEX.csv, CSV row 3, column L (Visible flame extinction diameter; mm), FLEX Test #2 (20CAL10)`
- FLEX-020: `PSI-69_Experimental table_FLEX.csv, CSV row 21, column L (Visible flame extinction diameter; mm), FLEX Test #20 (192F001)`
- FLEX-025: `PSI-69_Experimental table_FLEX.csv, CSV row 26, column L (Visible flame extinction diameter; mm), FLEX Test #25 (191R001)`

## Dataset identity and mismatch behavior

The guides are pinned to dataset version `flex-psi69-v5-table-v1-subset-1` and
source ID `psi-69-flex-table-v1`. `data/flex.sources.json` records the full
identity for that corpus:

- dataset file `flex.json`, SHA-256 `df399d7bfef9713add4ffed79c09948992eb7afe6c7670ab28dfce88b9b0477a`
- source CSV `PSI-69_Experimental table_FLEX.csv`, SHA-256 `37c88ce8ae9391b7544ff630a45ce87543d04d317cdbfbed104fe7d5c27e1b96`
- source version PSI-69 investigation 5, CSV file 1; CC0-1.0

The `notebook-1` contract carries the dataset version and stable source
references; the full hashes remain in the manifest and the print report names
the exact corpus supplied for locator resolution.

`guidedInvestigationDatasetReport(dataset)` returns the pinned/actual version,
source presence and a message when they do not match. `openGuidedInvestigation`
returns a structured `dataset-mismatch` failure with both versions instead of
relabelling the guide or reusing facts from another corpus. A missing pinned
source is reported the same way, because source references could not be
grounded.

## Library interface

Import the module directly; the shared `index.ts` contract is unchanged:

```ts
import {
  guidedInvestigationDatasetReport,
  listGuidedInvestigations,
  openGuidedInvestigation,
  exportGuidedInvestigation,
} from "../src/lib/upgrades/guided-investigations.ts";
```

| Export | Purpose |
| --- | --- |
| `guidedInvestigationsDatasetVersion` | Pinned dataset version |
| `guidedInvestigationsSourceId` | Pinned source ID |
| `guidedInvestigations` / `listGuidedInvestigations()` | Frozen typed listing, in stable order |
| `getGuidedInvestigation(guideId)` | One frozen definition or `undefined` |
| `guidedInvestigationDatasetReport(dataset)` | Compatibility/mismatch report |
| `openGuidedInvestigation(dataset, guideId, options)` | Builds the immutable notebook, step facts, ordered source references and resolved source anchors; never saves |
| `exportGuidedInvestigation(dataset, guideId, options)` | Builds the accepted JSON export and printable report; never downloads, prints or saves |

`openGuidedInvestigation` options:

- `notebookId`: caller-supplied identity. When omitted, a namespaced ID is
  generated with `crypto.randomUUID` when available, otherwise a time/random
  fallback, bounded to the notebook identifier limit.
- `openedAt`: caller-supplied ISO date-time applied to the notebook and every
  step; defaults to the current time.
- `updatedAt`: optional notebook update time; defaults to `openedAt` and must not
  precede it.

Step IDs are deterministic (`bt-1-burn-time`, `mr-3-context`, and so on). The
accepted notebook helpers deep-freeze every step, so later workspace edits cannot
rewrite a snapshot. The guide definitions themselves are validated and frozen at
module load.

`exportGuidedInvestigation` adds `filename` and `generatedAt` options. The JSON
is exactly the accepted portable `notebook-1` document from
`exportNotebookJson`; the report is the standalone, script-free document from
`renderPrintableNotebookHtml`, with `datasets: [dataset]` so locators are
re-resolved only against the exact corpus.

Example (the browser entry point uses the same helper):

```ts
import { readFile } from "node:fs/promises";
import { parseDataset } from "../src/lib/evidence.ts";
import {
  exportGuidedInvestigation,
  openGuidedInvestigation,
} from "../src/lib/upgrades/guided-investigations.ts";

const dataset = parseDataset(JSON.parse(await readFile("data/flex.json", "utf8")));
const opened = openGuidedInvestigation(dataset, "burn-time-condition-differences", {
  notebookId: "guide-burn-time-demo",
  openedAt: "2025-01-16T09:00:00+08:00",
});
if (!opened.ok) throw new Error(opened.message);

// Explicit save is a separate action:
// saveNotebookToStorage(storage, opened.notebook);

const exported = exportGuidedInvestigation(dataset, "burn-time-condition-differences", {
  notebookId: "guide-burn-time-demo",
  openedAt: "2025-01-16T09:00:00+08:00",
});
if (!exported.ok) throw new Error(exported.message);
const jsonText = exported.json.text;
const printableHtml = exported.printableHtml;
```

The browser/data layer must parse the corpus with `parseDataset`; the guide
helper does not import the filesystem, `node:crypto`, a provider client or the
application route.

## Export and print journey

1. Open the guide and review the immutable steps. Opening does not save.
2. Save explicitly through the existing notebook storage helper when required.
3. Export `notebook-1` JSON through `exportNotebookJson`. The document keeps
   the dataset version, ordered steps, values, source references and
   limitations. Import it again with `importNotebookFromText` (or
   `importNotebookFromBytes`) and the exact dataset for membership/source
   checks; imported content remains `not-verified`.
4. Render the printable report through `renderPrintableNotebookHtml`, passing
   the exact dataset. The report shows corpus versions, re-resolved source
   locators, native units, deltas, the complete gas group, unknown values and
   the limitations. It emits no script, remote image, stylesheet or link.

A representative JSON export built from the real corpus is about 35 KB for the
two-step burn-time guide; the report is a static HTML document. The integrated
notebook view hands these products to its normal download, print and save
controls; the U09 integration test verifies the JSON/import round-trip and the
print-report properties.

## Scientific limits

- A comparison describes differences in recorded fields within this curated
  FLEX subset. Matching or differing values cannot establish scientific
  equivalence or a causal conclusion.
- Unrecorded conditions may affect outcomes. The guides never infer a cause from
  a condition difference.
- `null` is unknown. An unknown value is omitted from a plot axis that requires
  it, stays `unknown` in a comparison and never counts as a match. A recorded
  zero remains a value.
- The complete gas group is linked. Inspecting oxygen alone does not establish
  an isolated oxygen effect; guide comparisons retain all four fractions.
- A visible-extinction diameter is a droplet diameter at visible flame
  extinction, not a generic final size. Appendix A.1 notes that some values were
  estimated from burning history; the selected PSI columns do not identify
  individual estimates.
- Test-end labels describe how a test ended; they are not a quality or numeric
  outcome ranking and do not by themselves establish whether a visible
  extinction measurement was recorded.
- Units are native: mmHg, mole fraction, mm, mm²/s and s. No conversion is
  applied. Table IX establishes burning rate as mm²/s even though the literal
  CSV header reads `Burning rate; mm`.

## How to open and export in the workbench

1. Open the **Notebook** workspace action (or follow a pinned step) and find
   **Prepared investigations** in the right column.
2. The card lists the three guides with their title, summary, ordered run IDs,
   step count and pinned corpus. The pinned corpus version and source ID are
   shown above the list. If the active corpus version or pinned source does not
   match, the exact mismatch message is displayed and the open buttons are
   disabled.
3. Choose **Open as unsaved draft**. If the current draft has unsaved changes, a
   confirmation asks before replacing it. The guide rebuilds every ordered step
   from the active parsed corpus and opens the resulting notebook draft. Nothing
   is written to storage at this point.
4. Review the steps, source references, gas composition, unknown values and
   limitations. Use **Save notebook on this device** when you choose. Reopen
   saved notebook, Import JSON, Export JSON and Print report are the normal
   notebook controls and keep their existing version/import safety behavior.
5. Opening, reviewing and exporting a guide consume zero AI calls. Imported
   content remains `not-verified`. Personal notes, questions and conversation
   text stay out of public URLs.

## Optional AI action planning

The assistant exposes a separate explicit **Plan with AI** action. It uses one
bounded `POST /api/assistant-action` request and the existing guarded DeepSeek
adapter/reservation; it is not used by guide opening, guide export, card review
or any deterministic workspace engine. The route validates the request size,
question, action context, run membership and public corpus identity before
provider work, forwards cancellation, and returns only a typed outcome. A
`proposed` result must pass the browser wrapper's response validation, then a
fresh local recheck of the current corpus, workspace, turn and ordered selection
before it is registered with the action lifecycle. The card starts in the
`proposed` phase and requires the same local confirmation as other actions.
Disabled, quota-exhausted, cancelled, invalid and stale outcomes register no
card, and manual Send/local intents remain usable.

## What was verified in this packet

Commands were run in the candidate directory on Node 24.14.1. The npm cache was
written under the delivery folder, outside the candidate, and removed after the
checks:

| Check | Command | Result |
| --- | --- | --- |
| Dependencies | `npm ci --ignore-scripts --no-audit --no-fund --cache <delivery>/npm-cache` | 28 packages installed; no install scripts |
| Typecheck | `npm run typecheck` | passed with no diagnostics |
| Focused guide test | `node --test --test-isolation=none tests/upgrade-guided-investigations.test.mjs` | 8 passed, 0 failed |
| Focused U09 test | `node --test --test-isolation=none tests/upgrade-u09-integration.test.mjs` | 9 passed, 0 failed |
| Full Node suite | `node --test --test-isolation=none` | 148 passed, 0 failed |
| Production build | `npm run build` | Next compiled successfully; its TypeScript worker then hit the confined-sandbox `spawn EPERM` boundary. `npm run typecheck` passed separately. |

The focused U09 test loads the real bundled `data/flex.json` and
`data/flex.sources.json`. It checks that a guide opens without storage reads or
writes, that an explicit save is the first write, that reload and JSON export/
import round-trip the immutable steps, that the FLEX-001/FLEX-004 comparison
carries +3.34 s and the unknown extinction cell, that the missing burning rate
is omitted with `missing-y` and stays `unknown`, and that the complete gas group
is retained. It also exercises the new route with a fake provider transport:
request bounds, dataset identity, unknown-run rejection before provider work,
one fake call for a valid proposal, response binding, wrapper rejection of a
tampered response, stale/cancelled suppression, provider-disabled and
budget-exhausted results, and manual local actions remaining available. No live
provider, Upstash, GitHub, Vercel or browser call was made.

U09.5 background browser acceptance and U09.6 GitHub CI belong to Codex after
delivery. The default browser journey to verify at desktop and compact widths is:
open Notebook → Prepared investigations → choose a guide → confirm/replace the
draft if prompted → review steps and sources → Save → reload/Reopen → Export
JSON/Print report; then in the assistant, use Plan with AI, review the proposed
card, confirm it once, and verify that a disabled/quota/cancelled path leaves
Send and the local plot/compare/pin intents usable.

## Boundaries

- U08 write scope: `src/lib/upgrades/guided-investigations.ts`,
  `tests/upgrade-guided-investigations.test.mjs`, `README.md` and this page.
- U09 write scope: the workbench/assistant/notebook files, the new planner
  client/API/route, `tests/upgrade-u09-integration.test.mjs`, and this page plus
  `README.md`.
- Shared engine contracts, the source corpus, lockfiles, existing signed-evidence
  behavior, other candidates and unrelated paths were not changed.
- U09.5 browser acceptance and U09.6 CI are Codex work. U08.6 private
  media/handoff is Codex work. Codex owns Git/GitHub, Vercel, hosted settings,
  quota, production, release and submission.
