/**
 * Gateway-backed per-actor inbound trust verdict reader.
 *
 * Resolves the inbound sender's {@link TrustVerdict} from the gateway via the
 * `resolve_inbound_trust` IPC route. Unlike the channel-admission reader this
 * is per-actor, NOT per-channel, so there is NO caching.
 *
 * Returns `null` on ANY failure (transport failure, `undefined`, malformed
 * shape, or thrown error). The Combo 9/10 consumer decides fail-open vs
 * fail-closed — this reader does not.
 */

import { type TrustVerdict, TrustVerdictSchema } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";

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
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
