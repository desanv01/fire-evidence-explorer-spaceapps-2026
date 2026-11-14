import { z } from "zod";
import { upgradeContractVersions } from "./versions.ts";

const nonBlank = z.string().min(1).max(400).refine((text) => text.trim().length > 0, "Expected non-blank text");

/**
 * The reviewed FLEX field keys. The catalog is intentionally closed: a field
 * outside this list cannot be plotted or compared by the upgrade contracts.
 */
export const fieldKeySchema = z.enum([
  "fuel",
  "pressure",
  "oxygen",
  "nitrogen",
  "carbon_dioxide",
  "helium",
  "diameter",
  "extinction_diameter",
  "burning_rate",
  "burn_time",
  "test_end",
]);
export type FieldKey = z.infer<typeof fieldKeySchema>;

export const numericFieldKeySchema = z.enum([
  "pressure",
  "oxygen",
  "nitrogen",
  "carbon_dioxide",
  "helium",
  "diameter",
  "extinction_diameter",
  "burning_rate",
  "burn_time",
]);
export type NumericFieldKey = z.infer<typeof numericFieldKeySchema>;

export const categoricalFieldKeySchema = z.enum(["fuel", "test_end"]);
export type CategoricalFieldKey = z.infer<typeof categoricalFieldKeySchema>;

export const conditionFieldKeySchema = z.enum([
  "fuel",
  "pressure",
  "oxygen",
  "nitrogen",
  "carbon_dioxide",
  "helium",
  "diameter",
]);
export type ConditionFieldKey = z.infer<typeof conditionFieldKeySchema>;

export const outcomeFieldKeySchema = z.enum([
  "extinction_diameter",
  "burning_rate",
  "burn_time",
  "test_end",
]);
export type OutcomeFieldKey = z.infer<typeof outcomeFieldKeySchema>;

export const gasCompositionFieldKeySchema = z.enum([
  "oxygen",
  "nitrogen",
  "carbon_dioxide",
  "helium",
]);
export type GasCompositionFieldKey = z.infer<typeof gasCompositionFieldKeySchema>;

/** A recorded value. `null` means unknown; numeric zero is a real value. */
export const recordedValueSchema = z.union([
  z.number().finite(),
  nonBlank,
  z.null(),
]);
export type RecordedValue = z.infer<typeof recordedValueSchema>;

export const recordedNumericValueSchema = z.number().finite().nullable();
export type RecordedNumericValue = z.infer<typeof recordedNumericValueSchema>;

export const fieldKindSchema = z.enum(["condition", "outcome"]);
export type FieldKind = z.infer<typeof fieldKindSchema>;

export const fieldDataTypeSchema = z.enum(["numeric", "categorical"]);
export type FieldDataType = z.infer<typeof fieldDataTypeSchema>;

export const fieldOperationSchema = z.enum([
  "plot-axis",
  "group",
  "filter",
  "compare",
  "source-inspect",
  "native-delta",
]);
export type FieldOperation = z.infer<typeof fieldOperationSchema>;

export const missingValueBehaviorSchema = z.strictObject({
  representation: z.literal("null"),
  meaning: z.literal("unknown"),
  zeroIsValid: z.literal(true),
  numericAxis: z.enum(["omit-run", "not-axis"]),
  comparison: z.literal("unknown-never-match"),
});
export type MissingValueBehavior = z.infer<typeof missingValueBehaviorSchema>;

export const fieldDefinitionSchema = z.strictObject({
  key: fieldKeySchema,
  label: nonBlank,
  kind: fieldKindSchema,
  dataType: fieldDataTypeSchema,
  nativeUnit: nonBlank.nullable(),
  axisEligible: z.boolean(),
  filterable: z.boolean(),
  groupable: z.boolean(),
  allowedOperations: z.array(fieldOperationSchema).min(1).max(6),
  allowedValues: z.array(nonBlank).min(1).optional(),
  missingValue: missingValueBehaviorSchema,
  interpretationNotes: z.array(nonBlank).min(1).max(8),
});
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

const numericOperations = ["plot-axis", "filter", "compare", "source-inspect", "native-delta"] as const;
const categoricalOperations = ["group", "filter", "compare", "source-inspect"] as const;
const numericMissing = {
  representation: "null",
  meaning: "unknown",
  zeroIsValid: true,
  numericAxis: "omit-run",
  comparison: "unknown-never-match",
} as const;
const categoricalMissing = {
  representation: "null",
  meaning: "unknown",
  zeroIsValid: true,
  numericAxis: "not-axis",
  comparison: "unknown-never-match",
} as const;

const gasCompositionNote =
  "This is an initial ambient gas mole fraction. Gas fractions are linked; inspect the complete recorded composition rather than one component alone.";

export const fieldCatalogSchema = z.strictObject({
  catalogVersion: z.literal(upgradeContractVersions.fieldCatalog),
  datasetVersion: nonBlank,
  sourceId: nonBlank,
  reviewedRunCount: z.int().nonnegative(),
  reviewedFieldCount: z.int().positive(),
  fields: z.array(fieldDefinitionSchema).min(1),
}).superRefine((catalog, context) => {
  const keys = new Set<string>();
  for (const [index, field] of catalog.fields.entries()) {
    if (keys.has(field.key)) {
      context.addIssue({ code: "custom", path: ["fields", index, "key"], message: "Duplicate field key" });
    }
    keys.add(field.key);
    if (field.dataType === "numeric" && (!field.axisEligible || field.nativeUnit === null)) {
      context.addIssue({
        code: "custom",
        path: ["fields", index],
        message: "Numeric fields need a native unit and must be axis eligible",
      });
    }
    if (field.dataType === "categorical" && (field.axisEligible || field.nativeUnit !== null || !field.allowedValues)) {
      context.addIssue({
        code: "custom",
        path: ["fields", index],
        message: "Categorical fields need allowed values and must not be axis eligible",
      });
    }
    if (field.key === "fuel" && !field.groupable) {
      context.addIssue({ code: "custom", path: ["fields", index, "groupable"], message: "Fuel must be groupable" });
    }
    if (field.key !== "fuel" && field.groupable) {
      context.addIssue({
        code: "custom",
        path: ["fields", index, "groupable"],
        message: "Fuel is the only approved plot grouping",
      });
    }
  }
  if (keys.size !== catalog.reviewedFieldCount) {
    context.addIssue({
      code: "custom",
      path: ["reviewedFieldCount"],
      message: "Reviewed field count does not match the catalog",
    });
  }
});

/**
 * Reviewed from data/flex.json at dataset version
 * flex-psi69-v5-table-v1-subset-1 (31 runs, 11 fields). Labels, condition/
 * outcome classification and native units are copied from the corpus; this
 * module adds no unit conversions.
 */
export const reviewedFieldCatalog = fieldCatalogSchema.parse({
  catalogVersion: upgradeContractVersions.fieldCatalog,
  datasetVersion: "flex-psi69-v5-table-v1-subset-1",
  sourceId: "psi-69-flex-table-v1",
  reviewedRunCount: 31,
  reviewedFieldCount: 11,
  fields: [
    {
      key: "fuel",
      label: "Fuel",
      kind: "condition",
      dataType: "categorical",
      nativeUnit: null,
      axisEligible: false,
      filterable: true,
      groupable: true,
      allowedOperations: [...categoricalOperations],
      allowedValues: ["Methanol", "Heptane"],
      missingValue: categoricalMissing,
      interpretationNotes: [
        "Categorical recorded fuel label. It is not a measured property and does not establish fuel purity or identical test preparation.",
        "Fuel may be used for exact categorical matching and plot grouping only; it cannot define a numeric axis or tolerance.",
      ],
    },
    {
      key: "pressure",
      label: "Ambient pressure",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mmHg",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        "Ambient pressure is retained in mmHg exactly as supplied by the selected FLEX table. No conversion is applied.",
        "A pressure difference is a recorded condition difference, not by itself a cause of an outcome difference.",
      ],
    },
    {
      key: "oxygen",
      label: "Initial ambient oxygen",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mole fraction",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [gasCompositionNote],
    },
    {
      key: "nitrogen",
      label: "Initial ambient nitrogen",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mole fraction",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [gasCompositionNote],
    },
    {
      key: "carbon_dioxide",
      label: "Initial ambient carbon dioxide",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mole fraction",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [gasCompositionNote],
    },
    {
      key: "helium",
      label: "Initial ambient helium",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mole fraction",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        gasCompositionNote,
        "Helium is recorded as zero for every run in the selected subset; zero is a recorded value, not a missing value.",
      ],
    },
    {
      key: "diameter",
      label: "Initial droplet diameter",
      kind: "condition",
      dataType: "numeric",
      nativeUnit: "mm",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        "Initial droplet diameter in millimetres. A null value means the selected source does not report it; zero would be a recorded value if present.",
      ],
    },
    {
      key: "extinction_diameter",
      label: "Droplet diameter at visible flame extinction",
      kind: "outcome",
      dataType: "numeric",
      nativeUnit: "mm",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        "This is a visible-flame-extinction measurement, not a generic final droplet size.",
        "Appendix A.1 of the interpretation reference notes that some visible-extinction diameters were estimated from burning history. The selected PSI columns do not flag which individual values were estimated.",
        "A null value means the selected source does not report the measurement.",
      ],
    },
    {
      key: "burning_rate",
      label: "Burning rate",
      kind: "outcome",
      dataType: "numeric",
      nativeUnit: "mm²/s",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        "The interpretation reference (Table IX) establishes the burning-rate unit as mm²/s. The literal PSI CSV header reads \"Burning rate; mm\".",
        "The native unit is retained; this contract adds no conversion.",
      ],
    },
    {
      key: "burn_time",
      label: "Burn time",
      kind: "outcome",
      dataType: "numeric",
      nativeUnit: "s",
      axisEligible: true,
      filterable: true,
      groupable: false,
      allowedOperations: [...numericOperations],
      missingValue: numericMissing,
      interpretationNotes: [
        "Recorded burn duration in seconds. Null means unreported; zero would remain a valid recorded duration if present.",
      ],
    },
    {
      key: "test_end",
      label: "Test end",
      kind: "outcome",
      dataType: "categorical",
      nativeUnit: null,
      axisEligible: false,
      filterable: true,
      groupable: false,
      allowedOperations: ["filter", "compare", "source-inspect"],
      allowedValues: ["Disruption", "Extinction", "Completion"],
      missingValue: categoricalMissing,
      interpretationNotes: [
        "Categorical test-termination label. The labels describe how a test ended; they are not a numeric outcome or a quality ranking.",
        "Use exact categorical comparison only; no numerical tolerance applies.",
      ],
    },
  ],
});

export type FieldCatalog = z.infer<typeof fieldCatalogSchema>;

/** Convenience alias for callers that expect a plain catalog name. */
export const fieldCatalog = reviewedFieldCatalog;

export const fieldKeys = reviewedFieldCatalog.fields.map(({ key }) => key);
export const numericFieldKeys = numericFieldKeySchema.options;
export const categoricalFieldKeys = categoricalFieldKeySchema.options;
export const conditionFieldKeys = conditionFieldKeySchema.options;
export const outcomeFieldKeys = outcomeFieldKeySchema.options;
export const gasCompositionFieldKeys = gasCompositionFieldKeySchema.options;

export const fieldDefinitionByKey: Readonly<Record<FieldKey, FieldDefinition>> =
  Object.fromEntries(reviewedFieldCatalog.fields.map((field) => [field.key, field])) as Record<FieldKey, FieldDefinition>;

export function isFieldKey(value: string): value is FieldKey {
  return Object.hasOwn(fieldDefinitionByKey, value);
}

export function isNumericFieldKey(value: string): value is NumericFieldKey {
  return numericFieldKeySchema.safeParse(value).success;
}

export function isCategoricalFieldKey(value: string): value is CategoricalFieldKey {
  return categoricalFieldKeySchema.safeParse(value).success;
}

export function isConditionFieldKey(value: string): value is ConditionFieldKey {
  return conditionFieldKeySchema.safeParse(value).success;
}

export function isOutcomeFieldKey(value: string): value is OutcomeFieldKey {
  return outcomeFieldKeySchema.safeParse(value).success;
}

export function isGasCompositionFieldKey(value: string): value is GasCompositionFieldKey {
  return gasCompositionFieldKeySchema.safeParse(value).success;
}

export function getFieldDefinition(key: FieldKey): FieldDefinition {
  return fieldDefinitionByKey[key];
}

export function fieldNativeUnit(key: FieldKey): string | null {
  return fieldDefinitionByKey[key].nativeUnit;
}

export function fieldLabel(key: FieldKey): string {
  return fieldDefinitionByKey[key].label;
}

export function fieldKind(key: FieldKey): FieldKind {
  return fieldDefinitionByKey[key].kind;
}

export function isAxisEligibleField(key: string): key is NumericFieldKey {
  return isFieldKey(key) && fieldDefinitionByKey[key].axisEligible;
}

/** Zero is a recorded value; only `null` is unknown. */
export function isUnknownValue(value: RecordedValue | undefined): value is null | undefined {
  return value === null || value === undefined;
}

/** A filter value must be the same JSON primitive type as recorded non-null values. */
export function isCompatibleFilterValue(fieldKey: FieldKey, value: RecordedValue): boolean {
  if (value === null) return true;
  const { dataType } = fieldDefinitionByKey[fieldKey];
  if (dataType === "categorical") return typeof value === "string";
  return typeof value === "number" && Number.isFinite(value);
}

export const gasCompositionDefinitionNotes = gasCompositionNote;
