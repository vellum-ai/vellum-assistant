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
 * Outcome of the reset authorization gate. A denial is reported to the caller
 * rather than thrown so the gateway can stay silent toward the sender: a
 * channel the guardian turned off must not answer, and an actor below the bar
 * should not learn the command exists.
 */
export type DeleteConversationResult =
  | { ok: true }
  | { ok: false; denied: true; reason: string };

/**
 * Authorize a channel-originated conversation reset.
 *
 * `/new` (and the planned `/stop` / `/fork` / `/rename`) is handled at the
 * gateway and never runs the inbound message pipeline, so this endpoint is
 * the only place its actor can be checked. It authorizes with the SAME
 * runtime primitives a message gets, in the same order:
 *
 * 1. {@link verdictUsability} rejects an unusable gateway verdict
 *    (resolution failure, unresolvable member, guardian without a member row),
 *    so could-not-vouch fails closed instead of passing as a stranger.
 * 2. An explicit per-channel `policy: "deny"` is governance and outranks
 *    classification, matching `acl-enforcement.ts` for members and for the
 *    guardian's own row alike.
 * 3. {@link enforceAdmissionPolicy} applies the channel's admission floor and
 *    the blocked/revoked hard-deny. The floor is the one the gateway resolved
 *    and forwarded, exactly as `sourceMetadata.admissionPolicy` carries it for
 *    a message.
 * 4. {@link resolveCapabilities} answers whether this trust class may drive an
 *    interactive control action at all. Admission is "who gets in the door";
 *    resetting shared conversation state additionally needs the capability,
 *    which is why an admitted stranger on a `strangers` channel still cannot
 *    reset. Composing `mayBeInteractive` with runtime context is the
 *    documented pattern for context-dependent capability decisions.
 *
 * Only calls arriving with the gateway service principal are gated: that is
 * the untrusted public-ingress path, and the verdict is how the gateway
 * conveys the channel actor's identity (its own calls are service-principal,
 * so the route policy cannot authenticate the human behind them). Actor and
 * local principals are already authenticated by the route policy itself and
 * are unchanged.
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
  // Authenticated transport is not validation: parse the body before any of
  // it reaches the authorization decision.
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
