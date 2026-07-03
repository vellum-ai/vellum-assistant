/**
 * Gateway-backed per-actor inbound trust verdict reader.
 *
 * Resolves the inbound sender's {@link TrustVerdict} from the gateway via the
 * `resolve_inbound_trust` IPC route. Unlike the channel-admission reader this
 * is per-actor, NOT per-channel, so there is NO caching.
 *
 * Returns `null` on ANY failure (transport failure, `undefined`, malformed
 * shape, or thrown error). The caller owns the deny policy (fail-open vs
 * fail-closed); this reader only reports the verdict or `null`.
 */

import {
  type TrustVerdict,
  TrustVerdictSchema,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";
import { setMemberVerdict } from "../runtime/member-verdict-cache.js";

// Short IPC timeout so the read resolves promptly rather than stalling call
// setup on a gateway that accepts the socket but hangs.
const TRUST_IPC_TIMEOUT_MS = 2_000;

export async function getInboundTrustVerdict(input: {
  channelType: ChannelId;
  actorExternalId?: string;
}): Promise<TrustVerdict | null> {
  try {
    const result = (await ipcCall(
      "resolve_inbound_trust",
      input,
      TRUST_IPC_TIMEOUT_MS,
    )) as { verdict?: unknown } | null | undefined;

    if (!result) return null;

    const parsed = TrustVerdictSchema.safeParse(result.verdict);
    if (!parsed.success) return null;

    // Single choke point: warm the member-verdict cache so the sync trust
    // fallback resolves the member without a local ACL read.
    setMemberVerdict(input.channelType, input.actorExternalId, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Resolve the verdict for a phone caller by their external number. Callers
 * compute `otherPartyNumber` from their own transport-specific direction.
 */
export function getPhoneCallerVerdict(
  otherPartyNumber: string | undefined,
): Promise<TrustVerdict | null> {
  return getInboundTrustVerdict({
    channelType: "phone",
    actorExternalId: otherPartyNumber || undefined,
  });
}
