/**
 * IPC-only invite methods called by the gateway over the assistant IPC
 * socket (`ipcCallAssistant`).
 *
 * These have no HTTP surface: they are registered directly on the IPC
 * server and never enter the shared `ROUTES` array, so they can never
 * reach the gateway's HTTP IPC proxy route schema (`get_route_schema`).
 *
 * Per `assistant/AGENTS.md`, IPC-only methods are registered here rather
 * than flagged inside `ROUTES`.
 */

import { InviteRedemptionOutcomeSchema } from "@vellumai/gateway-client";

import { upsertContactChannel } from "../../contacts/contacts-write.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * Best-effort local info mirror for a gateway-native invite redemption.
 *
 * The gateway owns the ACL outcome; this handler only upserts the local
 * contact/channel identity row from the outcome's identity fields.
 * `upsertContactChannel` is an idempotent upsert and fires
 * `notifyContactsChanged()` internally, so repeated delivery of the same
 * outcome is safe.
 */
export function handleInviteRedeemed({ body = {} }: RouteHandlerArgs) {
  const outcome = InviteRedemptionOutcomeSchema.parse(body);
  upsertContactChannel({
    sourceChannel: outcome.sourceChannel,
    externalUserId: outcome.memberExternalUserId,
    externalChatId: outcome.memberExternalChatId,
    displayName: outcome.displayName,
    username: outcome.username,
    contactId: outcome.contactId,
  });
  return { ok: true };
}

/**
 * IPC-only invite methods, keyed by IPC operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 *
 * `invite_redeemed` is the gateway's post-redemption info-mirror
 * notification; redemption itself is gateway-native.
 */
export const INVITE_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  invite_redeemed: handleInviteRedeemed,
};
