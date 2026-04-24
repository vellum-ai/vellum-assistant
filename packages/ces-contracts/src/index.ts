/**
 * @vellumai/ces-contracts — compatibility shim
 *
 * This package is a thin facade over `@vellumai/service-contracts`. All
 * contract logic now lives in the canonical package; this module merely
 * re-exports everything so existing consumers of `@vellumai/ces-contracts`
 * continue to work without changes.
 *
 * For new code, prefer importing directly from `@vellumai/service-contracts`.
 */

export * from "@vellumai/service-contracts";
