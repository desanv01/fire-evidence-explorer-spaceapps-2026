/**
 * Browser-safe shared contracts for the Fire Evidence Explorer upgrades.
 *
 * Import from this directory in U03 (plot engine), U04 (comparison context),
 * U05 (notebook persistence), U06 (assistant actions), U07 (approved UI) and
 * U08 (guides). Server-only signing, provider and filesystem code must stay
 * outside these modules.
 */
export * from "./versions.ts";
export * from "./field-catalog.ts";
export * from "./provenance.ts";
export * from "./scope.ts";
export * from "./plot.ts";
export * from "./comparison-context.ts";
export * from "./notebook.ts";
export * from "./actions.ts";
