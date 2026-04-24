/**
 * @vellumai/ces-client/credential-rpc
 *
 * Re-exports the credential RPC surface from `@vellumai/service-contracts` so
 * consumers that depend on `@vellumai/ces-client` can access the CES wire
 * protocol types through this package without a separate dependency on
 * `@vellumai/service-contracts`.
 *
 * Prefer importing directly from `@vellumai/service-contracts/credential-rpc`
 * for new code outside of the ces-client boundary.
 */

export * from "@vellumai/service-contracts/credential-rpc";
