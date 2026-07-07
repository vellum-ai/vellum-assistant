/**
 * Gateway-backed voice-invite reader for the phone channel.
 *
 * Resolves voice-invite state from the gateway's canonical `ingress_invites`
 * table via the `get_active_voice_invite` / `redeem_voice_invite` IPC routes.
 *
 * Failure semantics are asymmetric by design:
 * - Detection fails SOFT — `null` on ANY failure (transport error,
 *   `undefined`, malformed shape), so the caller falls to the unverified
 *   path rather than stalling call setup.
 * - Redemption fails CLOSED — any IPC failure is the generic
 *   `invalid_or_expired` outcome. There is no local fallback: the gateway
 *   row is the single lifecycle authority for voice invites.
 *
 * Deliberately NOT built on `channels/gateway-invites.ts` /
 * `ipcCallPersistentValidated`: this is the hot call-setup path, so it uses
 * one-shot `ipcCall` with explicit per-operation timeouts and the fail
 * postures above instead of the persistent throw-fail-closed client the
 * control-plane relays share.
 */

import {
  type ActiveVoiceInvite,
  GetActiveVoiceInviteIpcResponseSchema,
  INVITES_IPC_METHODS,
  type RedeemVoiceInviteIpcResponse,
  RedeemVoiceInviteIpcResponseSchema,
} from "@vellumai/gateway-client";

import { ipcCall } from "../ipc/gateway-client.js";

// Short IPC timeout so detection resolves promptly rather than stalling call
// setup on a gateway that accepts the socket but hangs.
const DETECTION_IPC_TIMEOUT_MS = 2_000;
// Redemption performs the atomic claim plus ACL/mirror writes; give it more
// headroom — a timeout still fails closed.
const REDEMPTION_IPC_TIMEOUT_MS = 10_000;

export type GatewayVoiceRedemptionResult = RedeemVoiceInviteIpcResponse;

const REDEMPTION_FAILURE: GatewayVoiceRedemptionResult = {
  ok: false,
  reason: "invalid_or_expired",
};

/**
 * Resolve the active voice invite awaiting `fromNumber`, or `null` when there
 * is none — or when the gateway can't answer (fail-soft).
 */
export async function getActiveVoiceInvite(
  fromNumber: string | undefined,
): Promise<ActiveVoiceInvite | null> {
  if (!fromNumber) {
    return null;
  }
  try {
    const result = await ipcCall(
      INVITES_IPC_METHODS.getActiveVoiceInvite,
      { callerExternalUserId: fromNumber },
      DETECTION_IPC_TIMEOUT_MS,
    );
    const parsed = GetActiveVoiceInviteIpcResponseSchema.safeParse(result);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.invite;
  } catch {
    return null;
  }
}

/**
 * Redeem a spoken voice code for `fromNumber` at the gateway. Any transport
 * failure or malformed response is the generic failure outcome (fail-closed).
 */
export async function redeemVoiceInviteViaGateway(
  fromNumber: string,
  code: string,
): Promise<GatewayVoiceRedemptionResult> {
  try {
    const result = await ipcCall(
      INVITES_IPC_METHODS.redeemVoiceInvite,
      { callerExternalUserId: fromNumber, code },
      REDEMPTION_IPC_TIMEOUT_MS,
    );
    const parsed = RedeemVoiceInviteIpcResponseSchema.safeParse(result);
    if (!parsed.success) {
      return REDEMPTION_FAILURE;
    }
    return parsed.data;
  } catch {
    return REDEMPTION_FAILURE;
  }
}
