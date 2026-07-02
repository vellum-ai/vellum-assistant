/**
 * Ingress ACL enforcement stage: resolves the inbound actor to a member
 * record, enforces allow/deny/escalate policies, and notifies the guardian
 * of denied access requests.
 *
 * Invite code/token redemption is intercepted at gateway ingress; redeemed
 * messages never reach this stage.
 */
import type { AdmissionPolicy, SourceMetadata } from "@vellumai/gateway-client";
import { isTrustClass } from "@vellumai/gateway-client";

import type { VerificationSessionWire } from "../../../channels/gateway-verification-sessions.js";
import {
  createOutboundSessionConditional,
  findActiveSession,
  getPendingSession,
  resolveBootstrapToken,
} from "../../../channels/gateway-verification-sessions.js";
import type { ChannelId } from "../../../channels/types.js";
import { getGuardianDelivery } from "../../../contacts/guardian-delivery-reader.js";
import { channelStatusToMemberStatus } from "../../../contacts/member-status.js";
import { MESSAGE_PREVIEW_MAX_LENGTH } from "../../../notifications/notification-utils.js";
import { resolveGuardianName } from "../../../prompts/user-reference.js";
import { getLogger } from "../../../util/logger.js";
import { truncate } from "../../../util/truncate.js";
import {
  isAccessRequestDenied,
  isApprovalHandshakeInProgress,
  notifyGuardianOfAccessRequest,
} from "../../access-request-helper.js";
import { resolveAnchoredGuardian } from "../../anchored-guardian.js";
import { deliverChannelReply } from "../../gateway-client.js";
import type { VerdictMember } from "../../trust-verdict-consumer.js";
import { verdictMemberFromVerdict } from "../../trust-verdict-consumer.js";

const log = getLogger("runtime-http");

/**
 * Resolve the guardian's display name for use in requester-facing messages.
 *
 * Uses the assistant's anchored vellum principal to validate the guardian
 * binding, matching the same strategy used by `notifyGuardianOfAccessRequest`.
 * This prevents stale or cross-assistant bindings from leaking a wrong name.
 * Cosmetic copy, not an admission decision, so a null gateway list degrades
 * gracefully to the default reference.
 */
async function resolveGuardianLabel(sourceChannel: ChannelId): Promise<string> {
  // Cosmetic copy, not an admission decision: no local-store fallback, and a
  // missing anchor principal degrades to the default reference.
  const anchored = resolveAnchoredGuardian({
    guardians: await getGuardianDelivery(),
    sourceChannel,
    requireAnchorPrincipal: true,
  });
  return resolveGuardianName(anchored?.displayName);
}

/**
 * Compose the requester-facing reply for a denied inbound, keyed on the
 * access-request outcome. Single source for this copy — the not_a_member,
 * inactive-member, and admission-floor deny lanes all route through it.
 *
 * - Handshake in progress: the guardian already approved and a verification
 *   code is live; tell the sender their next step. The code is DM'd directly
 *   to the requester on Slack but relayed via the guardian elsewhere, so the
 *   copy covers both.
 * - Guardian notified: the standard "I'll let <guardian> know" copy.
 * - Otherwise: the plain not-approved copy.
 */
export async function composeAccessDenialReply(params: {
  sourceChannel: ChannelId;
  guardianNotified: boolean;
  handshakeInProgress: boolean;
}): Promise<string> {
  if (params.handshakeInProgress) {
    return `Your access request was approved! Reply here with the 6-digit verification code to finish connecting — if you don't have it, ask ${await resolveGuardianLabel(params.sourceChannel)} for it.`;
  }
  if (params.guardianNotified) {
    return `Hmm looks like you don't have access to talk to me. I'll let ${await resolveGuardianLabel(params.sourceChannel)} know you tried talking to me and get back to you.`;
  }
  return "Sorry, you haven't been approved to message this assistant.";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AclEnforcementParams {
  canonicalSenderId: string | null;
  hasSenderIdentityClaim: boolean;
  rawSenderId: string | undefined;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  canonicalAssistantId: string;
  trimmedContent: string;
  sourceMetadata: SourceMetadata | undefined;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  replyCallbackUrl: string | undefined;
  assistantId: string;
  /**
   * Effective admission policy for this request (gateway floor resolved with
   * any per-conversation override). When set, ACL skips its hard-deny paths
   * when the policy is permissive enough:
   * - `strangers`: non-members and inactive (non-blocked) members are passed
   *   through so the admission floor can emit the final verdict.
   * - `any_contact`: inactive `pending` members are passed through.
   *
   * Passing this in avoids having ACL fire guardian notifications and canned
   * replies for senders who will be admitted by the floor stage anyway.
   */
  effectiveAdmissionPolicy?: AdmissionPolicy;
  /**
   * True when the inbound event is an interaction callback (e.g. a Slack
   * Block Kit button press or a message_deleted sentinel) rather than a
   * message the sender composed. Callbacks are decision attempts / lifecycle
   * events, not access attempts: a denied callback must never mint a
   * verification challenge or create an access request — a stale button
   * press from an unrecognized sender would otherwise spawn a fresh
   * Approve/Reject card the guardian already dealt with (LUM-2673). The
   * deny itself (and its canned reply) still applies. Required so every
   * caller makes the classification explicitly.
   */
  isCallbackInteraction: boolean;
}

/**
 * Fail-closed / fail-safe deny result: soft-deny with NO stranger-lane side
 * effects (no access-request card, no verification challenge, no canned
 * reply). Used for unresolvable verdicts, where the sender must not be
 * treated as a stranger.
 */
function failClosedDeny(): AclResult {
  return {
    resolvedMember: null,
    earlyResponse: {
      accepted: true,
      denied: true,
      reason: "not_a_member",
    },
  };
}

/**
 * Resolve a `gv_`-prefixed bootstrap payload to its verification session via
 * the gateway. Inbound messages arrive through the gateway, so an unreachable
 * gateway here is a narrow race, not a steady state: treat the read as "no
 * valid session" and keep the deny.
 */
async function resolveBootstrapSessionForAcl(
  sourceChannel: ChannelId,
  payload: string,
): Promise<VerificationSessionWire | null> {
  try {
    // Strip the 'gv_' prefix; the gateway hashes the raw token.
    return await resolveBootstrapToken(sourceChannel, payload.slice(3));
  } catch (err) {
    log.warn(
      { err, sourceChannel },
      "Ingress ACL: bootstrap token resolution failed (gateway unreachable), keeping deny",
    );
    return null;
  }
}

export interface AclResult {
  resolvedMember: VerdictMember | null;
  /** When set, the caller must return this response immediately. */
  earlyResponse?: Record<string, unknown>;
  /**
   * The `pending_bootstrap` session resolved during ACL enforcement. When
   * set, the caller must skip the admission policy floor and thread this
   * session to the bootstrap intercept stage so it does not re-resolve the
   * token — a second gateway lookup could transiently fail and drop the
   * bootstrap sender into normal processing with the floor already skipped.
   */
  validatedBootstrapSession?: VerificationSessionWire;
}

/**
 * Enforce ingress ACL rules: member lookup, non-member/inactive denial,
 * policy enforcement (allow/deny/escalate bypass), and guardian
 * notification for denied access.
 */
export async function enforceIngressAcl(
  params: AclEnforcementParams,
): Promise<AclResult> {
  const {
    canonicalSenderId,
    hasSenderIdentityClaim,
    rawSenderId,
    sourceChannel,
    conversationExternalId,
    canonicalAssistantId,
    trimmedContent,
    sourceMetadata,
    actorDisplayName,
    actorUsername,
    replyCallbackUrl,
    assistantId,
    effectiveAdmissionPolicy,
    isCallbackInteraction,
  } = params;

  let validatedBootstrapSession: VerificationSessionWire | undefined;

  // Identity signals forwarded via sourceMetadata: bot flag (Slack users.info
  // / Telegram is_bot) plus Slack workspace trust signals.
  const isBot = sourceMetadata?.isBot ?? undefined;
  const isStranger = sourceMetadata?.isStranger ?? undefined;
  const isRestricted = sourceMetadata?.isRestricted ?? undefined;

  // Slack message timestamp for permalink construction.
  const messageTs = sourceMetadata?.messageId ?? undefined;

  // Absent verdict = gateway could not vouch for this actor → fail-closed deny.
  // A PRESENT verdict with no member (stranger) still flows through the
  // stranger lane below; only a missing verdict short-circuits here.
  const verdict = sourceMetadata?.trustVerdict;
  if (verdict == null) {
    log.info(
      { sourceChannel, externalUserId: canonicalSenderId },
      "Ingress ACL: absent trust verdict, denying fail-closed",
    );
    return failClosedDeny();
  }

  // Gateway attempted resolution but failed (DB error) → fail-closed deny,
  // distinct from an absent verdict and from a real stranger. TEXT does not
  // fall back to local ACL reads; the sender can retry.
  if (verdict.resolutionFailed === true) {
    log.warn(
      { sourceChannel, externalUserId: canonicalSenderId },
      "Ingress ACL: gateway trust resolution failed, denying fail-closed",
    );
    return failClosedDeny();
  }

  // Member resolved from the gateway verdict (ACL + identity only); null for a
  // stranger verdict, which falls through to the non-member deny lane.
  const resolvedMember: VerdictMember | null =
    verdictMemberFromVerdict(verdict);

  // A verdict carrying member identity but no resolvable member
  // (malformed/unknown ACL) fails closed, not treated as a stranger.
  if (!resolvedMember && (verdict.contactId || verdict.channelId)) {
    log.info(
      { sourceChannel, externalUserId: canonicalSenderId },
      "Ingress ACL: member verdict with unresolvable ACL, denying fail-closed",
    );
    return failClosedDeny();
  }

  // An unrecognized trust class is an unresolvable verdict (version skew,
  // malformed payload), not a stranger. Fail safe: soft-deny with no
  // stranger-lane side effects (no access-request card, no verification
  // challenge, no canned reply) — never fail-stranger.
  if (!isTrustClass(verdict.trustClass)) {
    log.warn(
      {
        sourceChannel,
        externalUserId: canonicalSenderId,
        trustClass: verdict.trustClass,
      },
      "Ingress ACL: unrecognized trust class on verdict, denying fail-safe",
    );
    return failClosedDeny();
  }

  // ── Guardian short-circuit ──
  // A verdict classified `guardian` is admitted even when its same-channel
  // member row is inactive (e.g. pending): the gateway classifies guardians
  // by principal, so a guardian speaking on a channel where they hold no
  // active guardian binding must not fall through the member-vs-stranger
  // gates below — those would misroute the guardian into the stranger lane
  // and fire an access request at the guardian themselves.
  if (verdict.trustClass === "guardian") {
    // The gateway proves guardian identity via a same-channel member row
    // (the active binding address, or a row belonging to the guardian
    // contact), so every guardian verdict carries a resolvable member row.
    // A guardian verdict WITHOUT one is contradictory — cross-channel
    // address collisions are not identity proofs and must never confer
    // guardian capabilities. Fail safe: soft-deny with no stranger-lane
    // side effects.
    if (!resolvedMember) {
      log.warn(
        { sourceChannel, externalUserId: canonicalSenderId },
        "Ingress ACL: guardian verdict without a member row, denying fail-safe",
      );
      return failClosedDeny();
    }

    // The gateway never classifies a blocked/revoked same-channel row as
    // guardian (explicit per-channel governance wins over the principal
    // check), so a verdict claiming both is contradictory. Fail safe:
    // soft-deny with no stranger-lane side effects.
    if (
      resolvedMember.status === "blocked" ||
      resolvedMember.status === "revoked"
    ) {
      log.warn(
        {
          sourceChannel,
          externalUserId: canonicalSenderId,
          status: resolvedMember.status,
        },
        "Ingress ACL: contradictory guardian verdict with blocked/revoked member row, denying fail-safe",
      );
      return failClosedDeny();
    }

    // An explicit per-channel `policy: "deny"` on the guardian's own row is
    // honored like blocked/revoked: explicit governance wins over
    // classification. Deny with the accurate policy_deny reason but none of
    // the stranger-lane side effects — the canned "ask the guardian" reply
    // would be addressed at the guardian themselves.
    if (resolvedMember.policy === "deny") {
      log.info(
        { sourceChannel, externalUserId: canonicalSenderId },
        "Ingress ACL: guardian member row carries policy deny, denying",
      );
      return {
        resolvedMember,
        earlyResponse: {
          accepted: true,
          denied: true,
          reason: "policy_deny",
        },
      };
    }

    log.info(
      { sourceChannel, externalUserId: canonicalSenderId },
      "Ingress ACL: guardian admitted via trust verdict",
    );
    return { resolvedMember };
  }

  // /start gv_<token> bootstrap commands must also bypass ACL — the user
  // hasn't been verified yet and needs to complete the bootstrap handshake.
  const commandIntentForAcl = sourceMetadata?.commandIntent;
  const isBootstrapCommand =
    commandIntentForAcl?.type === "start" &&
    typeof commandIntentForAcl.payload === "string" &&
    commandIntentForAcl.payload.startsWith("gv_");

  if (canonicalSenderId || hasSenderIdentityClaim) {
    if (!resolvedMember) {
      let denyNonMember = true;

      // Bootstrap deep-link commands bypass ACL only when the token
      // resolves to a real pending_bootstrap session. Without this check,
      // any `/start gv_<garbage>` would bypass the not_a_member gate and
      // fall through to normal /start processing.
      if (isBootstrapCommand) {
        const bootstrapSessionForAcl = await resolveBootstrapSessionForAcl(
          sourceChannel,
          commandIntentForAcl!.payload!,
        );
        if (bootstrapSessionForAcl?.status === "pending_bootstrap") {
          denyNonMember = false;
          validatedBootstrapSession = bootstrapSessionForAcl;
        } else {
          log.info(
            { sourceChannel, hasValidBootstrapSession: false },
            "Ingress ACL: bootstrap command bypass denied — no valid pending_bootstrap session",
          );
        }
      }

      // ── Policy-aware non-member bypass ──
      // Skip the ACL deny gate so the admission floor stage emits the final
      // verdict instead of the ACL prematurely firing guardian notifications,
      // a canned reply, and (on Slack) a verification challenge.
      //  - `strangers` (floor 1): any sender (rank 1) clears the floor, so the
      //    stage admits.
      //  - `guardian_only` (floor 4): no non-guardian can clear the floor even
      //    after verifying (a verified contact is only rank 3), so the upgrade
      //    challenge is misleading — the stage denies with `shouldChallenge:
      //    false`. `trusted_contacts` is intentionally NOT bypassed here: a
      //    stranger there still can't reach the floor, but suppressing its
      //    self-verify challenge is a default-onboarding behavior change left
      //    for a separate §8.2 decision.
      if (
        denyNonMember &&
        (effectiveAdmissionPolicy === "strangers" ||
          effectiveAdmissionPolicy === "guardian_only")
      ) {
        denyNonMember = false;
      }

      if (denyNonMember) {
        log.info(
          { sourceChannel, externalUserId: canonicalSenderId },
          "Ingress ACL: no member record, denying",
        );

        // Terminal deny: if the guardian already rejected this sender, skip all
        // re-engagement (self-verify challenge + guardian notify) and deliver
        // only the canned reply. Otherwise a denied sender whose first
        // verification session expired would be handed a fresh, unusable
        // challenge the guardian was never told about.
        const nonMemberSenderId = canonicalSenderId ?? rawSenderId;
        const terminallyDenied =
          !!nonMemberSenderId &&
          isAccessRequestDenied({
            canonicalAssistantId,
            sourceChannel,
            actorExternalId: nonMemberSenderId,
          });

        // Slack-specific: send a verification challenge directly to the
        // user's DM instead of requiring guardian-mediated approval. The
        // user can reply with the code in the DM to self-verify. Bots are
        // excluded — a bot cannot return a code, so it goes straight to the
        // guardian-notify lane and its introduction card offers direct trust.
        if (
          sourceChannel === "slack" &&
          isBot !== true &&
          (canonicalSenderId ?? rawSenderId) &&
          !terminallyDenied &&
          !isCallbackInteraction
        ) {
          const slackVerifyResult = await initiateVerificationChallenge({
            sourceChannel,
            senderUserId: (canonicalSenderId ?? rawSenderId)!,
          });

          if (slackVerifyResult.initiated) {
            // Still notify the guardian about the access attempt
            try {
              await notifyGuardianOfAccessRequest({
                canonicalAssistantId,
                sourceChannel,
                conversationExternalId,
                actorExternalId: canonicalSenderId ?? rawSenderId,
                actorDisplayName,
                actorUsername,
                messagePreview: truncate(
                  trimmedContent,
                  MESSAGE_PREVIEW_MAX_LENGTH,
                ),
                isBot,
                isStranger,
                isRestricted,
                messageTs,
              });
            } catch (err) {
              log.error(
                { err, sourceChannel, conversationExternalId },
                "Failed to notify guardian of access request (Slack verification)",
              );
            }

            // DM the requester so they have a private channel to reply with
            // the verification code. Sending to the Slack user ID (not
            // conversationExternalId) auto-opens a DM conversation.
            if (replyCallbackUrl) {
              const senderUserId = (canonicalSenderId ?? rawSenderId)!;
              // Strip threadTs from the callback URL — it belongs to the
              // originating channel thread and would cause errors in the DM.
              let dmCallbackUrl = replyCallbackUrl;
              try {
                const url = new URL(replyCallbackUrl);
                url.searchParams.delete("threadTs");
                dmCallbackUrl = url.toString();
              } catch {
                // Malformed URL — use as-is
              }
              try {
                await deliverChannelReply(dmCallbackUrl, {
                  chatId: senderUserId,
                  text: `I don't recognize you yet! I've let ${await resolveGuardianLabel(sourceChannel)} know you're trying to reach me. They'll need to share a 6-digit verification code with you — ask them directly if you know them. Once you have the code, reply here with it.`,
                  assistantId,
                });
              } catch (err) {
                log.error(
                  { err, senderUserId },
                  "Failed to deliver Slack verification DM to requester",
                );
              }
            }

            return {
              resolvedMember: null,
              earlyResponse: {
                accepted: true,
                denied: true,
                reason: "verification_challenge_sent",
                verificationSessionId: slackVerifyResult.sessionId,
              },
            };
          }
        }

        // Email: initiate a verification challenge via the guardian notification
        // pipeline. Unlike Slack, we cannot DM the requester directly — the
        // verification code is delivered to the guardian, who decides whether
        // to share it with the email sender out-of-band.
        if (
          sourceChannel === "email" &&
          (canonicalSenderId ?? rawSenderId) &&
          !terminallyDenied &&
          !isCallbackInteraction
        ) {
          const emailVerifyResult = await initiateVerificationChallenge({
            sourceChannel,
            senderUserId: (canonicalSenderId ?? rawSenderId)!,
          });

          if (emailVerifyResult.initiated) {
            try {
              await notifyGuardianOfAccessRequest({
                canonicalAssistantId,
                sourceChannel,
                conversationExternalId,
                actorExternalId: canonicalSenderId ?? rawSenderId,
                actorDisplayName,
                actorUsername,
                messagePreview: truncate(
                  trimmedContent,
                  MESSAGE_PREVIEW_MAX_LENGTH,
                ),
                isBot,
                isStranger,
                isRestricted,
                messageTs,
              });
            } catch (err) {
              log.error(
                { err, sourceChannel, conversationExternalId },
                "Failed to notify guardian of access request (email verification)",
              );
            }

            return {
              resolvedMember: null,
              earlyResponse: {
                accepted: true,
                denied: true,
                reason: "verification_challenge_sent",
                verificationSessionId: emailVerifyResult.sessionId,
              },
            };
          }
        }

        // Notify the guardian about the access request so they can approve/deny.
        // Uses the shared helper which handles guardian binding lookup,
        // deduplication, canonical request creation, and notification emission.
        // Skipped for callback interactions — a button press must not create
        // an access request — but the handshake window is still probed so the
        // reply doesn't tell a just-approved sender they lack access.
        let guardianNotified = false;
        let handshakeInProgress = false;
        if (isCallbackInteraction) {
          handshakeInProgress = isApprovalHandshakeInProgress({
            canonicalAssistantId,
            sourceChannel,
            actorExternalId: (canonicalSenderId ?? rawSenderId)!,
          });
        } else {
          try {
            const accessResult = await notifyGuardianOfAccessRequest({
              canonicalAssistantId,
              sourceChannel,
              conversationExternalId,
              actorExternalId: canonicalSenderId ?? rawSenderId,
              actorDisplayName,
              actorUsername,
              messagePreview: truncate(
                trimmedContent,
                MESSAGE_PREVIEW_MAX_LENGTH,
              ),
              isBot,
              isStranger,
              isRestricted,
              messageTs,
            });
            guardianNotified = accessResult.notified;
            handshakeInProgress =
              !accessResult.notified &&
              accessResult.reason === "approval_pending_verification";
          } catch (err) {
            log.error(
              { err, sourceChannel, conversationExternalId },
              "Failed to notify guardian of access request",
            );
          }
        }

        const replyText = await composeAccessDenialReply({
          sourceChannel,
          guardianNotified,
          handshakeInProgress,
        });
        let replyDelivered = false;
        if (replyCallbackUrl) {
          const replyPayload: Parameters<typeof deliverChannelReply>[1] = {
            chatId: conversationExternalId,
            text: replyText,
            assistantId,
          };
          // On Slack, send as ephemeral so only the requester sees the rejection
          if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
            replyPayload.ephemeral = true;
            replyPayload.user = (canonicalSenderId ?? rawSenderId)!;
          }
          try {
            await deliverChannelReply(replyCallbackUrl, replyPayload);
            replyDelivered = true;
          } catch (err) {
            log.error(
              { err, conversationExternalId },
              "Failed to deliver ACL rejection reply",
            );
          }
        }

        return {
          resolvedMember: null,
          earlyResponse: {
            accepted: true,
            denied: true,
            reason: "not_a_member",
            // Include reply text so the gateway can deliver directly when
            // callback delivery failed (e.g. signing-key mismatch → 401).
            ...(!replyDelivered && { replyText }),
          },
        };
      }
    }

    if (resolvedMember) {
      if (resolvedMember.status !== "active") {
        const isBlockedMember = resolvedMember.status === "blocked";
        // Bootstrap commands must pass through for re-verifiable states
        // (pending/revoked), but never for blocked members.
        let denyInactiveMember = true;
        if (!isBlockedMember && isBootstrapCommand) {
          const bootstrapSessionForAcl = await resolveBootstrapSessionForAcl(
            sourceChannel,
            commandIntentForAcl!.payload!,
          );
          if (bootstrapSessionForAcl?.status === "pending_bootstrap") {
            denyInactiveMember = false;
            validatedBootstrapSession = bootstrapSessionForAcl;
          } else {
            log.info(
              {
                sourceChannel,
                channelId: resolvedMember.channelId,
                hasValidBootstrapSession: false,
              },
              "Ingress ACL: inactive member bootstrap bypass denied",
            );
          }
        }

        // ── Policy-aware inactive-member bypass ──
        // `strangers` (floor 1): admit non-blocked, non-revoked senders
        //   (pending/unverified bypass the inactive-member deny gate).
        //   Revoked is an EXPLICIT governance action and stays denied even
        //   under the most permissive policy — it is not the same as an
        //   unknown stranger who has never interacted with the assistant.
        // `any_contact` (floor 2): admit `pending` and `unverified` members
        //   (both classify as `unverified_contact` — rank 2 ≥ floor 2); deny
        //   `revoked` members (unknown rank 1 < floor 2).
        // `guardian_only` (floor 4): route `pending`/`unverified` members to
        //   the floor stage for a plain denial. Verifying only lifts them to
        //   `trusted_contact` (rank 3 < floor 4), so the ACL's re-verify
        //   challenge would be misleading. `trusted_contacts` is NOT included:
        //   there, verifying reaches `trusted_contact` (rank 3 ≥ floor 3), so
        //   the challenge legitimately upgrades the sender into access.
        // In every case skip the deny gate so the admission stage decides.
        //
        // A guardian-denied sender is persisted as an unverified contact and is
        // admitted here on the same rank-vs-floor terms as any other unverified
        // contact (admitted under `any_contact`/`strangers`, denied under
        // stricter floors). The deny suppresses re-prompting, not admission;
        // holding a denied contact out of every floor is the block action's job.
        if (!isBlockedMember && denyInactiveMember) {
          if (
            (effectiveAdmissionPolicy === "strangers" &&
              resolvedMember.status !== "revoked") ||
            ((effectiveAdmissionPolicy === "any_contact" ||
              effectiveAdmissionPolicy === "guardian_only") &&
              (resolvedMember.status === "pending" ||
                resolvedMember.status === "unverified"))
          ) {
            denyInactiveMember = false;
          }
        }

        if (denyInactiveMember) {
          log.info(
            {
              sourceChannel,
              channelId: resolvedMember.channelId,
              status: resolvedMember.status,
            },
            "Ingress ACL: member not active, denying",
          );

          // Terminal deny: a sender the guardian already rejected must not be
          // handed a fresh self-verify challenge on re-contact (the guardian is
          // no longer notified, so the code would go nowhere). Skip the
          // challenge and fall through to the canned reply.
          const inactiveSenderId = canonicalSenderId ?? rawSenderId;
          const terminallyDenied =
            !isBlockedMember &&
            !!inactiveSenderId &&
            isAccessRequestDenied({
              canonicalAssistantId,
              sourceChannel,
              actorExternalId: inactiveSenderId,
            });

          // Slack-specific: re-verify inactive members via DM challenge
          // (same as non-member path). Blocked members are excluded —
          // the guardian made an explicit decision to block them. Bots are
          // excluded — a bot cannot return a code.
          if (
            sourceChannel === "slack" &&
            isBot !== true &&
            resolvedMember.status !== "blocked" &&
            (canonicalSenderId ?? rawSenderId) &&
            !terminallyDenied &&
            !isCallbackInteraction
          ) {
            const slackVerifyResult = await initiateVerificationChallenge({
              sourceChannel,
              senderUserId: (canonicalSenderId ?? rawSenderId)!,
            });

            if (slackVerifyResult.initiated) {
              try {
                await notifyGuardianOfAccessRequest({
                  canonicalAssistantId,
                  sourceChannel,
                  conversationExternalId,
                  actorExternalId: canonicalSenderId ?? rawSenderId,
                  actorDisplayName,
                  actorUsername,
                  previousMemberStatus: channelStatusToMemberStatus(
                    resolvedMember.status,
                  ),
                  messagePreview: truncate(
                    trimmedContent,
                    MESSAGE_PREVIEW_MAX_LENGTH,
                  ),
                  isBot,
                  isStranger,
                  isRestricted,
                  messageTs,
                });
              } catch (err) {
                log.error(
                  { err, sourceChannel, conversationExternalId },
                  "Failed to notify guardian of access request (Slack verification, inactive member)",
                );
              }

              // DM the requester (same as non-member path)
              if (replyCallbackUrl) {
                const senderUserId = (canonicalSenderId ?? rawSenderId)!;
                let dmCallbackUrl = replyCallbackUrl;
                try {
                  const url = new URL(replyCallbackUrl);
                  url.searchParams.delete("threadTs");
                  dmCallbackUrl = url.toString();
                } catch {
                  // Malformed URL — use as-is
                }
                try {
                  await deliverChannelReply(dmCallbackUrl, {
                    chatId: senderUserId,
                    text: `I don't recognize you yet! I've let ${await resolveGuardianLabel(sourceChannel)} know you're trying to reach me. They'll need to share a 6-digit verification code with you — ask them directly if you know them. Once you have the code, reply here with it.`,
                    assistantId,
                  });
                } catch (err) {
                  log.error(
                    { err, senderUserId },
                    "Failed to deliver Slack verification DM to requester (inactive member)",
                  );
                }
              }

              return {
                resolvedMember,
                earlyResponse: {
                  accepted: true,
                  denied: true,
                  reason: "verification_challenge_sent",
                  verificationSessionId: slackVerifyResult.sessionId,
                },
              };
            }
          }

          // For revoked/pending members, notify the guardian so they can
          // re-approve. Blocked members are intentionally excluded — the
          // guardian already made an explicit decision to block them.
          // Callback interactions never create an access request; the
          // handshake window is still probed for reply copy.
          let guardianNotified = false;
          let handshakeInProgress = false;
          if (resolvedMember.status !== "blocked") {
            if (isCallbackInteraction) {
              handshakeInProgress = isApprovalHandshakeInProgress({
                canonicalAssistantId,
                sourceChannel,
                actorExternalId: (canonicalSenderId ?? rawSenderId)!,
              });
            } else {
              try {
                const accessResult = await notifyGuardianOfAccessRequest({
                  canonicalAssistantId,
                  sourceChannel,
                  conversationExternalId,
                  actorExternalId: canonicalSenderId ?? rawSenderId,
                  actorDisplayName,
                  actorUsername,
                  previousMemberStatus: channelStatusToMemberStatus(
                    resolvedMember.status,
                  ),
                  messagePreview: truncate(
                    trimmedContent,
                    MESSAGE_PREVIEW_MAX_LENGTH,
                  ),
                  isBot,
                  isStranger,
                  isRestricted,
                  messageTs,
                });
                guardianNotified = accessResult.notified;
                handshakeInProgress =
                  !accessResult.notified &&
                  accessResult.reason === "approval_pending_verification";
              } catch (err) {
                log.error(
                  { err, sourceChannel, conversationExternalId },
                  "Failed to notify guardian of access request",
                );
              }
            }
          }

          const inactiveReplyText = await composeAccessDenialReply({
            sourceChannel,
            guardianNotified,
            handshakeInProgress,
          });
          let inactiveReplyDelivered = false;
          if (replyCallbackUrl) {
            const inactiveReplyPayload: Parameters<
              typeof deliverChannelReply
            >[1] = {
              chatId: conversationExternalId,
              text: inactiveReplyText,
              assistantId,
            };
            // On Slack, send as ephemeral so only the requester sees the rejection
            if (
              sourceChannel === "slack" &&
              (canonicalSenderId ?? rawSenderId)
            ) {
              inactiveReplyPayload.ephemeral = true;
              inactiveReplyPayload.user = (canonicalSenderId ?? rawSenderId)!;
            }
            try {
              await deliverChannelReply(replyCallbackUrl, inactiveReplyPayload);
              inactiveReplyDelivered = true;
            } catch (err) {
              log.error(
                { err, conversationExternalId },
                "Failed to deliver ACL rejection reply",
              );
            }
          }
          return {
            resolvedMember,
            earlyResponse: {
              accepted: true,
              denied: true,
              reason: `member_${channelStatusToMemberStatus(resolvedMember.status)}`,
              ...(!inactiveReplyDelivered && { replyText: inactiveReplyText }),
            },
          };
        }
      }

      if (resolvedMember.policy === "deny") {
        log.info(
          { sourceChannel, channelId: resolvedMember.channelId },
          "Ingress ACL: member policy deny",
        );
        const denyReplyText =
          "Sorry, you haven't been approved to message this assistant.";
        let denyReplyDelivered = false;
        if (replyCallbackUrl) {
          const denyPayload: Parameters<typeof deliverChannelReply>[1] = {
            chatId: conversationExternalId,
            text: denyReplyText,
            assistantId,
          };
          if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
            denyPayload.ephemeral = true;
            denyPayload.user = (canonicalSenderId ?? rawSenderId)!;
          }
          try {
            await deliverChannelReply(replyCallbackUrl, denyPayload);
            denyReplyDelivered = true;
          } catch (err) {
            log.error(
              { err, conversationExternalId },
              "Failed to deliver ACL rejection reply",
            );
          }
        }
        return {
          resolvedMember,
          earlyResponse: {
            accepted: true,
            denied: true,
            reason: "policy_deny",
            ...(!denyReplyDelivered && { replyText: denyReplyText }),
          },
        };
      }
    }
  }

  return {
    resolvedMember,
    ...(validatedBootstrapSession && { validatedBootstrapSession }),
  };
}

// ---------------------------------------------------------------------------
// Channel verification challenges
// ---------------------------------------------------------------------------

interface VerificationChallengeResult {
  initiated: boolean;
  sessionId?: string;
}

/**
 * Create an outbound verification session for an unknown sender (Slack and
 * email deny lanes). The guardian receives the verification code via the
 * notification pipeline (not a direct DM to the requester). The session is
 * identity-bound with `verificationPurpose: "trusted_contact"` so consuming
 * the code creates a trusted contact record (not a guardian binding).
 */
async function initiateVerificationChallenge(params: {
  sourceChannel: ChannelId;
  senderUserId: string;
}): Promise<VerificationChallengeResult> {
  const { sourceChannel, senderUserId } = params;

  // Skip if there is already a pending challenge or active session for
  // this sender to avoid flooding them with duplicate codes. We scope by
  // sender identity (expectedExternalUserId) so that a pending session for
  // user A does not suppress challenges for user B.
  //
  // Inbound messages arrive through the gateway, so an unreachable gateway
  // here is a narrow race, not a steady state: treat it as "no active
  // session but do not create" (creating would fail anyway) and fall
  // through to the normal deny.
  let existingChallenge: VerificationSessionWire | null;
  let existingSession: VerificationSessionWire | null;
  try {
    [existingChallenge, existingSession] = await Promise.all([
      getPendingSession(sourceChannel),
      findActiveSession(sourceChannel),
    ]);
  } catch (err) {
    log.warn(
      { err, sourceChannel, senderUserId },
      "Verification challenge: session reads failed (gateway unreachable), skipping challenge",
    );
    return { initiated: false };
  }
  const senderHasPending =
    (existingChallenge &&
      existingChallenge.expectedExternalUserId === senderUserId) ||
    (existingSession &&
      existingSession.expectedExternalUserId === senderUserId);
  if (senderHasPending) {
    log.debug(
      {
        sourceChannel,
        senderUserId,
        hasChallenge: !!existingChallenge,
        hasSession: !!existingSession,
      },
      "Verification challenge: skipping — existing challenge/session for this sender",
    );
    return { initiated: false };
  }

  try {
    // Sender-scoped atomic claim: a concurrent duplicate webhook from the
    // SAME sender loses and gets a conflict instead of revoking the winner's
    // challenge; a different sender may still supersede (revoke-prior).
    const session = await createOutboundSessionConditional({
      channel: sourceChannel,
      expectedExternalUserId: senderUserId,
      expectedChatId: senderUserId,
      identityBindingStatus: "bound",
      destinationAddress: senderUserId,
      verificationPurpose: "trusted_contact",
      ifNoneActiveForExternalUserId: senderUserId,
    });
    if ("conflict" in session) {
      log.debug(
        { sourceChannel, senderUserId, reason: session.reason },
        "Verification challenge: skipping — concurrent mint already claimed the channel",
      );
      return { initiated: false };
    }

    // The verification code is delivered to the guardian via the access
    // request notification flow. The guardian decides whether to share
    // it with the requester — we do NOT DM the code to the requester.

    log.info(
      { sourceChannel, senderUserId, sessionId: session.sessionId },
      "Verification challenge initiated for unknown contact",
    );

    return { initiated: true, sessionId: session.sessionId };
  } catch (err) {
    log.error(
      { err, sourceChannel, senderUserId },
      "Failed to initiate verification challenge",
    );
    return { initiated: false };
  }
}
