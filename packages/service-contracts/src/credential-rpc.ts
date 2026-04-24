/**
 * @vellumai/service-contracts/credential-rpc
 *
 * Domain entrypoint for the CES (Credential Execution Service) transport and
 * RPC surface. Re-exports the transport/RPC/handles/grants/rendering/error
 * contracts without the trust-rule helpers.
 *
 * Prefer this subpath over the root `.` import when you only need the
 * credential RPC surface:
 *
 *   import { CesRpcMethod, MakeAuthenticatedRequestSchema } from "@vellumai/service-contracts/credential-rpc";
 *
 * For trust-rule types use the dedicated subpath:
 *
 *   import { TrustRule, parseTrustRule } from "@vellumai/service-contracts/trust-rules";
 */

export * from "./transport.js";
export * from "./error.js";
export * from "./handles.js";
export * from "./grants.js";
export * from "./rendering.js";
export * from "./rpc.js";
