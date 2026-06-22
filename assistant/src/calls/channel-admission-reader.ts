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
 * threshold cache in `../permissions/gateway-threshold-reader.ts`. Only the
 * result of a SUCCESSFUL gateway round-trip is cached (a valid policy, or an
 * explicit `{ policy: null }` "no enforcement" answer); a transport failure /
 * throw / malformed shape fails open to `null` WITHOUT caching, so a recovered
 * gateway is re-consulted on the next call setup rather than skipping the
 * admission floor for the rest of the TTL.
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
 * Outcome of a single gateway fetch. Only a SUCCESSFUL round-trip (a valid
 * policy, or an explicit `{ policy: null }` "no enforcement" answer) is
 * cacheable. A transport failure, thrown error, or malformed shape is NOT
 * cached so a recovered gateway is re-consulted on the next call setup.
 */
type FetchResult =
  | { ok: true; policy: AdmissionPolicy | null }
  | { ok: false };

async function fetchAdmissionPolicy(
  channelType: ChannelId,
): Promise<FetchResult> {
  try {
    // ipcCall() returns undefined on transport failure (socket not found,
    // timeout, parse error). That, a throw, or a malformed shape is a FAILURE:
    // fail open without caching so the next setup re-attempts the IPC.
    const result = (await ipcCall(
      "get_channel_admission_policy",
      { channelType },
      ADMISSION_IPC_TIMEOUT_MS,
    )) as { policy?: unknown } | null | undefined;

    if (result === undefined) return { ok: false };
    if (result && isAdmissionPolicy(result.policy)) {
      return { ok: true, policy: result.policy };
    }
    // Explicit "no enforcement" — the gateway successfully answered. Cacheable.
    if (result && result.policy === null) return { ok: true, policy: null };
    // Anything else (missing/invalid policy field) is a malformed shape.
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve a channel's admission policy from the gateway, or `null` on any
 * failure / absence. `null` means admit with no enforcement.
 *
 * Always fails open to `null` on failure, but only caches the result of a
 * SUCCESSFUL gateway round-trip — a transient hiccup must not skip the
 * admission floor for the rest of the TTL.
 */
export async function getChannelAdmissionPolicy(
  channelType: ChannelId,
): Promise<AdmissionPolicy | null> {
  const cached = cache.get(channelType);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.policy;
  }

  const result = await fetchAdmissionPolicy(channelType);
  if (!result.ok) {
    // Fail open WITHOUT caching so a recovered gateway is re-consulted next time.
    return null;
  }

  cache.set(channelType, { policy: result.policy, timestamp: Date.now() });
  return result.policy;
}
