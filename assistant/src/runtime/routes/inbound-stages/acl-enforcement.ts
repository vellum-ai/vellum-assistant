/**
 * Ingress ACL enforcement stage: resolves the inbound actor to a member
 * record, enforces allow/deny/escalate policies, handles invite token
 * intercepts, and notifies the guardian of denied access requests.
 */
import type { AdmissionPolicy, SourceMetadata } from "@vellumai/gateway-client";
import { isTrustClass } from "@vellumai/gateway-client";

import { isInviteCodeRedemptionEnabled } from "../../../channels/config.js";
import type { ChannelId } from "../../../channels/types.js";
import { getGuardianDelivery } from "../../../contacts/guardian-delivery-reader.js";
import { channelStatusToMemberStatus } from "../../../contacts/member-status.js";
import { MESSAGE_PREVIEW_MAX_LENGTH } from "../../../notifications/notification-utils.js";
import {
  deleteInbound,
  recordInbound,
} from "../../../persistence/delivery-crud.js";
import { markProcessed } from "../../../persistence/delivery-status.js";
import {
  findByInviteCodeHash,
  findByInviteCodeHashAnyChannel,
} from "../../../persistence/invite-store.js";
import { resolveGuardianName } from "../../../prompts/user-reference.js";
import { getLogger } from "../../../util/logger.js";
import { truncate } from "../../../util/truncate.js";
import { hashVoiceCode } from "../../../util/voice-code.js";
import { notifyGuardianOfAccessRequest } from "../../access-request-helper.js";
import { resolveAnchoredGuardian } from "../../anchored-guardian.js";
import { getInviteAdapterRegistry } from "../../channel-invite-transport.js";
import {
  createOutboundSession,
  findActiveSession,
  getPendingSession,
  resolveBootstrapToken,
} from "../../channel-verification-service.js";
import { deliverChannelReply } from "../../gateway-client.js";
import {
  redeemInvite,
  redeemInviteByCode,
} from "../../invite-redemption-service.js";
import { getInviteRedemptionReply } from "../../invite-redemption-templates.js";
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
  externalMessageId: string;
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

export interface AclResult {
  resolvedMember: VerdictMember | null;
  /** When set, the caller must return this response immediately. */
  earlyResponse?: Record<string, unknown>;
  /**
   * True when a valid `pending_bootstrap` session was resolved during ACL
   * enforcement. The caller must skip the admission policy floor so the
   * bootstrap intercept stage can handle identity binding and emit its reply.
   */
  isValidatedBootstrap?: boolean;
}

/**
 * Enforce ingress ACL rules: member lookup, non-member/inactive denial,
 * policy enforcement (allow/deny/escalate bypass), invite token intercepts,
 * and guardian notification for denied access.
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
    externalMessageId,
    effectiveAdmissionPolicy,
  } = params;

  let isValidatedBootstrap = false;

  // Trust signals from Slack users.info, forwarded via sourceMetadata.
  const isStranger = sourceMetadata?.isStranger ?? undefined;
  const isRestricted = sourceMetadata?.isRestricted ?? undefined;

  // Slack message timestamp for permalink construction.
  const messageTs = sourceMetadata?.messageId ?? undefined;

  // Absent verdict = gateway could not vouch for this actor → fail-closed deny.
  // A PRESENT verdict with no member (stranger) still flows through the
  // intercepts below; only a missing verdict short-circuits here.
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
  // stranger verdict, which falls through to the non-member intercepts.
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
  // A verdict classified `guardian` is admitted even when it carries no
  // per-channel member row (`resolvedMember` null) or an inactive one. The
  // gateway classifies guardians by principal, so a guardian speaking on a
  // channel where they hold no same-channel binding must not fall through the
  // member-vs-stranger gates below — those would misroute the guardian into
  // the stranger lane and fire an access request at the guardian themselves.
  if (verdict.trustClass === "guardian") {
    // The gateway never classifies a blocked/revoked same-channel row as
    // guardian (explicit per-channel governance wins over the principal
    // check), so a verdict claiming both is contradictory. Fail safe:
    // soft-deny with no stranger-lane side effects.
    if (
      resolvedMember?.status === "blocked" ||
      resolvedMember?.status === "revoked"
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
  const inviteAdapter = getInviteAdapterRegistry().get(sourceChannel);
  const inviteToken = inviteAdapter?.extractInboundToken?.({
    commandIntent: commandIntentForAcl,
    content: trimmedContent,
    sourceMetadata,
  });

  if (canonicalSenderId || hasSenderIdentityClaim) {
    if (!resolvedMember) {
      let denyNonMember = true;

      // Bootstrap deep-link commands bypass ACL only when the token
      // resolves to a real pending_bootstrap session. Without this check,
      // any `/start gv_<garbage>` would bypass the not_a_member gate and
      // fall through to normal /start processing.
      if (isBootstrapCommand) {
        const bootstrapPayload = commandIntentForAcl!.payload!;
        const bootstrapTokenForAcl = bootstrapPayload.slice(3); // strip 'gv_' prefix
        const bootstrapSessionForAcl = resolveBootstrapToken(
          sourceChannel,
          bootstrapTokenForAcl,
        );
        if (
          bootstrapSessionForAcl &&
          bootstrapSessionForAcl.status === "pending_bootstrap"
        ) {
          denyNonMember = false;
          isValidatedBootstrap = true;
        } else {
          log.info(
            { sourceChannel, hasValidBootstrapSession: false },
            "Ingress ACL: bootstrap command bypass denied — no valid pending_bootstrap session",
          );
        }
      }

      // ── Invite token intercept (non-member) ──
      // /start invite deep links grant access without guardian approval.
      // Runs BEFORE the policy-aware bypass so a valid /start iv_<token>
      // always redeems and creates a member record — even when the
      // admission policy is `strangers` (which would otherwise admit the
      // sender as a non-member before the token is consumed).
      if (inviteToken && denyNonMember) {
        const inviteResult = await handleInviteTokenIntercept({
          rawToken: inviteToken,
          sourceChannel,
          externalChatId: conversationExternalId,
          externalMessageId,
          senderExternalUserId: canonicalSenderId ?? rawSenderId,
          senderName: actorDisplayName,
          senderUsername: actorUsername,
          replyCallbackUrl,
          assistantId,
          canonicalAssistantId,
        });
        if (inviteResult)
          return {
            resolvedMember: null,
            earlyResponse: inviteResult,
          };
      }

      // ── 6-digit invite code intercept (non-member) ──
      // On channels with codeRedemptionEnabled, a bare 6-digit message may be
      // an invite code. Attempt redemption; on failure (no matching code) fall
      // through to normal processing — the number may be a regular message.
      // Runs before the policy-aware bypass for the same reason as the token
      // intercept above.
      if (denyNonMember && /^\d{6}$/.test(trimmedContent)) {
        const codeInterceptResult = await handleInviteCodeIntercept({
          code: trimmedContent,
          sourceChannel,
          externalChatId: conversationExternalId,
          externalMessageId,
          senderExternalUserId: canonicalSenderId ?? rawSenderId,
          senderName: actorDisplayName,
          senderUsername: actorUsername,
          replyCallbackUrl,
          assistantId,
          canonicalAssistantId,
        });
        if (codeInterceptResult)
          return {
            resolvedMember: null,
            earlyResponse: codeInterceptResult,
          };
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
      // Runs AFTER invite intercepts so valid tokens redeem first.
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

        // Slack-specific: send a verification challenge directly to the
        // user's DM instead of requiring guardian-mediated approval. The
        // user can reply with the code in the DM to self-verify.
        if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
          const slackVerifyResult = initiateSlackVerificationChallenge({
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
        if (sourceChannel === "email" && (canonicalSenderId ?? rawSenderId)) {
          const emailVerifyResult = initiateEmailVerificationChallenge({
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
        let guardianNotified = false;
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
            isStranger,
            isRestricted,
            messageTs,
          });
          guardianNotified = accessResult.notified;
        } catch (err) {
          log.error(
            { err, sourceChannel, conversationExternalId },
            "Failed to notify guardian of access request",
          );
        }

        const replyText = guardianNotified
          ? `Hmm looks like you don't have access to talk to me. I'll let ${await resolveGuardianLabel(sourceChannel)} know you tried talking to me and get back to you.`
          : "Sorry, you haven't been approved to message this assistant.";
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
          const bootstrapPayload = commandIntentForAcl!.payload!;
          const bootstrapTokenForAcl = bootstrapPayload.slice(3);
          const bootstrapSessionForAcl = resolveBootstrapToken(
            sourceChannel,
            bootstrapTokenForAcl,
          );
          if (
            bootstrapSessionForAcl &&
            bootstrapSessionForAcl.status === "pending_bootstrap"
          ) {
            denyInactiveMember = false;
            isValidatedBootstrap = true;
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

        // ── Invite token intercept (inactive member) ──
        // Invite tokens can reactivate revoked/pending members without
        // requiring guardian approval, but blocked members are excluded so
        // they are short-circuited at the ACL layer rather than entering the
        // redemption path. Runs BEFORE the policy-aware bypass so a valid
        // invite always redeems and reactivates the member record, rather
        // than the bypass admitting the sender in their inactive state.
        if (!isBlockedMember && inviteToken && denyInactiveMember) {
          const inviteResult = await handleInviteTokenIntercept({
            rawToken: inviteToken,
            sourceChannel,
            externalChatId: conversationExternalId,
            externalMessageId,
            senderExternalUserId: canonicalSenderId ?? rawSenderId,
            senderName: actorDisplayName,
            senderUsername: actorUsername,
            replyCallbackUrl,
            assistantId,
            canonicalAssistantId,
          });
          if (inviteResult)
            return {
              resolvedMember: null,
              earlyResponse: inviteResult,
            };
        }

        // ── 6-digit invite code intercept (inactive member) ──
        // Codes can reactivate revoked/pending members; non-matching codes
        // fall through. Blocked members are excluded here for consistency —
        // the redemption service would reject them anyway, but early exit
        // avoids unnecessary work. Runs before the policy-aware bypass for
        // the same reason as the token intercept above.
        if (
          !isBlockedMember &&
          denyInactiveMember &&
          /^\d{6}$/.test(trimmedContent)
        ) {
          const codeInterceptResult = await handleInviteCodeIntercept({
            code: trimmedContent,
            sourceChannel,
            externalChatId: conversationExternalId,
            externalMessageId,
            senderExternalUserId: canonicalSenderId ?? rawSenderId,
            senderName: actorDisplayName,
            senderUsername: actorUsername,
            replyCallbackUrl,
            assistantId,
            canonicalAssistantId,
          });
          if (codeInterceptResult)
            return {
              resolvedMember: null,
              earlyResponse: codeInterceptResult,
            };
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
        // Runs AFTER invite intercepts so valid tokens redeem first.
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

          // Slack-specific: re-verify inactive members via DM challenge
          // (same as non-member path). Blocked members are excluded —
          // the guardian made an explicit decision to block them.
          if (
            sourceChannel === "slack" &&
            resolvedMember.status !== "blocked" &&
            (canonicalSenderId ?? rawSenderId)
          ) {
            const slackVerifyResult = initiateSlackVerificationChallenge({
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
          let guardianNotified = false;
          if (resolvedMember.status !== "blocked") {
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
                isStranger,
                isRestricted,
                messageTs,
              });
              guardianNotified = accessResult.notified;
            } catch (err) {
              log.error(
                { err, sourceChannel, conversationExternalId },
                "Failed to notify guardian of access request",
              );
            }
          }

          const inactiveReplyText = guardianNotified
            ? `Hmm looks like you don't have access to talk to me. I'll let ${await resolveGuardianLabel(sourceChannel)} know you tried talking to me and get back to you.`
            : "Sorry, you haven't been approved to message this assistant.";
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
    ...(isValidatedBootstrap && { isValidatedBootstrap }),
  };
}

// ---------------------------------------------------------------------------
// Invite token intercept
// ---------------------------------------------------------------------------

/**
 * Handle an inbound invite token for a non-member or inactive member.
 *
 * Redeems the invite, delivers a deterministic reply, and returns a Response
 * to short-circuit the handler. Returns `null` when the intercept should not
 * fire (e.g. already_member outcome — let normal flow handle it).
 */
async function handleInviteTokenIntercept(params: {
  rawToken: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  externalMessageId: string;
  senderExternalUserId?: string;
  senderName?: string;
  senderUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
  canonicalAssistantId: string;
}): Promise<Record<string, unknown> | null> {
  const {
    rawToken,
    sourceChannel,
    externalChatId,
    externalMessageId,
    senderExternalUserId,
    senderName,
    senderUsername,
    replyCallbackUrl,
    assistantId,
    canonicalAssistantId,
  } = params;

  // Record the inbound event for dedup tracking BEFORE performing redemption.
  // Without this, duplicate webhook deliveries (common with Telegram) would
  // not be tracked: the first delivery redeems the invite and returns early,
  // then the retry finds an active member, passes ACL, and the raw
  // /start iv_<token> message leaks into the agent pipeline.
  const dedupResult = recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { assistantId: canonicalAssistantId },
  );

  if (dedupResult.duplicate) {
    return {
      accepted: true,
      duplicate: true,
      eventId: dedupResult.eventId,
    };
  }

  const outcome = await redeemInvite({
    rawToken,
    sourceChannel,
    externalUserId: senderExternalUserId,
    externalChatId,
    displayName: senderName,
    username: senderUsername,
    assistantId: canonicalAssistantId,
  });

  log.info(
    {
      sourceChannel,
      externalChatId: params.externalChatId,
      ok: outcome.ok,
      type: outcome.ok ? outcome.type : undefined,
      reason: !outcome.ok ? outcome.reason : undefined,
    },
    "Invite token intercept: redemption result",
  );

  // already_member means the user has an active record — let the normal
  // flow handle them (they passed ACL or the member is active).
  if (outcome.ok && outcome.type === "already_member") {
    // Deliver a quick acknowledgement and short-circuit so the user
    // does not trigger the deny gate or a duplicate agent loop.
    const replyText = getInviteRedemptionReply(outcome);
    if (replyCallbackUrl) {
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        });
      } catch (err) {
        log.error(
          { err, externalChatId },
          "Failed to deliver invite already-member reply",
        );
      }
    }
    markProcessed(dedupResult.eventId);
    return {
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "already_member",
    };
  }

  const replyText = getInviteRedemptionReply(outcome);

  if (replyCallbackUrl) {
    try {
      await deliverChannelReply(replyCallbackUrl, {
        chatId: externalChatId,
        text: replyText,
        assistantId,
      });
    } catch (err) {
      log.error(
        { err, externalChatId },
        "Failed to deliver invite redemption reply",
      );
    }
  }

  if (outcome.ok && outcome.type === "redeemed") {
    markProcessed(dedupResult.eventId);
    return {
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "redeemed",
      memberId: outcome.memberId,
    };
  }

  // Failed redemption — inform the user and deny
  markProcessed(dedupResult.eventId);
  return {
    accepted: true,
    eventId: dedupResult.eventId,
    denied: true,
    inviteRedemption: outcome.reason,
  };
}

// ---------------------------------------------------------------------------
// 6-digit invite code intercept
// ---------------------------------------------------------------------------

/**
 * Handle a bare 6-digit message as a potential invite code redemption.
 *
 * Checks channel policy (codeRedemptionEnabled), attempts redemption via
 * `redeemInviteByCode`, and returns a Response to short-circuit the handler
 * on success. Returns `null` when the code does not match any active invite,
 * allowing the message to fall through to normal processing.
 */
async function handleInviteCodeIntercept(params: {
  code: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  externalMessageId: string;
  senderExternalUserId?: string;
  senderName?: string;
  senderUsername?: string;
  replyCallbackUrl?: string;
  assistantId?: string;
  canonicalAssistantId: string;
}): Promise<Record<string, unknown> | null> {
  const {
    code,
    sourceChannel,
    externalChatId,
    externalMessageId,
    senderExternalUserId,
    senderName,
    senderUsername,
    replyCallbackUrl,
    assistantId,
    canonicalAssistantId,
  } = params;

  // Skip channels that don't support code redemption
  if (!isInviteCodeRedemptionEnabled(sourceChannel)) {
    return null;
  }

  // Pre-check: verify a matching invite exists before committing to handle
  // this message. A bare 6-digit number may be a regular message, so we
  // must not record inbound dedup until we know the code maps to an invite.
  const codeHash = hashVoiceCode(code);
  const candidateInvite = findByInviteCodeHash(codeHash, sourceChannel);
  if (!candidateInvite) {
    // The code doesn't match any invite on this channel. Before falling
    // through to normal processing, check if it matches on a different
    // channel — if so, inform the user instead of silently ignoring it.
    const crossChannelInvite = findByInviteCodeHashAnyChannel(codeHash);
    if (crossChannelInvite) {
      // Record inbound for dedup tracking — without this, duplicate webhook
      // deliveries would re-enter ACL and send the mismatch reply again.
      const dedupResult = recordInbound(
        sourceChannel,
        externalChatId,
        externalMessageId,
        { assistantId: canonicalAssistantId },
      );

      if (dedupResult.duplicate) {
        return {
          accepted: true,
          duplicate: true,
          eventId: dedupResult.eventId,
        };
      }

      const mismatchReply = "This invite is not valid for this channel.";
      if (replyCallbackUrl) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: mismatchReply,
            assistantId,
          });
        } catch (err) {
          log.error(
            { err, externalChatId },
            "Failed to deliver invite code channel-mismatch reply",
          );
        }
      }
      markProcessed(dedupResult.eventId);
      return {
        accepted: true,
        eventId: dedupResult.eventId,
        denied: true,
        inviteRedemption: "channel_mismatch",
      };
    }
    return null;
  }

  // Record the inbound event for dedup tracking BEFORE performing redemption,
  // matching the token intercept path. Without this, duplicate webhook
  // deliveries could slip through: the first delivery redeems the invite and
  // activates membership, then a retry finds an active member, passes ACL,
  // and the raw 6-digit message leaks into the agent pipeline.
  const dedupResult = recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { assistantId: canonicalAssistantId },
  );

  if (dedupResult.duplicate) {
    return {
      accepted: true,
      duplicate: true,
      eventId: dedupResult.eventId,
    };
  }

  let outcome: Awaited<ReturnType<typeof redeemInviteByCode>>;
  try {
    outcome = await redeemInviteByCode({
      code,
      sourceChannel,
      externalUserId: senderExternalUserId,
      externalChatId,
      displayName: senderName,
      username: senderUsername,
      assistantId: canonicalAssistantId,
    });
  } catch (err) {
    // Redemption threw — roll back the dedup record so webhook retries
    // can re-attempt instead of short-circuiting as duplicates.
    log.error(
      { err, sourceChannel, externalChatId },
      "Invite code intercept: redemption threw, rolling back dedup record",
    );
    deleteInbound(dedupResult.eventId);
    throw err;
  }

  log.info(
    {
      sourceChannel,
      externalChatId,
      ok: outcome.ok,
      type: outcome.ok ? outcome.type : undefined,
      reason: !outcome.ok ? outcome.reason : undefined,
    },
    "Invite code intercept: redemption result",
  );

  // already_member: deliver acknowledgement and short-circuit
  if (outcome.ok && outcome.type === "already_member") {
    const replyText = getInviteRedemptionReply(outcome);
    if (replyCallbackUrl) {
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        });
      } catch (err) {
        log.error(
          { err, externalChatId },
          "Failed to deliver invite code already-member reply",
        );
      }
    }
    markProcessed(dedupResult.eventId);
    return {
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "already_member",
    };
  }

  const replyText = getInviteRedemptionReply(outcome);

  if (replyCallbackUrl) {
    try {
      await deliverChannelReply(replyCallbackUrl, {
        chatId: externalChatId,
        text: replyText,
        assistantId,
      });
    } catch (err) {
      log.error(
        { err, externalChatId },
        "Failed to deliver invite code redemption reply",
      );
    }
  }

  if (outcome.ok && outcome.type === "redeemed") {
    markProcessed(dedupResult.eventId);
    return {
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "redeemed",
      memberId: outcome.memberId,
    };
  }

  // Failed redemption (expired, revoked, etc.) — inform and deny
  markProcessed(dedupResult.eventId);
  return {
    accepted: true,
    eventId: dedupResult.eventId,
    denied: true,
    inviteRedemption: !outcome.ok ? outcome.reason : undefined,
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
 * Create an outbound verification session for a Slack user. The guardian
 * receives the verification code via the notification pipeline (not a
 * direct DM to the requester). The session is identity-bound with
 * `verificationPurpose: "trusted_contact"` so consuming the code
 * creates a trusted contact record (not a guardian binding).
 */
function initiateSlackVerificationChallenge(params: {
  sourceChannel: ChannelId;
  senderUserId: string;
}): VerificationChallengeResult {
  const { sourceChannel, senderUserId } = params;

  // Skip if there is already a pending challenge or active session for
  // this sender to avoid flooding them with duplicate codes. We scope by
  // sender identity (expectedExternalUserId) so that a pending session for
  // user A does not suppress challenges for user B.
  const existingChallenge = getPendingSession(sourceChannel);
  const existingSession = findActiveSession(sourceChannel);
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
      "Slack verification: skipping — existing challenge/session for this sender",
    );
    return { initiated: false };
  }

  try {
    const session = createOutboundSession({
      channel: sourceChannel,
      expectedExternalUserId: senderUserId,
      expectedChatId: senderUserId,
      identityBindingStatus: "bound",
      destinationAddress: senderUserId,
      verificationPurpose: "trusted_contact",
    });

    // The verification code is delivered to the guardian via the access
    // request notification flow. The guardian decides whether to share
    // it with the requester — we do NOT DM the code to the requester.

    log.info(
      { sourceChannel, senderUserId, sessionId: session.sessionId },
      "Slack verification challenge initiated for unknown contact",
    );

    return { initiated: true, sessionId: session.sessionId };
  } catch (err) {
    log.error(
      { err, sourceChannel, senderUserId },
      "Failed to initiate Slack verification challenge",
    );
    return { initiated: false };
  }
}

// ---------------------------------------------------------------------------
// Email verification challenge
// ---------------------------------------------------------------------------

function initiateEmailVerificationChallenge(params: {
  sourceChannel: ChannelId;
  senderUserId: string;
}): VerificationChallengeResult {
  const { sourceChannel, senderUserId } = params;

  const existingChallenge = getPendingSession(sourceChannel);
  const existingSession = findActiveSession(sourceChannel);
  const senderHasPending =
    (existingChallenge &&
      existingChallenge.expectedExternalUserId === senderUserId) ||
    (existingSession &&
      existingSession.expectedExternalUserId === senderUserId);
  if (senderHasPending) {
    log.debug(
      { sourceChannel, senderUserId },
      "Email verification: skipping — existing challenge/session for this sender",
    );
    return { initiated: false };
  }

  try {
    const session = createOutboundSession({
      channel: sourceChannel,
      expectedExternalUserId: senderUserId,
      expectedChatId: senderUserId,
      identityBindingStatus: "bound",
      destinationAddress: senderUserId,
      verificationPurpose: "trusted_contact",
    });

    log.info(
      { sourceChannel, senderUserId, sessionId: session.sessionId },
      "Email verification challenge initiated for unknown contact",
    );

    return { initiated: true, sessionId: session.sessionId };
  } catch (err) {
    log.error(
      { err, sourceChannel, senderUserId },
      "Failed to initiate email verification challenge",
    );
    return { initiated: false };
  }
}
