/**
 * Channel conversation reset handler.
 *
 * Channel-agnostic contract — two reset shapes, keyed on `sourceThreadId`:
 *
 * - **Thread-less reset** (no `sourceThreadId`): resets the chat's MAIN
 *   conversation only — deletes the base + legacy keys and the thread-less
 *   binding. Thread/topic conversations in the same chat (Slack threads,
 *   Telegram topics) are independent conversations and are never touched.
 * - **Threaded reset** (`sourceThreadId` set): resets exactly that
 *   thread/topic's conversation — deletes its scoped key and its binding.
 *
 * Adapter-specific behavior stays inside the explicitly channel-gated
 * branches below and must not leak into the shared contract.
 */
import {
  type AdmissionPolicy,
  ChannelResetRequestSchema,
  enforceAdmissionPolicy,
  isAdmissionPolicyExemptChannel,
  type TrustVerdict,
} from "@vellumai/gateway-client";

import { type ChannelId, isChannelId } from "../../channels/types.js";
import {
  deleteConversationKey,
  getOrCreateConversation,
} from "../../persistence/conversation-key-store.js";
import { buildScopedConversationKey } from "../../persistence/delivery-crud.js";
import {
  deleteBindingByChannelChatNullThread,
  deleteBindingByChannelChatThread,
} from "../../persistence/external-conversation-store.js";
import { getLogger } from "../../util/logger.js";
import { resolveCapabilities } from "../capabilities.js";
import {
  actorTrustContextFromVerdict,
  verdictUsability,
} from "../trust-verdict-consumer.js";
import { BadRequestError } from "./errors.js";
import type { RouteHandlerArgs } from "./types.js";

const log = getLogger("inbound-conversation");

/**
 * Denials are returned, not thrown, so the gateway can stay silent toward the
 * sender rather than surfacing an error.
 */
export type DeleteConversationResult =
  | { ok: true }
  | { ok: false; denied: true; reason: string };

/**
 * Authorize a channel-originated conversation reset.
 *
 * `/new` is handled at the gateway and never runs the inbound message
 * pipeline, so this endpoint is the only place its actor can be checked. It
 * uses the same primitives a message gets: verdict usability (could-not-vouch
 * fails closed), the `policy: "deny"` governance rule, the admission floor
 * plus blocked/revoked, and finally the capability.
 *
 * The capability check is what admission alone cannot cover: an admitted
 * stranger still meets the runtime's fail-closed capability set on a message,
 * but a command never reaches that turn, so `mayBeInteractive` restores the
 * second gate.
 *
 * Only gateway-principal calls are gated. That is the untrusted ingress path,
 * where the verdict is how the channel actor's identity arrives; actor and
 * local principals are already authenticated by the route policy.
 */
function authorizeChannelReset(args: {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  principalType: string | undefined;
  trustVerdict: TrustVerdict | undefined;
  admissionPolicy: AdmissionPolicy | undefined;
}): DeleteConversationResult {
  if (args.principalType !== "svc_gateway") {
    return { ok: true };
  }

  const usable = verdictUsability(args.trustVerdict);
  if (!usable.usable) {
    return { ok: false, denied: true, reason: `verdict_${usable.reason}` };
  }

  const trust = actorTrustContextFromVerdict(usable.verdict, {
    sourceChannel: args.sourceChannel,
    conversationExternalId: args.conversationExternalId,
  });

  if (trust.memberRecord?.policy === "deny") {
    return { ok: false, denied: true, reason: "policy_deny" };
  }

  if (
    args.admissionPolicy &&
    !isAdmissionPolicyExemptChannel(args.sourceChannel)
  ) {
    const floor = enforceAdmissionPolicy({
      sourceChannel: args.sourceChannel,
      trustClass: trust.trustClass,
      memberStatus: trust.memberRecord?.status,
      policy: args.admissionPolicy,
    });
    if (!floor.admitted) {
      return { ok: false, denied: true, reason: floor.reason };
    }
  }

  if (!resolveCapabilities(trust.trustClass).mayBeInteractive) {
    return { ok: false, denied: true, reason: "not_interactive" };
  }

  return { ok: true };
}

export function handleDeleteConversation({
  body = {},
  headers,
}: RouteHandlerArgs): DeleteConversationResult {
  // Authenticated transport is not validation.
  const parsed = ChannelResetRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid channel reset request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
    );
  }
  const {
    sourceChannel,
    conversationExternalId,
    sourceThreadId,
    trustVerdict,
    admissionPolicy,
  } = parsed.data;

  if (!isChannelId(sourceChannel)) {
    throw new BadRequestError(`Unknown sourceChannel: ${sourceChannel}`);
  }

  const authorization = authorizeChannelReset({
    sourceChannel,
    conversationExternalId,
    principalType: headers?.["x-vellum-principal-type"],
    trustVerdict,
    admissionPolicy,
  });
  if (!authorization.ok) {
    log.info(
      { sourceChannel, conversationExternalId, reason: authorization.reason },
      "Channel conversation reset denied",
    );
    return authorization;
  }

  const normalizedThreadId = sourceThreadId?.trim() || undefined;

  const scopedKey = buildScopedConversationKey(
    sourceChannel,
    conversationExternalId,
    normalizedThreadId,
  );
  deleteConversationKey(scopedKey);
  const legacyKey = `${sourceChannel}:${conversationExternalId}`;
  if (!normalizedThreadId) {
    deleteConversationKey(legacyKey);
    deleteBindingByChannelChatNullThread(sourceChannel, conversationExternalId);
  } else {
    // Slack adapter: eagerly re-mint a fresh conversation for the threaded
    // key so mid-thread turns racing the reset land in the new conversation.
    // Telegram deliberately skips this — a reset topic simply creates its
    // fresh conversation on the next inbound message.
    if (sourceChannel === "slack") {
      getOrCreateConversation(scopedKey);
    }
    deleteBindingByChannelChatThread(
      sourceChannel,
      conversationExternalId,
      normalizedThreadId,
    );
  }

  return { ok: true };
}
