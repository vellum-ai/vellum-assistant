/**
 * RPC error schema — extracted to its own module to avoid circular
 * dependencies between index.ts and rpc.ts.
 */

import { z } from "zod";

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Optional structured details for debugging. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/**
 * Error returned when a local_static credential handle is used in managed
 * mode. v2 stores use a UID-independent `store.key` file that removes the
 * technical barrier (legacy v1 relied on PBKDF2 key derivation from user
 * identity, which broke across container users). The restriction is now a
 * policy choice: managed deployments use platform_oauth handles exclusively
 * for simpler lifecycle and centralized token management.
 */
export const MANAGED_LOCAL_STATIC_REJECTION_ERROR =
  "local_static credential handles are not supported in managed mode. " +
  "Use platform_oauth handles for managed deployments.";
