import frozenCorpus from "../../../../data/flex.json";
import provenance from "../../../../data/flex.sources.json";
import { parseDataset } from "../../../lib/evidence.ts";
import { handleAssistantActionPlanRequest } from "../../../lib/upgrades/action-planning-api.ts";

export const runtime = "nodejs";

/**
 * The same authoritative parsed public corpus and manifest identity used by
 * `/api/evidence`. Provider credentials and provider options stay server-side.
 */
const dataset = parseDataset(frozenCorpus);
if (dataset.version !== provenance.datasetVersion) throw new Error("Dataset and manifest versions differ");

export function POST(request: Request) {
  return handleAssistantActionPlanRequest(request, {
    dataset,
    datasetSha256: provenance.datasetSha256,
  });
}
