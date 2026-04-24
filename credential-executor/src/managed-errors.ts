/**
 * Error message constants for managed-mode CES.
 *
 * Re-exported from @vellumai/service-contracts so both the assistant and
 * credential-executor can share the constant via the approved shared-code
 * path without violating the hard process-boundary isolation.
 */

export { MANAGED_LOCAL_STATIC_REJECTION_ERROR } from "@vellumai/service-contracts/credential-rpc";
