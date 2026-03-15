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
