import { z } from "zod";
import type { Dataset, EvidenceSource, Run, RunField } from "../evidence.ts";
import { fieldKeySchema } from "./field-catalog.ts";
import { upgradeContractVersions } from "./versions.ts";

const nonBlank = z.string().min(1).max(400).refine((text) => text.trim().length > 0, "Expected non-blank text");
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const canonicalRunIdSchema = z.string().regex(/^FLEX-[0-9]{3}$/);
export type CanonicalRunId = z.infer<typeof canonicalRunIdSchema>;

export const datasetVersionSchema = z.string().trim().min(1).max(200);
export const sourceIdSchema = z.string().trim().min(1).max(128);

export const finiteNumberSchema = z.number().finite();
export const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
export const positiveFiniteNumberSchema = z.number().finite().positive();
export const datasetHashSchema = hash;

export function assertFiniteNumber(value: unknown, label = "value"): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

export const corpusValidationIssueSchema = z.strictObject({
  path: z.string().min(1).max(200),
  code: z.enum([
    "version-mismatch",
    "unknown-run",
    "unknown-field",
    "source-mismatch",
    "unknown-source",
    "duplicate-run",
    "unknown-filter-field",
    "invalid-filter-type",
    "invalid-value",
    "binding-mismatch",
  ]),
  message: z.string().min(1).max(300),
});
export type CorpusValidationIssue = z.infer<typeof corpusValidationIssueSchema>;

export function corpusIssue(
  path: string,
  code: CorpusValidationIssue["code"],
  message: string,
): CorpusValidationIssue {
  return { path, code, message };
}

/**
 * A stable identity for one recorded field. A display citation such as
 * `field:1` is deliberately not accepted here: it is local to one answer and
 * can mean a different field in another answer.
 */
export const stableFieldReferenceSchema = z.strictObject({
  datasetVersion: datasetVersionSchema,
  runId: canonicalRunIdSchema,
  fieldKey: fieldKeySchema,
  sourceId: sourceIdSchema,
});
export type StableFieldReference = z.infer<typeof stableFieldReferenceSchema>;

export type FieldReferenceResolution =
  | {
    status: "resolved";
    reference: StableFieldReference;
    run: Run;
    field: RunField;
    source: EvidenceSource;
  }
  | { status: "dataset-version-mismatch"; reference: StableFieldReference; actualDatasetVersion: string }
  | { status: "unknown-run"; reference: StableFieldReference }
  | { status: "unknown-field"; reference: StableFieldReference }
  | { status: "source-mismatch"; reference: StableFieldReference; actualSourceId: string }
  | { status: "unknown-source"; reference: StableFieldReference };

/**
 * Resolve a stable reference against the authoritative dataset. The raw
 * `field.value`/`field.original`/`field.locator` values come from that dataset;
 * callers must not reconstruct them from display text.
 */
export function resolveStableFieldReference(
  dataset: Dataset,
  reference: StableFieldReference,
): FieldReferenceResolution {
  if (dataset.version !== reference.datasetVersion) {
    return {
      status: "dataset-version-mismatch",
      reference,
      actualDatasetVersion: dataset.version,
    };
  }
  const run = dataset.runs.find(({ id }) => id === reference.runId);
  if (!run) return { status: "unknown-run", reference };
  const field = run.fields.find(({ key }) => key === reference.fieldKey);
  if (!field) return { status: "unknown-field", reference };
  if (field.sourceId !== reference.sourceId) {
    return { status: "source-mismatch", reference, actualSourceId: field.sourceId };
  }
  const source = dataset.sources.find(({ id }) => id === reference.sourceId);
  if (!source) return { status: "unknown-source", reference };
  return { status: "resolved", reference, run, field, source };
}

/** Stable string key for maps; the reference fields are ordered, not display text. */
export function stableFieldReferenceKey(reference: StableFieldReference): string {
  return JSON.stringify([
    reference.datasetVersion,
    reference.runId,
    reference.fieldKey,
    reference.sourceId,
  ]);
}

export function sameStableFieldReference(left: StableFieldReference, right: StableFieldReference): boolean {
  return stableFieldReferenceKey(left) === stableFieldReferenceKey(right);
}

export const displayCitationIdSchema = z.string().regex(/^(?:field|delta):[0-9]+$/);
export type DisplayCitationId = z.infer<typeof displayCitationIdSchema>;

/**
 * True for answer-local citation labels such as `field:1`. These may be
 * displayed but must never be used as cross-answer identities.
 */
export function isDisplayCitationId(value: string): value is DisplayCitationId {
  return displayCitationIdSchema.safeParse(value).success;
}

export const provenanceClassSchema = z.enum([
  "recorded-observation",
  "deterministic-derived",
  "generated-explanation",
  "personal-note",
]);
export type ProvenanceClass = z.infer<typeof provenanceClassSchema>;

export const provenanceClassMeta = {
  "recorded-observation": {
    label: "Recorded observation",
    evidence: "source-backed",
    description: "A value copied from the selected source cell.",
  },
  "deterministic-derived": {
    label: "Computed comparison",
    evidence: "deterministic",
    description: "A value calculated by a versioned, deterministic app operation from recorded inputs.",
  },
  "generated-explanation": {
    label: "Generated explanation",
    evidence: "unverified-prose",
    description: "Provider-generated prose; it is not a new measurement and schema conformance does not establish scientific support.",
  },
  "personal-note": {
    label: "Personal note",
    evidence: "not-evidence",
    description: "User-authored or imported text; it is never automatically verified evidence.",
  },
} as const satisfies Record<ProvenanceClass, {
  label: string;
  evidence: "source-backed" | "deterministic" | "unverified-prose" | "not-evidence";
  description: string;
}>;

export const deterministicOperationSchema = z.enum([
  "native-delta",
  "comparison-status",
  "plot-scope",
  "omission-accounting",
  "gas-composition-difference",
]);
export type DeterministicOperation = z.infer<typeof deterministicOperationSchema>;

export const deterministicValueSchema = z.strictObject({
  provenanceClass: z.literal("deterministic-derived"),
  operation: deterministicOperationSchema,
  ruleVersion: nonBlank,
  value: finiteNumberSchema,
  unit: z.string().min(1).max(64),
  inputs: z.array(stableFieldReferenceSchema).min(1).max(8),
  fromRunId: canonicalRunIdSchema.optional(),
  toRunId: canonicalRunIdSchema.optional(),
});
export type DeterministicValue = z.infer<typeof deterministicValueSchema>;

/** A recorded observation keeps its source identity and raw original text. */
export const recordedObservationSchema = z.strictObject({
  provenanceClass: z.literal("recorded-observation"),
  reference: stableFieldReferenceSchema,
  value: z.union([z.number().finite(), z.string().min(1), z.null()]),
  original: z.string().nullable(),
});
export type RecordedObservation = z.infer<typeof recordedObservationSchema>;

export const operationRuleVersionSchema = z.strictObject({
  operation: deterministicOperationSchema,
  ruleVersion: nonBlank,
});
export type OperationRuleVersion = z.infer<typeof operationRuleVersionSchema>;

export const ruleVersions = {
  stableFieldReference: upgradeContractVersions.stableFieldReference,
  provenance: "provenance-1",
  nativeDelta: "native-delta-1",
  gasComposition: "gas-composition-context-1",
  comparisonContext: "comparison-context-1",
  plotScope: "plot-scope-1",
  omissionAccounting: "plot-omission-1",
  receiptBinding: upgradeContractVersions.receiptBinding,
} as const;

export type ContractRuleVersions = typeof ruleVersions;
