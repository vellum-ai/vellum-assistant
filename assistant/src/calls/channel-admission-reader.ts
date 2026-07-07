/**
 * Gateway-backed channel admission policy reader.
 *
 * Reads a channel's resolved admission floor from the gateway via the
 * `get_channel_admission_policy` IPC route. The reader FAILS CLOSED,
 * consistent with the text path: a gateway outage must not admit unvetted
 * callers past the floor. Any transport failure, thrown error, or malformed
 * shape resolves to `{ ok: false }` — the caller must DENY, not admit. A
 * successful round-trip resolves to `{ ok: true, policy }`, where `policy:
 * null` is the gateway's explicit "no enforcement configured" answer (still
 * an admit) — distinct from an unreachable gateway.
 *
 * Caches per channelType with a short TTL, mirroring the conversation
 * threshold cache in `../permissions/gateway-threshold-reader.ts`. Only the
 * result of a SUCCESSFUL gateway round-trip is cached (a valid policy, or an
 * explicit `{ policy: null }` "no enforcement" answer); a failure is NOT
 * cached, so a recovered gateway is re-consulted on the next call setup
 * rather than denying calls for the rest of the TTL.
 */

import {
  type AdmissionPolicy,
  isAdmissionPolicy,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";

const CACHE_TTL_MS = 5_000;

// Short IPC timeout so admission fails closed PROMPTLY: a gateway that accepts
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
 * Result of an admission-policy read. `{ ok: false }` means the gateway was
 * unreachable or answered with a malformed shape — the caller must deny.
 * `{ ok: true, policy: null }` is the gateway's explicit "no enforcement
 * configured" answer, which admits.
 */
export type AdmissionPolicyReadResult =
  | { ok: true; policy: AdmissionPolicy | null }
  | { ok: false };

async function fetchAdmissionPolicy(
  channelType: ChannelId,
): Promise<AdmissionPolicyReadResult> {
  try {
    // ipcCall() returns undefined on transport failure (socket not found,
    // timeout, parse error). That, a throw, or a malformed shape is a FAILURE:
    // fail closed without caching so the next setup re-attempts the IPC.
    const result = (await ipcCall(
      "get_channel_admission_policy",
      { channelType },
      ADMISSION_IPC_TIMEOUT_MS,
    )) as { policy?: unknown } | null | undefined;

    if (result === undefined) {
      return { ok: false };
    }
    if (result && isAdmissionPolicy(result.policy)) {
      return { ok: true, policy: result.policy };
    }
    // Explicit "no enforcement" — the gateway successfully answered. Cacheable.
    if (result && result.policy === null) {
      return { ok: true, policy: null };
    }
    // Anything else (missing/invalid policy field) is a malformed shape.
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve a channel's admission policy from the gateway.
 *
 * Fails closed: `{ ok: false }` on any transport failure / malformed shape,
 * and the caller must deny. Only the result of a SUCCESSFUL gateway
 * round-trip is cached — a transient hiccup must not deny (or admit) for the
 * rest of the TTL.
 */
export async function getChannelAdmissionPolicy(
  channelType: ChannelId,
): Promise<AdmissionPolicyReadResult> {
  const cached = cache.get(channelType);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ok: true, policy: cached.policy };
  }

  const result = await fetchAdmissionPolicy(channelType);
  if (!result.ok) {
    // Never cached: a recovered gateway is re-consulted on the next setup.
    return result;
  }

  cache.set(channelType, { policy: result.policy, timestamp: Date.now() });
  return result;
}
