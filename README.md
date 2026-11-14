# Fire Evidence Explorer

Fire Evidence Explorer is a research workbench for finding and comparing recorded microgravity combustion tests. Browse the NASA FLEX collection, rank runs by similarity of recorded conditions, compare two or three runs, and trace values to their source cells. Export the comparison and its provenance as an evidence brief.

## Run locally

Use Node.js 24 and npm. From the repository root, run:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000/` for the workbench. The [quickstart](docs/api-quickstart.md) shows the browser and API workflows. Use `/api/health` to check readiness and `/api/evidence` to see dataset coverage and revision information.

To verify the project from a clean install, run `npm run typecheck`, `npm test` and `npm run build`. See the [API quickstart](docs/api-quickstart.md#verification) for the production-build smoke test.

## Assistant

Ask for app help, find FLEX runs, or ask about recorded evidence. With live AI available, you can ask for a shorter explanation or clarification using the previous answer as context. Evidence follow-ups stay grounded in the relevant runs. If a reference is ambiguous or the workspace selection has changed, the assistant can ask which runs you mean. Review proposed filters before applying them.

The assistant also has an explicit **Plan with AI** action. It sends one bounded request to `/api/assistant-action`, using the same guarded DeepSeek adapter, attempt reservation and authoritative public corpus as the evidence route. The result can only be a read-only plot, comparison-context or comparator-search proposal, bound to the current workspace, turn, corpus and ordered selection. It is not applied until you confirm the typed card, and reviewing a card or its sources makes no further provider call. Normal Send, local manual intents (plot, compare, find comparators, pin) and prepared investigations remain available when AI is disabled or the shared attempt allowance is exhausted.

The transcript is kept in the current browser tab session and can be restored on reload. It is separate from the comparison share link. Use **New chat** or clear the conversation to reset it. A signed evidence export attaches the selected validated answer to its resolved question and ordered run IDs. General conversation stays outside signed evidence. See [chat requests and exports](docs/api-quickstart.md#chat-requests-and-exports).

## Guided investigations

Three reviewed investigations turn the workbench into a bounded guided journey: compare burn times and recorded conditions, follow a missing burning rate, and inspect visible flame extinction. Each guide names its ordered runs, axes and comparison scope, pins the FLEX dataset version and source, and rebuilds its plot points and comparison statuses from the bundled corpus.

The Notebook view's **Prepared investigations** card lists the three guides and their pinned corpus/source. If the active corpus does not match, the card shows the exact mismatch and disables opening. Choosing a guide opens an unsaved notebook draft. If the current draft has unsaved changes, the app asks before replacing it. Saving remains explicit, and the normal Save/Reopen/Import/Export/Print controls apply afterwards. Opening or exporting a guide consumes zero AI calls. Null values remain unknown and are never plotted or compared as zero. The exported notebook JSON and printable report retain the original dataset identity, source locators, limitations and complete comparison facts. See [guided investigations](docs/upgrade-investigations.md).

## DeepSeek

DeepSeek is optional and disabled by default. Search, ranking, comparison, source inspection and deterministic exports work with the default configuration. AI action planning is opt-in and uses the same guarded provider path and shared attempt reservation as filters and explanations; it never adds a second provider client or browser-side credential. A local production build returned a validated live DeepSeek explanation for a three-run FLEX comparison. Hosted activation requires a project-scoped shared attempt budget and verification on the deployed environment. [Configuration and verification](docs/api-quickstart.md#optional-deepseek-configuration)

## Dataset and limits

The dataset contains 31 consecutive FLEX tests, `FLEX-001` through `FLEX-031`, from NASA Physical Sciences Informatics (PSI) investigation PSI-69, version 5. The source is version 1 of the Experimental Table CSV, licensed CC0-1.0. The selected runs match the first page of Table IX. [NASA PSI record](https://psi.nasa.gov/physci/repo/data/investigations/PSI-69) · [Dataset DOI](https://doi.org/10.60555/mbq8-0451) · [NASA technical report](https://ntrs.nasa.gov/citations/20150023456)

The [dataset manifest](data/flex.sources.json) records exact source and dataset hashes, row selection, transformations and report locations. The [data notes](data/README.md) describe how to reproduce the import. Table IX supplies the burning-rate unit of mm²/s and resolves the abbreviated gas headers. Appendix A.1 describes estimated droplet diameters for some visible-extinction measurements. The selected CSV fields do not identify which values were estimated. A comparison describes differences in recorded fields within this subset. Matching fields cannot establish scientific equivalence.

The workbench displays and exports ambient pressure in mmHg and initial ambient oxygen as a mole fraction, using the units in NASA’s FLEX table. Normalized display options for these measurements are outside the scope of this release.
