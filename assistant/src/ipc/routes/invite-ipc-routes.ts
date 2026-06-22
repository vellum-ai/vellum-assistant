/**
 * IPC-only invite methods called by the gateway's native invite HTTP
 * handlers over the assistant IPC socket (`ipcCallAssistant`).
 *
 * Token secrecy + voice fields are assistant-owned, so the gateway mints
 * tokens / redeems codes here and mirrors the canonical lifecycle into its
 * own DB. These have no HTTP surface: they are registered directly on the
 * IPC server and never enter the shared `ROUTES` array, so they can never
 * reach the gateway's HTTP IPC proxy route schema (`get_route_schema`).
 *
 * Per `assistant/AGENTS.md`, IPC-only methods are registered here rather
 * than flagged inside `ROUTES`.
 */

import { mintIngressInvite } from "../../runtime/invite-service.js";
import {
  handleRedeemTokenInvite,
  handleRedeemVoiceInvite,
} from "../../runtime/routes/contact-routes.js";
import { BadRequestError } from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * Mint an invite for the gateway (`invites_mint`).
 *
 * Returns the raw token plus the minimal projection the gateway mirrors into
 * its own store. Token generation/hashing and voice fields stay
 * assistant-owned.
 */
export async function handleMintInvite({ body = {} }: RouteHandlerArgs) {
  const result = await mintIngressInvite({
    sourceChannel: body.sourceChannel as string | undefined,
    note: body.note as string | undefined,
    maxUses: body.maxUses as number | undefined,
    expiresInMs: body.expiresInMs as number | undefined,
    expectedExternalUserId: body.expectedExternalUserId as string | undefined,
    contactId: body.contactId as string,
  });

  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  return {
    ok: true,
    invite: result.data.invite,
    rawToken: result.data.rawToken,
    gateway: result.data.gateway,
  };
}

/**
 * IPC-only invite methods, keyed by IPC operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 *
 * `invites_redeem_voice` / `invites_redeem_token` reuse the same split
 * handlers that back the shared HTTP `invites_redeem` route, so token/voice
 * redemption behaves identically across both transports.
 */
export const INVITE_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  invites_mint: handleMintInvite,
  invites_redeem_voice: handleRedeemVoiceInvite,
  invites_redeem_token: handleRedeemTokenInvite,
};
