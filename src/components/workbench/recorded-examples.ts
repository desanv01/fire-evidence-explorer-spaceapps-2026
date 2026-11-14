import type { EvidenceExplanation } from "../../lib/evidence-client";

type Claim = EvidenceExplanation["explanation"]["claims"][number];

export type RecordedExample = {
  id: string;
  question: string;
  runIds: readonly string[];
  model: { requested: string; returned: string | null; promptVersion: string };
  recordedDate: string;
  datasetSha256: string;
  claims: readonly (Pick<Claim, "status" | "text" | "citationIds" | "measurements"> & {
    anchors: readonly { runId: string; fieldKey: string; locator: string }[];
  })[];
};

export const recordedExamples: readonly RecordedExample[] = [
  {
    "id": "same-fuel",
    "question": "Do the reference run and the comparison run use the same fuel? Give a brief qualitative answer and cite the recorded fuel evidence.",
    "runIds": [
      "FLEX-001",
      "FLEX-004"
    ],
    "recordedDate": "November 2026",
    "datasetSha256": "df399d7bfef9713add4ffed79c09948992eb7afe6c7670ab28dfce88b9b0477a",
    "model": {
      "requested": "deepseek-flash",
      "returned": "deepseek-flash",
      "promptVersion": "evidence-1"
    },
    "claims": [
      {
        "status": "reported",
        "text": "The recorded fuel entries list the same fuel for the reference run and the comparison run.",
        "citationIds": [
          "field:1"
        ],
        "measurements": [],
        "anchors": [
          {
            "runId": "FLEX-001",
            "fieldKey": "fuel",
            "locator": "PSI-69_Experimental table_FLEX.csv, CSV row 2, column E (Fuel), FLEX Test #1 (20CAL08)"
          },
          {
            "runId": "FLEX-004",
            "fieldKey": "fuel",
            "locator": "PSI-69_Experimental table_FLEX.csv, CSV row 5, column E (Fuel), FLEX Test #4 (30CAL02)"
          }
        ]
      },
      {
        "status": "inferred",
        "text": "Matching recorded fuel values do not by themselves establish scientific equivalence, since unrecorded conditions may affect outcomes.",
        "citationIds": [
          "field:1"
        ],
        "measurements": [],
        "anchors": [
          {
            "runId": "FLEX-001",
            "fieldKey": "fuel",
            "locator": "PSI-69_Experimental table_FLEX.csv, CSV row 2, column E (Fuel), FLEX Test #1 (20CAL08)"
          },
          {
            "runId": "FLEX-004",
            "fieldKey": "fuel",
            "locator": "PSI-69_Experimental table_FLEX.csv, CSV row 5, column E (Fuel), FLEX Test #4 (30CAL02)"
          }
        ]
      }
    ]
  }
];
