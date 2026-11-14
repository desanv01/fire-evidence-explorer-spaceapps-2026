/**
 * Version identifiers for the additive U01 upgrade contracts.
 *
 * These strings are stored in exported notebooks/action records and must only
 * change when an accepted contract changes in a way old documents cannot
 * express. They are not scientific rule versions; deterministic operations
 * also carry their own ruleVersion fields.
 */
export const upgradeContractVersions = {
  fieldCatalog: "field-catalog-1",
  runScope: "run-scope-1",
  stableFieldReference: "stable-field-reference-1",
  plotSpec: "plot-spec-1",
  plotResult: "plot-result-1",
  comparisonContextRequest: "comparison-context-request-1",
  comparisonContextResult: "comparison-context-result-1",
  comparatorSearch: "comparator-search-1",
  notebook: "notebook-1",
  notebookStep: "notebook-step-1",
  notebookImport: "notebook-import-1",
  assistantAction: "assistant-action-1",
  receiptBinding: "receipt-binding-1",
} as const;

export type UpgradeContractVersion = (typeof upgradeContractVersions)[keyof typeof upgradeContractVersions];
