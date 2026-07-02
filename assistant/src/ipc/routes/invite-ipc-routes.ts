/**
 * IPC-only invite methods called by the gateway's native invite HTTP
 * handlers over the assistant IPC socket (`ipcCallAssistant`).
 *
 * The gateway redeems codes here while redemption remains daemon-local.
 * These have no HTTP surface: they are registered directly on the IPC
 * server and never enter the shared `ROUTES` array, so they can never
 * reach the gateway's HTTP IPC proxy route schema (`get_route_schema`).
 *
 * Per `assistant/AGENTS.md`, IPC-only methods are registered here rather
 * than flagged inside `ROUTES`.
 */

import { InviteRedeemedNotificationSchema } from "@vellumai/gateway-client";

import { upsertContactChannel } from "../../contacts/contacts-write.js";
import {
  handleRedeemTokenInvite,
  handleRedeemVoiceInvite,
} from "../../runtime/routes/contact-routes.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * Best-effort local info mirror for a gateway-native invite redemption.
 *
 * The gateway owns the ACL outcome; this handler only upserts the local
 * contact/channel identity row from the outcome's identity fields (including
 * `inviteId`, which the local `contact_channels` schema still carries).
 * `upsertContactChannel` is an idempotent upsert and fires
 * `notifyContactsChanged()` internally, so repeated delivery of the same
 * outcome is safe.
 */
export function handleInviteRedeemed({ body = {} }: RouteHandlerArgs) {
  const outcome = InviteRedeemedNotificationSchema.parse(body);
  upsertContactChannel({
    sourceChannel: outcome.sourceChannel,
    externalUserId: outcome.memberExternalUserId,
    externalChatId: outcome.memberExternalChatId,
    displayName: outcome.displayName,
    username: outcome.username,
    inviteId: outcome.inviteId,
    contactId: outcome.contactId,
  });
  return { ok: true };
}

/**
 * IPC-only invite methods, keyed by IPC operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 *
 * `invites_redeem_voice` / `invites_redeem_token` reuse the same split
 * handlers that back the shared HTTP `invites_redeem` route, so token/voice
 * redemption behaves identically across both transports. `invite_redeemed`
 * is the gateway's post-redemption info-mirror notification.
 */
export const INVITE_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  invites_redeem_voice: handleRedeemVoiceInvite,
  invites_redeem_token: handleRedeemTokenInvite,
  invite_redeemed: handleInviteRedeemed,
};
