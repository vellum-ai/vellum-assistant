/**
 * RPC error schema — extracted to its own module to avoid circular
 * dependencies between index.ts and rpc.ts.
 */

import { z } from "zod/v4";

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Optional structured details for debugging. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/**
 * Error returned when a local_static credential handle is used in managed
 * mode. The encrypted key store uses PBKDF2 key derivation from user
 * identity (username, homedir), but the assistant container runs as root
 * while CES runs as ces — different derived keys make decryption silently
 * fail. Managed deployments must use platform_oauth handles exclusively.
 */
export const MANAGED_LOCAL_STATIC_REJECTION_ERROR =
  "local_static credential handles are not supported in managed mode. " +
  "Use platform_oauth handles for managed deployments.";
