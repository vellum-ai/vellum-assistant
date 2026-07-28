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
import { z } from "zod";

import { upsertContactChannel } from "../../contacts/contacts-write.js";
import { composeInvitePresentation } from "../../runtime/invite-service.js";
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

const ComposeInvitePresentationParamsSchema = z.object({
  contactId: z.string().min(1).optional(),
  invite: z.record(z.string(), z.unknown()),
  rawToken: z.string().min(1).optional(),
});

/**
 * Compose the daemon-owned presentation fields (share link, guardian
 * instruction, channel handle) for a gateway-minted invite payload.
 *
 * Called best-effort by the gateway HTTP create handler so direct gateway
 * callers receive the same presentation the daemon create relay layers on
 * in-process. The invite row and its secrets stay gateway-owned; this only
 * derives display fields from the one-time create payload.
 */
export async function handleComposeInvitePresentation({
  body = {},
}: RouteHandlerArgs) {
  const params = ComposeInvitePresentationParamsSchema.parse(body);
  const invite = await composeInvitePresentation(params);
  return { invite };
}

/**
 * IPC-only invite methods, keyed by IPC operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 *
 * `invite_redeemed` is the gateway's post-redemption info-mirror
 * notification; redemption itself is gateway-native.
 * `invites_compose_presentation` is the gateway HTTP create handler's
 * presentation callback; minting itself is gateway-native.
 */
export const INVITE_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  invite_redeemed: handleInviteRedeemed,
  invites_compose_presentation: handleComposeInvitePresentation,
};
