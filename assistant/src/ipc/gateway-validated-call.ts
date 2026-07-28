/**
 * Shared "IPC call → schema-validate → throw" helper for the daemon's typed
 * gateway clients (`channels/gateway-verification-sessions.ts`,
 * `channels/gateway-invites.ts`).
 *
 * Uses the persistent IPC client: these are fail-closed control-plane relays
 * and the persistent socket avoids per-call connect overhead. Transport
 * failures (`IpcCallError`, carrying the gateway's statusCode/errorCode)
 * propagate unchanged so relay routes surface 4xx engine reasons as 4xx; a
 * schema-invalid response throws a generic malformed-response error.
 *
 * The hot voice call-setup path (`calls/gateway-invite-reader.ts`)
 * deliberately does NOT use this — it needs one-shot `ipcCall` with explicit
 * short timeouts and fail-soft handling.
 */

import type { ZodType } from "zod";

import { ipcCallPersistent } from "./gateway-client.js";

export async function ipcCallPersistentValidated<T>(
  method: string,
  params: Record<string, unknown> | undefined,
  responseSchema: ZodType<T>,
): Promise<T> {
  const result = await ipcCallPersistent(method, params);
  const parsed = responseSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Gateway returned a malformed ${method} response`);
  }
  return parsed.data;
}
