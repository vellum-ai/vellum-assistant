/**
 * @vellumai/gateway-client/trust-rules
 *
 * Re-exports the trust-rule contracts from `@vellumai/service-contracts` so
 * consumers that depend on `@vellumai/gateway-client` can access trust-rule
 * types through this package without a separate dependency on
 * `@vellumai/service-contracts`.
 *
 * Prefer importing directly from `@vellumai/service-contracts/trust-rules`
 * for new code outside of the gateway-client boundary.
 */

export * from "@vellumai/service-contracts/trust-rules";
