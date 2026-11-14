import frozenCorpus from "../../../../data/flex.json";
import provenance from "../../../../data/flex.sources.json";
import { comparisonRuleVersion, parseDataset } from "../../../lib/evidence.ts";
import { handleEvidenceRequest } from "../../../lib/evidence-api.ts";

export const runtime = "nodejs";

const dataset = parseDataset(frozenCorpus);
if (dataset.version !== provenance.datasetVersion) throw new Error("Dataset and manifest versions differ");

export function GET() {
  return Response.json({
    datasetVersion: dataset.version,
    datasetSha256: provenance.datasetSha256,
    comparisonRuleVersion,
    runCount: dataset.runs.length,
    investigations: [...new Set(dataset.runs.map(({ investigation }) => investigation))],
    sources: dataset.sources,
    provenance,
    aiEnabled: process.env.DEEPSEEK_ENABLED === "true" && Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  }, { headers: { "Cache-Control": "no-store" } });
}

export function POST(request: Request) {
  return handleEvidenceRequest(request, {
    dataset, datasetSha256: provenance.datasetSha256, datasetProvenance: provenance,
  });
}
