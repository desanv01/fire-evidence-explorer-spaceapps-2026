# Upgrade shared contracts (U01-A / r1)

Status: candidate implementation for U01.1–U01.6. Codex owns U01.7 interface
acceptance/freeze and all GitHub, hosted-service and release actions.

These modules are additive, browser-safe contracts for the Visual Evidence Lab,
Comparison Context and Investigation Notebook. They do not render charts, run
the comparison engine, persist notebooks, call DeepSeek, or change the existing
explorer, sources, signed exports, corpus or application routes.

## Import points and ownership

Import from the index in browser/client code:

```ts
import {
  reviewedFieldCatalog,
  plotSpecSchema,
  runScopeSchema,
  comparatorRequestSchema,
  notebookSchema,
  assistantActionRequestSchema,
} from "../src/lib/upgrades/index.ts";
```

| Module | Main exports | Intended callers |
| --- | --- | --- |
| `src/lib/upgrades/versions.ts` | `upgradeContractVersions` | All upgrade modules and tests |
| `src/lib/upgrades/field-catalog.ts` | `reviewedFieldCatalog`/`fieldCatalog`, `fieldDefinitionSchema`, field-key schemas, `getFieldDefinition`, `isNumericFieldKey` | U03 axis/filter controls, U04 context, U06 actions, U07 UI |
| `src/lib/upgrades/provenance.ts` | `stableFieldReferenceSchema`, `resolveStableFieldReference`, provenance classes, finite-number schemas, `displayCitationIdSchema`, corpus issue type | U03/U04/U05/U06 and any exporter |
| `src/lib/upgrades/scope.ts` | `runScopeSchema`, `runSelectionSchema`, `comparisonRunIdsSchema`, `resolveRunScope`, `validateRunScopeAgainstDataset` | U03/U04/U06 |
| `src/lib/upgrades/plot.ts` | `plotSpecSchema`, `plotResultSchema`, `validatePlotSpecAgainstDataset`, `validatePlotResultAgainstDataset`, `resolvePlotScope` | U03 engine, U06 actions, U07 plot UI, U08 guides |
| `src/lib/upgrades/comparison-context.ts` | `selectedRunsContextRequestSchema`, `comparatorRequestSchema`, `selectedRunsContextResultSchema`, `comparatorSearchResultSchema`, validation helpers, gas-composition group | U04 engine, U06 actions, U07 context panel |
| `src/lib/upgrades/notebook.ts` | `notebookSchema`, `notebookStepSchema`, answer snapshot, import byte helper, version report/validation, answer binding/provenance/source-reference helpers | U05 engine, U06 save action, U07 notebook UI, U08 guides |
| `src/lib/upgrades/actions.ts` | `assistantActionRequestSchema`, `assistantActionRecordSchema`, action context/freshness/validation helpers, outcome union | U06 action registry/execution, U07 action cards |

U03–U08 workers own their engine, storage, action and UI files. They may import
these modules but do not change the contract files without a new DSH task. The
existing files in `src/lib/evidence*.ts` and `src/lib/deepseek.ts` remain owned
by their current code and are reused only through public types/functions.

No module under `src/lib/upgrades` imports `node:crypto`, `node:fs`, a provider
client, environment variables, or server signing code at runtime. The
`EvidenceExplanation` import in `notebook.ts` is type-only and erased.

## Reviewed field catalog

The catalog is closed for this revision. It records the exact labels,
condition/outcome classification and native units from `data/flex.json` at
`flex-psi69-v5-table-v1-subset-1`. Fuel is the only grouping. No conversion is
applied.

| Key | Label | Kind | Data type | Native unit | Axis eligible |
| --- | --- | --- | --- | --- | --- |
| `fuel` | Fuel | condition | categorical | — | no |
| `pressure` | Ambient pressure | condition | numeric | `mmHg` | yes |
| `oxygen` | Initial ambient oxygen | condition | numeric | `mole fraction` | yes |
| `nitrogen` | Initial ambient nitrogen | condition | numeric | `mole fraction` | yes |
| `carbon_dioxide` | Initial ambient carbon dioxide | condition | numeric | `mole fraction` | yes |
| `helium` | Initial ambient helium | condition | numeric | `mole fraction` | yes |
| `diameter` | Initial droplet diameter | condition | numeric | `mm` | yes |
| `extinction_diameter` | Droplet diameter at visible flame extinction | outcome | numeric | `mm` | yes |
| `burning_rate` | Burning rate | outcome | numeric | `mm²/s` | yes |
| `burn_time` | Burn time | outcome | numeric | `s` | yes |
| `test_end` | Test end | outcome | categorical | — | no |

Allowed values are `Methanol`/`Heptane` for `fuel` and
`Disruption`/`Extinction`/`Completion` for `test_end`.

Numeric fields allow `plot-axis`, `filter`, `compare`, `source-inspect` and
`native-delta`; categorical fields allow `filter`, `compare`, `group` (fuel) and
`source-inspect`. Every definition records the same missing-value rule:

- JSON `null` means unknown.
- Zero is a real recorded value.
- A numeric axis omits a run with an unknown required value; the run is listed
  in `PlotResult.omitted`.
- An unknown value never counts as a comparison match.

Selected interpretation notes:

- `burning_rate`: Table IX of NASA/TP-2015-216046 establishes `mm²/s`; the
  literal PSI CSV header reads “Burning rate; mm”. The native unit is retained.
- `extinction_diameter`: this is a visible-flame-extinction diameter, not a
  generic final size. Appendix A.1 notes that some values were estimated from
  burning history; the selected PSI columns do not identify individual
  estimates.
- Gas fields (`oxygen`, `nitrogen`, `carbon_dioxide`, `helium`) are linked
  initial ambient mole fractions. Inspect all four together.
- `test_end` labels describe how a test ended; they are not a quality or
  numeric outcome ranking.

## Plot contracts

`PlotSpec` is versioned (`plot-spec-1`) and has two approved kinds:

- `scatter`: two different numeric axes.
- `point-comparison`: one numeric measurement axis; the categorical x position
  is run identity/order.

The scope is one of `all-reviewed-runs`, `filtered-results` (the existing
`RunSearchRequest` query/investigation/filters semantics) or `explicit-runs`.
Scope resolution is separate from the two/three-run comparison selection:
`resolvePlotScope` returns any number of resolved rows, while a comparison
selection is always two or three distinct valid runs. A single run can still be
inspected.

### Valid PlotSpec example

```json
{
  "version": "plot-spec-1",
  "kind": "scatter",
  "axes": {
    "x": { "field": "oxygen" },
    "y": { "field": "burning_rate" }
  },
  "grouping": "fuel",
  "scope": {
    "kind": "filtered-results",
    "search": {
      "filters": [{ "key": "fuel", "value": "Methanol" }]
    }
  }
}
```

Invalid axis keys, a categorical axis, equal scatter axes, a duplicate explicit
run ID, a non-finite coordinate, an uncounted omitted run or mismatched
included/omitted counts fail schema validation. Corpus validators separately
reject an explicit run absent from the active dataset.

A valid scope can resolve to zero rows. The empty result is schema-valid only
when `resolvedRunIds`, `points` and `omitted` are all empty and
`includedCount`/`omittedCount` are both zero. Explicit request scope still
requires at least one run ID, comparison selection remains two or three runs,
and notebook plot steps still require a resolved run. `buildPlotResult` returns
this zero-row result from its normal construction and validation path; a valid
empty scope is not an error, while invalid specs, unknown explicit runs,
incompatible axes/units and scope-limit overflow still raise typed failures.

### Valid PlotResult example (null omitted, zero retained)

```json
{
  "version": "plot-result-1",
  "specVersion": "plot-spec-1",
  "kind": "scatter",
  "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
  "axes": {
    "kind": "scatter",
    "x": "oxygen",
    "y": "burning_rate"
  },
  "grouping": "none",
  "scope": {
    "kind": "explicit-runs",
    "search": null,
    "activeFilters": []
  },
  "resolvedRunIds": ["FLEX-001", "FLEX-009"],
  "includedCount": 1,
  "omittedCount": 1,
  "points": [
    {
      "runId": "FLEX-001",
      "x": 0.21,
      "y": 0.52,
      "group": null,
      "sourceReferences": [
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-001",
          "fieldKey": "oxygen",
          "sourceId": "psi-69-flex-table-v1"
        },
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-001",
          "fieldKey": "burning_rate",
          "sourceId": "psi-69-flex-table-v1"
        }
      ]
    }
  ],
  "omitted": [
    { "runId": "FLEX-009", "reasons": ["missing-y"] }
  ],
  "limitations": [
    "Only runs with finite recorded values for each required axis are included; no value is interpolated."
  ]
}
```

FLEX-009 records `null` for `burning_rate`; it is omitted and counted. FLEX-001
records `0` for `carbon_dioxide`, which is a value, not an unknown. Source
references resolve raw `value`, `original` and `locator` from the authoritative
dataset through `resolveStableFieldReference`.

## Comparison Context contracts

`selectedRunsContextRequestSchema` covers ordered two/three-run context.
`comparatorRequestSchema` adds a reference run, a condition focus, a declared
candidate scope and an optional matching policy. Omitted `matching` means exact
matching.

A selected-run result must carry exactly the ordered `request.runIds`: the
arrays must have the same length and the same order. A comparison notebook step
applies the same invariant between `step.request.runIds` and
`context.runIds`. Extra or reordered runs are rejected even when every cell and
gas-composition row is internally consistent. Valid two- and three-run snapshots
remain accepted.

Tolerances are per numeric field, explicit, finite and non-negative. The schema
rejects a duplicated tolerance field and any categorical field key. A tolerance
is a search rule, not a validated equivalence threshold. Unknown values are
`unknown` and can never satisfy `same`.

Result fields are split into `conditions` and `outcomes`; each field has
`same` (matched), `different`, `unknown` or `incompatible`, ordered cells,
native-unit deltas and a reason. `contextStatusFromComparisonRow` keeps the
existing `ComparisonResult` status vocabulary rather than introducing a second
set of comparison statuses. `gasComposition` always contains all four gas
fields, their values for each displayed run and any composition differences
together. The literal limitation says gas fractions are linked and oxygen alone
does not establish an isolated effect.

Evidence entries use exactly these categories:

- `recorded-observation` — directly traceable to recorded fields.
- `computed-comparison` — deterministic calculation; must carry `ruleVersion`.
- `not-established` — unsupported causal or missing-evidence interpretation.

`comparatorSearchResultSchema.outcome` distinguishes
`eligible-match` from `no-eligible-match`; nearest candidates are never silently
presented as matches.

### Valid comparator request (exact default)

```json
{
  "version": "comparison-context-request-1",
  "kind": "comparator",
  "referenceRunId": "FLEX-001",
  "focusCondition": "pressure",
  "candidateScope": {
    "kind": "explicit-runs",
    "runIds": ["FLEX-002", "FLEX-005"]
  }
}
```

```json
{
  "version": "comparison-context-request-1",
  "kind": "comparator",
  "referenceRunId": "FLEX-001",
  "focusCondition": "diameter",
  "candidateScope": {
    "kind": "explicit-runs",
    "runIds": ["FLEX-004"]
  },
  "matching": {
    "mode": "tolerance",
    "tolerances": [{ "field": "pressure", "tolerance": 2.3 }]
  }
}
```

The focus condition is excluded from required matching by design. `FLEX-001`
and `FLEX-004` record diameters `1.69 mm` and `2.06 mm`; that difference remains
visible in the comparison context but does not block this focus search. The
required pressure condition is `757.7 mmHg` for FLEX-001 and `760 mmHg` for
FLEX-004, a difference of `2.3 mmHg`, so the inclusive `2.3 mmHg` tolerance
admits FLEX-004 while the other required conditions match exactly. The context
still reports pressure as `different`: a tolerance describes a search rule, not
scientific equivalence. Unknown values never match.

The exact-default request above uses `pressure` as its focus, so pressure is
excluded from required matching; exact matching applies to every other required
condition. It is a request shape only, not a claim that any candidate is
eligible.

## Notebook contracts

`notebookSchema` (`notebook-1`) contains an ID, title, question, timestamps,
declared `datasetVersions`, ordered immutable steps and separately labelled
notes. Steps are a discriminated union:

- `plot`: `plotSpec` + `plotResult`.
- `comparison`: selected-run context request + result.
- `evidence-answer`: a snapshot of the existing validated-answer shape,
  including packet, citations, claims, model/provenance and receipt.

Every step carries `datasetVersion`, ordered `resolvedRunIds`, query/filter
context, stable source references and limitations. Later workspace edits do not
rewrite existing step payloads.

Evidence-answer snapshots preserve `requestQuestion` exactly as submitted,
including surrounding spaces; validation is non-transforming and requires a
nonblank string within the submitted-question bound. The separate `question`
field remains server-trimmed. `answerSnapshotBindingMatches` still compares the
exact request text and ordered runs without changing receipt/signature semantics.

### Bounds chosen in this revision

| Bound | Value |
| --- | --- |
| Steps per notebook | 50 |
| Title | 160 characters |
| Question | 2,000 characters |
| Submitted requestQuestion | 500 characters, nonblank, preserved without trimming |
| Each note | 4,000 characters |
| Notes per notebook | 200 (chosen for this contract) |
| Source references per step | 256 |
| Limitations per step | 12, each 500 characters |
| Explicit runs in one scope | 128 |
| Comparison selection | 2 or 3 distinct runs |
| Single-run inspection | 1 run |
| Notebook import | 2 MiB (`2,097,152` bytes) |

`importMaxBytes` is a contract for U05. U05 must call
`assertNotebookImportBytes(byteLength)` after reading the file and before
`JSON.parse`; Zod alone cannot observe file bytes. The schema only limits the
optional import-envelope metadata.

### Version handling

`classifyNotebookDatasetVersion` and `notebookDatasetVersionReport` return:

- `same-version`: the step version equals the active dataset version.
- `historical-version`: the version differs but is available for exact-corpus
  validation.
- `unavailable-version`: only the stored snapshot remains.

`parseNotebook` is structural only. `validateNotebookAgainstDataset` checks only
steps whose referenced version equals the supplied dataset and skips historical
steps. Historical run/source identities are not rejected merely because a newer
active corpus does not contain them. An old snapshot is never silently relabelled
with a new corpus; a re-run must be a new step.

### Valid notebook example

```json
{
  "schemaVersion": "notebook-1",
  "id": "notebook-flex-1",
  "title": "Oxygen and burn rate",
  "question": "How does recorded oxygen relate to burning rate?",
  "createdAt": "2025-01-15T19:00:00+08:00",
  "updatedAt": "2025-01-15T19:30:00+08:00",
  "datasetVersions": ["flex-psi69-v5-table-v1-subset-1"],
  "steps": [
    {
      "stepId": "step-plot-1",
      "createdAt": "2025-01-15T19:05:00+08:00",
      "title": "Oxygen and burning rate",
      "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
      "resolvedRunIds": ["FLEX-001", "FLEX-002"],
      "query": { "search": null },
      "sourceReferences": [
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-001",
          "fieldKey": "oxygen",
          "sourceId": "psi-69-flex-table-v1"
        },
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-001",
          "fieldKey": "burning_rate",
          "sourceId": "psi-69-flex-table-v1"
        },
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-002",
          "fieldKey": "oxygen",
          "sourceId": "psi-69-flex-table-v1"
        },
        {
          "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
          "runId": "FLEX-002",
          "fieldKey": "burning_rate",
          "sourceId": "psi-69-flex-table-v1"
        }
      ],
      "limitations": [
        "A plot does not establish a trend or causation."
      ],
      "stepType": "plot",
      "plotSpec": {
        "version": "plot-spec-1",
        "kind": "scatter",
        "axes": {
          "x": { "field": "oxygen" },
          "y": { "field": "burning_rate" }
        },
        "grouping": "none",
        "scope": {
          "kind": "explicit-runs",
          "runIds": ["FLEX-001", "FLEX-002"]
        }
      },
      "plotResult": {
        "version": "plot-result-1",
        "specVersion": "plot-spec-1",
        "kind": "scatter",
        "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
        "axes": {
          "kind": "scatter",
          "x": "oxygen",
          "y": "burning_rate"
        },
        "grouping": "none",
        "scope": {
          "kind": "explicit-runs",
          "search": null,
          "activeFilters": []
        },
        "resolvedRunIds": ["FLEX-001", "FLEX-002"],
        "includedCount": 2,
        "omittedCount": 0,
        "points": [
          {
            "runId": "FLEX-001",
            "x": 0.21,
            "y": 0.52,
            "group": null,
            "sourceReferences": [
              {
                "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
                "runId": "FLEX-001",
                "fieldKey": "oxygen",
                "sourceId": "psi-69-flex-table-v1"
              },
              {
                "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
                "runId": "FLEX-001",
                "fieldKey": "burning_rate",
                "sourceId": "psi-69-flex-table-v1"
              }
            ]
          },
          {
            "runId": "FLEX-002",
            "x": 0.21,
            "y": 0.6,
            "group": null,
            "sourceReferences": [
              {
                "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
                "runId": "FLEX-002",
                "fieldKey": "oxygen",
                "sourceId": "psi-69-flex-table-v1"
              },
              {
                "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
                "runId": "FLEX-002",
                "fieldKey": "burning_rate",
                "sourceId": "psi-69-flex-table-v1"
              }
            ]
          }
        ],
        "omitted": [],
        "limitations": [
          "Only runs with finite recorded values for each required axis are included; no value is interpolated."
        ]
      }
    }
  ],
  "notes": [
    {
      "noteId": "note-1",
      "text": "Check the complete gas composition before interpreting oxygen.",
      "classification": "personal-note",
      "verifiedEvidence": false,
      "createdAt": "2025-01-15T19:10:00+08:00",
      "updatedAt": "2025-01-15T19:10:00+08:00"
    }
  ]
}
```

## Assistant action contracts

`assistantActionRequestSchema` is an allowlisted discriminated union of exactly
four operations:

- `create_plot` — `plotSpecSchema`.
- `explain_comparison_context` — selected-run context request.
- `find_comparators` — comparator request.
- `prepare_notebook_step` — a validated notebook step.

Each request carries `actionId` and an `assistantActionContext` with workspace,
originating turn, dataset version, selected run IDs and selection revision.
`checkActionContext` reports structured stale reasons for workspace, turn,
dataset version, selection and selection revision. No arbitrary JavaScript,
HTML, SQL, URL, shell command or dynamic tool name is accepted.

`assistantActionRecordSchema` distinguishes `proposed`, `approved`, `executed`,
`failed` and `cancelled`. `prepare_notebook_step` is the only state-changing
action here and requires approval before execution; the other three are
read-only. Execution outcomes distinguish typed results from `unavailable`,
`invalid` and `stale-context`. Provider/quota failure therefore has a structured
result rather than generic prose.

### Valid create_plot action example

```json
{
  "version": "assistant-action-1",
  "actionId": "action-1",
  "context": {
    "workspaceId": "workspace-1",
    "turnId": "turn-4",
    "datasetVersion": "flex-psi69-v5-table-v1-subset-1",
    "selectedRunIds": ["FLEX-001", "FLEX-002"],
    "selectionRevision": 3
  },
  "kind": "create_plot",
  "plot": {
    "version": "plot-spec-1",
    "kind": "scatter",
    "axes": {
      "x": { "field": "oxygen" },
      "y": { "field": "burning_rate" }
    },
    "grouping": "none",
    "scope": {
      "kind": "explicit-runs",
      "runIds": ["FLEX-001", "FLEX-002"]
    }
  }
}
```

## Invalid, missing and stale behavior

- A schema parse checks structure only. `validatePlotSpecAgainstDataset`,
  `validateComparisonContextRequestAgainstDataset`,
  `validateActionAgainstDataset` and `validateNotebookAgainstDataset` perform
  membership/source checks against a supplied dataset.
- Unknown explicit run IDs fail corpus validators; dependent engines must not
  silently drop them.
- A stable reference whose dataset version differs returns
  `dataset-version-mismatch`, not a relabelled current value.
- `null` stays unknown and is never converted to `0` or omitted from the raw
  source reference. Zero remains a plotted/compared value.
- A notebook step from an old version is parsed and retained. Structural parsing
  does not validate it against a newer corpus; `validateNotebookAgainstDataset`
  reports `version-mismatch` when no step matches the supplied version.
- Comparator tolerances must be finite, non-negative and numeric. Categorical
  tolerances fail schema parsing. No eligible match is represented by the
  `no-eligible-match` outcome; nearest candidates remain separate.
- A stale assistant context is represented with explicit reasons; it is not
  retried against a later selection automatically.

## Composition, signed answers and notes

- Gas mole fractions are kept as fractions in their native unit. The complete
  composition group is mandatory in a selected-run context result. Composition
  differences are shown together; the contract does not assert an isolated
  oxygen effect.
- `field:1`/`delta:1` are answer-local display citation IDs, not stable
  cross-answer identities. Use `stableFieldReferenceSchema` for durable
  provenance.
- `explanationReceipt` is accepted only in the existing receipt string format.
  `receiptVerification` is always `"not-verified"`: a schema parse does not
  verify the signature. The existing server-side receipt validator/signing key
  remains authoritative and unchanged. No signing is added here.
- `answerSnapshotProvenanceClass` labels deterministic evidence-only answers
  separately from generated prose; neither label is a scientific verification.
- `answerSnapshotSourceReferences` converts answer-local citation sources into
  durable field references. Display IDs remain display IDs.
- A notebook content hash, if present in `integrity`, detects content
  differences only. It is not proof of correctness, authorship or scientific
  support.
- Personal notes have `classification: "personal-note"` and
  `verifiedEvidence: false`. Imported notebook documents carry a
  `"not-verified"` verification marker; imported text is not automatically
  evidence.

## Rule and contract versions

`upgradeContractVersions` stores: `field-catalog-1`, `run-scope-1`,
`stable-field-reference-1`, `plot-spec-1`, `plot-result-1`,
`comparison-context-request-1`, `comparison-context-result-1`,
`comparator-search-1`, `notebook-1`, `notebook-step-1`, `notebook-import-1`,
`assistant-action-1`, `receipt-binding-1`.

Deterministic operations also carry narrower rule versions:
`native-delta-1`, `comparison-context-1`, `plot-scope-1`,
`plot-omission-1`, `gas-composition-context-1` and `provenance-1`. Existing
`comparisonRuleVersion` from `src/lib/evidence.ts` is retained in comparison
results.

## Intentionally outside U01

- U03 computes plot points, omission reasons and plot/export payloads.
- U04 computes condition diffs, exact/tolerance matching, candidate eligibility
  and limitation cards.
- U05 implements local save/load, import validation (including the real byte
  gate), export/print and version-mismatch behavior.
- U06 wires provider actions, call limits, confirmation and fallback behavior.
- U07 renders the approved UI and action cards.
- U08 writes guided investigations and methodology copy.
- U09 connects modules and performs bounded integration checks.
- Codex U01.7 accepts/freezes interfaces; Codex owns GitHub, Vercel, hosted
  service, quota and release actions.

This document does not claim that any later-phase engine, UI, persistence or
provider behavior exists yet.
