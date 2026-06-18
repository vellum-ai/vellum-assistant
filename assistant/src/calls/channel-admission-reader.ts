/**
 * Gateway-backed channel admission policy reader.
 *
 * Reads a channel's resolved admission floor from the gateway via the
 * `get_channel_admission_policy` IPC route. Admission must never break call
 * setup, so this reader FAILS OPEN: any transport failure, malformed shape,
 * or thrown error resolves to `null` (= admit, no enforcement). A policy is
 * only returned when the gateway responds with `{ policy: <valid policy> }`.
 *
 * Caches per channelType with a short TTL, mirroring the conversation
 * threshold cache in `../permissions/gateway-threshold-reader.ts`. This sits
 * off the hot path, so a lighter cache without failure-coalescing is fine.
 */

import {
  type AdmissionPolicy,
  isAdmissionPolicy,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";

const CACHE_TTL_MS = 5_000;

// Short IPC timeout so admission fails open PROMPTLY: a gateway that accepts
// the socket but stalls must never delay a live call handshake. 1s is generous
// under normal conditions yet far below ipcCall's 5s default.
const ADMISSION_IPC_TIMEOUT_MS = 1_000;

const cache = new Map<
  ChannelId,
  { policy: AdmissionPolicy | null; timestamp: number }
>();

/** Test-only: clear the policy cache. */
export function _clearCacheForTesting(): void {
  cache.clear();
}

/**
 * Resolve a channel's admission policy from the gateway, or `null` on any
 * failure / absence. `null` means admit with no enforcement.
 */
export async function getChannelAdmissionPolicy(
  channelType: ChannelId,
): Promise<AdmissionPolicy | null> {
  const cached = cache.get(channelType);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.policy;
  }

  let policy: AdmissionPolicy | null = null;
  try {
    // ipcCall() returns undefined on transport failure (socket not found,
    // timeout, parse error). Treat anything other than a valid policy as
    // "no enforcement" so a gateway hiccup can never block call setup.
    const result = (await ipcCall(
      "get_channel_admission_policy",
      { channelType },
      ADMISSION_IPC_TIMEOUT_MS,
    )) as { policy?: unknown } | null | undefined;

    if (result && isAdmissionPolicy(result.policy)) {
      policy = result.policy;
    }
  } catch {
    // Fail open — a thrown IPC error must never block call setup.
  }

  cache.set(channelType, { policy, timestamp: Date.now() });
  return policy;
}
