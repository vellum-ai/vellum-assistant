/**
 * @vellumai/service-contracts — aggregate export (compat entry point)
 *
 * This is a compatibility aggregate that re-exports everything from all
 * submodules. Prefer the explicit domain subpaths for new code:
 *
 *   - `@vellumai/service-contracts/credential-rpc`  — transport, RPC, handles, grants, rendering, error
 *   - `@vellumai/service-contracts/trust-rules`     — trust-rule types and parsing helpers
 *   - `@vellumai/service-contracts/twilio-ingress`  — shared Twilio ingress config constants
 *   - `@vellumai/service-contracts/ingress`         — shared public ingress URL helpers
 *
 * Fine-grained subpaths are also available for low-friction migration:
 *   `./rpc`, `./handles`, `./grants`, `./rendering`, `./error`, `./trust-rules`, `./ingress`, `./twilio-ingress`
 *
 * Neutral wire-protocol contracts for communication between the assistant
 * daemon and the Credential Execution Service (CES). This package is
 * intentionally free of imports from `assistant/` or any CES implementation
 * module so that both sides can depend on it without circular references.
 */

export * from "./transport.js";
export * from "./error.js";
export * from "./handles.js";
export * from "./grants.js";
export * from "./rpc.js";
export * from "./rendering.js";
export * from "./trust-rules.js";
export * from "./ingress.js";
export * from "./twilio-ingress.js";
