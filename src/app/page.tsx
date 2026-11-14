import frozenCorpus from "../../data/flex.json";
import manifest from "../../data/flex.sources.json";
import { parseDataset } from "../lib/evidence";
import { Workbench } from "../components/workbench/workbench";

const dataset = parseDataset(frozenCorpus);
if (dataset.version !== manifest.datasetVersion) throw new Error("Dataset and manifest versions differ");

/**
 * The public corpus is parsed on the server and passed to the client workbench
 * as serializable props. Provider credentials and server-only options stay in
 * the existing evidence route; the browser-safe upgrade engines read this
 * corpus only.
 */
export default function Home() {
  return <Workbench dataset={dataset} datasetSha256={manifest.datasetSha256} />;
}
