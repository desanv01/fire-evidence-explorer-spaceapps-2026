const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

type EvidenceValueFormat = {
  original?: string | null;
  signed?: boolean;
};

/** Format evidence for display while leaving the recorded and computed values untouched. */
export function formatEvidenceValue(
  value: number | string | null | undefined,
  { original, signed = false }: EvidenceValueFormat = {},
): string {
  if (typeof value === "string") return value;
  if (value == null || !Number.isFinite(value)) return "Unknown";

  const recorded = original?.trim();
  if (!signed && recorded && decimal.test(recorded) && Number(recorded) === value) return recorded;

  // Cap computed display precision while retaining small nonzero values and avoiding zero padding.
  const rounded = Number(value.toPrecision(12));
  const displayed = Number.isFinite(rounded) ? rounded : value;
  return (signed && displayed >= 0 ? "+" : "") + String(displayed);
}
