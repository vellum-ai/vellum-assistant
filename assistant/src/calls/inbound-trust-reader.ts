/**
 * Gateway-backed per-actor inbound trust reader.
 *
 * Resolves the inbound sender's {@link TrustVerdict} — and, on the same
 * `resolve_inbound_trust` round-trip, the channel's admission policy — from
 * the gateway. Per-actor, NOT per-channel, so there is NO caching.
 *
 * {@link readInboundTrust} reports `{ ok: false }` on ANY failure (transport
 * failure, `undefined`, malformed shape, or thrown error); an explicit
 * `admissionPolicy: null` on a successful read is the gateway's "no
 * enforcement configured" answer, distinct from an unreachable gateway. An
 * ABSENT `admissionPolicy` key (pre-envelope gateway, version skew) keeps the
 * verdict and resolves the policy via the standalone
 * `get_channel_admission_policy` read instead — fail-closed composition, so a
 * failed fallback read is still `{ ok: false }`. The caller owns the deny
 * policy; this reader only reports.
 */

import {
  type AdmissionPolicy,
  ResolveInboundTrustResponseSchema,
  type TrustVerdict,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";
import { setMemberVerdict } from "../runtime/member-verdict-cache.js";
import { getChannelAdmissionPolicy } from "./channel-admission-reader.js";

// Short IPC timeout so the read resolves promptly rather than stalling call
// setup on a gateway that accepts the socket but hangs.
const TRUST_IPC_TIMEOUT_MS = 2_000;

/**
 * Combined verdict + admission-policy read result. `{ ok: false }` means the
 * gateway was unreachable or answered with a malformed shape.
 */
export type InboundTrustReadResult =
  | { ok: true; verdict: TrustVerdict; admissionPolicy: AdmissionPolicy | null }
  | { ok: false };

export async function readInboundTrust(input: {
  channelType: ChannelId;
  actorExternalId?: string;
}): Promise<InboundTrustReadResult> {
  try {
    const result = await ipcCall(
      "resolve_inbound_trust",
      input,
      TRUST_IPC_TIMEOUT_MS,
    );
    if (!result) {
      return { ok: false };
    }

    const parsed = ResolveInboundTrustResponseSchema.safeParse(result);
    if (!parsed.success) {
      return { ok: false };
    }

    // Single choke point: warm the member-verdict cache so sync call-path
    // readers (access-request callback handoff) can resolve the member later
    // without a gateway read.
    setMemberVerdict(input.channelType, input.actorExternalId, parsed.data.verdict);

    // ABSENT envelope key (pre-envelope gateway): keep the verdict and read
    // the policy standalone. Distinct from an explicit `null`, which is the
    // gateway's "no enforcement" answer and needs no fallback.
    if (parsed.data.admissionPolicy === undefined) {
      const fallback = await getChannelAdmissionPolicy(input.channelType);
      if (!fallback.ok) {
        return { ok: false };
      }
      return {
        ok: true,
        verdict: parsed.data.verdict,
        admissionPolicy: fallback.policy,
      };
    }

    return {
      ok: true,
      verdict: parsed.data.verdict,
      admissionPolicy: parsed.data.admissionPolicy,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Combined verdict + admission-policy read for a phone caller by their
 * external number. Callers compute `otherPartyNumber` from their own
 * transport-specific direction.
 */
export function readPhoneCallerTrust(
  otherPartyNumber: string | undefined,
): Promise<InboundTrustReadResult> {
  return readInboundTrust({
    channelType: "phone",
    actorExternalId: otherPartyNumber || undefined,
  });
}

/** Verdict-only variant of {@link readPhoneCallerTrust}. */
export async function getPhoneCallerVerdict(
  otherPartyNumber: string | undefined,
): Promise<TrustVerdict | null> {
  const result = await readPhoneCallerTrust(otherPartyNumber);
  return result.ok ? result.verdict : null;
}
