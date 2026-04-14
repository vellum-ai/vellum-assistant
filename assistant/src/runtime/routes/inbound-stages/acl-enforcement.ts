/**
 * Ingress ACL enforcement stage: resolves the inbound actor to a member
 * record, enforces allow/deny/escalate policies, handles invite token
 * intercepts, and notifies the guardian of denied access requests.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import { isInviteCodeRedemptionEnabled } from "../../../channels/config.js";
import type { ChannelId } from "../../../channels/types.js";
import {
  findContactChannel,
  findGuardianForChannel,
} from "../../../contacts/contact-store.js";
import { touchChannelLastSeen } from "../../../contacts/contacts-write.js";
import type {
  ChannelStatus,
  ContactChannel,
  ContactWithChannels,
} from "../../../contacts/types.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import * as deliveryStatus from "../../../memory/delivery-status.js";
import {
  findByInviteCodeHash,
  findByInviteCodeHashAnyChannel,
} from "../../../memory/invite-store.js";
import { MESSAGE_PREVIEW_MAX_LENGTH } from "../../../notifications/copy-composer.js";
import { resolveGuardianName } from "../../../prompts/user-reference.js";
import { getLogger } from "../../../util/logger.js";
import { truncate } from "../../../util/truncate.js";
import { hashVoiceCode } from "../../../util/voice-code.js";
import { notifyGuardianOfAccessRequest } from "../../access-request-helper.js";
import { getInviteAdapterRegistry } from "../../channel-invite-transport.js";
import {
  createOutboundSession,
  findActiveSession,
  getPendingSession,
  resolveBootstrapToken,
} from "../../channel-verification-service.js";
import { deliverChannelReply } from "../../gateway-client.js";
import { ensureVellumGuardianBinding } from "../../guardian-vellum-migration.js";
import {
  redeemInvite,
  redeemInviteByCode,
} from "../../invite-redemption-service.js";
import { getInviteRedemptionReply } from "../../invite-redemption-templates.js";

const log = getLogger("runtime-http");

/**
 * Resolve the guardian's display name for use in requester-facing messages.
 *
 * Uses the assistant's anchored vellum principal to validate the guardian
 * contact, matching the same strategy used by `notifyGuardianOfAccessRequest`.
 * This prevents stale or cross-assistant contacts from leaking a wrong name.
 */
function resolveGuardianLabel(
  sourceChannel: ChannelId,
  canonicalAssistantId: string,
): string {
  const anchoredPrincipalId = ensureVellumGuardianBinding(canonicalAssistantId);

  // Try source-channel guardian, but only accept it when the principal
  // matches the assistant's anchor.
  const sourceGuardian = findGuardianForChannel(sourceChannel);
  if (
    sourceGuardian &&
    sourceGuardian.contact.principalId === anchoredPrincipalId
  ) {
    return resolveGuardianName(sourceGuardian.contact.displayName);
  }

  // Fall back to the vellum-channel guardian with the same anchor check.
  const vellumGuardian = findGuardianForChannel("vellum");
  if (
    vellumGuardian &&
    vellumGuardian.contact.principalId === anchoredPrincipalId
  ) {
    return resolveGuardianName(vellumGuardian.contact.displayName);
  }

  // No anchored guardian found — use generic fallback.
  return resolveGuardianName(undefined);
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
  sourceMetadata: Record<string, unknown> | undefined;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  replyCallbackUrl: string | undefined;
  mintBearerToken: () => string;
  assistantId: string;
  externalMessageId: string;
}

/** Resolved contact + channel pair from ACL enforcement. */
export type ResolvedMember = {
  contact: ContactWithChannels;
  channel: ContactChannel;
};

export interface AclResult {
  resolvedMember: ResolvedMember | null;
  /** When set, the caller must return this response immediately. */
  earlyResponse?: Response;
  /**
   * Parsed guardian verification code from the message content, if any.
   * Surfaced here so downstream verification intercept logic can use it
   * without re-parsing.
   */
  guardianVerifyCode: string | undefined;
}

/**
 * Strip Slack/Telegram mrkdwn formatting wrappers from a raw message.
 * When users copy-paste a verification code from the desktop app with
 * rich-text formatting (e.g. bold), Slack preserves it as `*code*` in
 * the message text, which would otherwise fail the strict bare-code regex.
 */
function stripMrkdwnFormatting(text: string): string {
  // Bold (*…*), italic (_…_), strikethrough (~…~), inline code (`…`)
  return text.replace(/^[*_~`]+/, "").replace(/[*_~`]+$/, "");
}

/**
 * Parse a guardian verification code from message content.
 * Accepts a bare code as the entire message: 6-digit numeric OR 64-char hex
 * (hex is retained for compatibility with unbound inbound/bootstrap sessions
 * that intentionally use high-entropy secrets).
 *
 * Strips surrounding mrkdwn formatting characters first so that codes
 * pasted with bold/italic/code formatting are still recognized.
 */
function parseGuardianVerifyCode(content: string): string | undefined {
  const stripped = stripMrkdwnFormatting(content);
  const bareMatch = stripped.match(/^([0-9a-fA-F]{64}|\d{6})$/);
  if (bareMatch) return bareMatch[1];

  return undefined;
}

/** Map ChannelStatus to the API-facing member status (excludes "unverified"). */
export function channelStatusToMemberStatus(
  status: ChannelStatus,
): Exclude<ChannelStatus, "unverified"> {
  if (status === "unverified") return "pending";
  return status;
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
    mintBearerToken,
    assistantId,
    externalMessageId,
  } = params;

  let resolvedMember: ResolvedMember | null = null;

  // Verification codes must bypass the ACL membership check — users without a
  // member record need to verify before they can be recognized as members.
  const guardianVerifyCode = parseGuardianVerifyCode(trimmedContent);
  const isGuardianVerifyCode = guardianVerifyCode !== undefined;

  // /start gv_<token> bootstrap commands must also bypass ACL — the user
  // hasn't been verified yet and needs to complete the bootstrap handshake.
  const rawCommandIntentForAcl = sourceMetadata?.commandIntent;
  const isBootstrapCommand =
    rawCommandIntentForAcl &&
    typeof rawCommandIntentForAcl === "object" &&
    !Array.isArray(rawCommandIntentForAcl) &&
    (rawCommandIntentForAcl as Record<string, unknown>).type === "start" &&
    typeof (rawCommandIntentForAcl as Record<string, unknown>).payload ===
      "string" &&
    (
      (rawCommandIntentForAcl as Record<string, unknown>).payload as string
    ).startsWith("gv_");

  // Parse invite token from /start payloads using the channel transport
  // adapter. The token is extracted once here so both the ACL bypass and
  // the intercept handler can reference it without re-parsing.
  const commandIntentForAcl =
    rawCommandIntentForAcl &&
    typeof rawCommandIntentForAcl === "object" &&
    !Array.isArray(rawCommandIntentForAcl)
      ? (rawCommandIntentForAcl as Record<string, unknown>)
      : undefined;
  const inviteAdapter = getInviteAdapterRegistry().get(sourceChannel);
  const inviteToken = inviteAdapter?.extractInboundToken?.({
    commandIntent: commandIntentForAcl,
    content: trimmedContent,
    sourceMetadata,
  });

  if (canonicalSenderId || hasSenderIdentityClaim) {
    // Only perform member lookup when we have a usable canonical ID.
    // Whitespace-only senders (hasSenderIdentityClaim=true but
    // canonicalSenderId=null) skip the lookup and fall into the deny path.
    if (canonicalSenderId) {
      const contactResult = findContactChannel({
        channelType: sourceChannel,
        externalUserId: canonicalSenderId,
        externalChatId: conversationExternalId,
      });
      resolvedMember = contactResult
        ? {
            contact: contactResult.contact,
            channel: contactResult.channel,
          }
        : null;
    }

    if (!resolvedMember) {
      // Determine whether a verification-code bypass is warranted: only allow
      // when there is a pending (unconsumed, unexpired) challenge AND no
      // active guardian binding for this (assistantId, channel).
      let denyNonMember = true;
      if (isGuardianVerifyCode) {
        // Allow bypass when there is any consumable challenge or active
        // outbound session.  The !hasActiveBinding guard is intentionally
        // omitted: rebind sessions create a consumable challenge while a
        // binding already exists, and the identity check inside
        // validateAndConsumeVerification prevents unauthorized takeovers.
        const hasPendingChallenge = !!getPendingSession(sourceChannel);
        const hasActiveOutboundSession = !!findActiveSession(sourceChannel);
        if (hasPendingChallenge || hasActiveOutboundSession) {
          denyNonMember = false;
        } else {
          log.info(
            { sourceChannel, hasPendingChallenge, hasActiveOutboundSession },
            "Ingress ACL: guardian verification bypass denied",
          );
        }
      }

      // Bootstrap deep-link commands bypass ACL only when the token
      // resolves to a real pending_bootstrap session. Without this check,
      // any `/start gv_<garbage>` would bypass the not_a_member gate and
      // fall through to normal /start processing.
      if (isBootstrapCommand) {
        const bootstrapPayload = (
          rawCommandIntentForAcl as Record<string, unknown>
        ).payload as string;
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
        } else {
          log.info(
            { sourceChannel, hasValidBootstrapSession: false },
            "Ingress ACL: bootstrap command bypass denied — no valid pending_bootstrap session",
          );
        }
      }

      // ── Invite token intercept (non-member) ──
      // /start invite deep links grant access without guardian approval.
      // Intercept here — before the deny gate — so valid invites short-circuit
      // the ACL rejection and never reach the agent pipeline.
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
          bearerToken: mintBearerToken(),
          assistantId,
          canonicalAssistantId,
        });
        if (inviteResult)
          return {
            resolvedMember: null,
            earlyResponse: inviteResult,
            guardianVerifyCode,
          };
      }

      // ── 6-digit invite code intercept (non-member) ──
      // On channels with codeRedemptionEnabled, a bare 6-digit message may be
      // an invite code. Attempt redemption; on failure (no matching code) fall
      // through to normal processing — the number may be a regular message.
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
          bearerToken: mintBearerToken(),
          assistantId,
          canonicalAssistantId,
        });
        if (codeInterceptResult)
          return {
            resolvedMember: null,
            earlyResponse: codeInterceptResult,
            guardianVerifyCode,
          };
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
              notifyGuardianOfAccessRequest({
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
                await deliverChannelReply(
                  dmCallbackUrl,
                  {
                    chatId: senderUserId,
                    text: `I don't recognize you yet! I've let ${resolveGuardianLabel(sourceChannel, canonicalAssistantId)} know you're trying to reach me. They'll need to share a 6-digit verification code with you — ask them directly if you know them. Once you have the code, reply here with it.`,
                    assistantId,
                  },
                  mintBearerToken(),
                );
              } catch (err) {
                log.error(
                  { err, senderUserId },
                  "Failed to deliver Slack verification DM to requester",
                );
              }
            }

            return {
              resolvedMember: null,
              earlyResponse: Response.json({
                accepted: true,
                denied: true,
                reason: "verification_challenge_sent",
                verificationSessionId: slackVerifyResult.sessionId,
              }),
              guardianVerifyCode,
            };
          }
        }

        // Notify the guardian about the access request so they can approve/deny.
        // Uses the shared helper which handles guardian binding lookup,
        // deduplication, canonical request creation, and notification emission.
        let guardianNotified = false;
        try {
          const accessResult = notifyGuardianOfAccessRequest({
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
          });
          guardianNotified = accessResult.notified;
        } catch (err) {
          log.error(
            { err, sourceChannel, conversationExternalId },
            "Failed to notify guardian of access request",
          );
        }

        const replyText = guardianNotified
          ? `Hmm looks like you don't have access to talk to me. I'll let ${resolveGuardianLabel(sourceChannel, canonicalAssistantId)} know you tried talking to me and get back to you.`
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
            await deliverChannelReply(
              replyCallbackUrl,
              replyPayload,
              mintBearerToken(),
            );
            replyDelivered = true;
          } catch (err) {
            log.error(
              { err, conversationExternalId },
              "Failed to deliver ACL rejection reply",
            );
          }
        }

        // Email uses 403 so the platform knows not to persist the message
        // (prevents prompt injection from unknown senders). Other channels
        // use 200 to prevent provider webhook suspension.
        const denyStatus = sourceChannel === "email" ? 403 : 200;

        return {
          resolvedMember: null,
          earlyResponse: Response.json(
            {
              accepted: sourceChannel !== "email",
              denied: true,
              reason: "not_a_member",
              ...(!replyDelivered && { replyText }),
            },
            { status: denyStatus },
          ),
          guardianVerifyCode,
        };
      }
    }

    if (resolvedMember) {
      if (resolvedMember.channel.status !== "active") {
        const isBlockedMember = resolvedMember.channel.status === "blocked";
        // Same bypass logic as the no-member branch: verification codes and
        // bootstrap commands must pass through for re-verifiable states
        // (pending/revoked), but never for blocked members.
        let denyInactiveMember = true;
        if (!isBlockedMember && isGuardianVerifyCode) {
          const hasPendingChallenge = !!getPendingSession(sourceChannel);
          const hasActiveOutboundSession = !!findActiveSession(sourceChannel);
          if (hasPendingChallenge || hasActiveOutboundSession) {
            denyInactiveMember = false;
          } else {
            log.info(
              {
                sourceChannel,
                channelId: resolvedMember.channel.id,
                hasPendingChallenge,
                hasActiveOutboundSession,
              },
              "Ingress ACL: inactive member verification bypass denied",
            );
          }
        }
        if (!isBlockedMember && isBootstrapCommand) {
          const bootstrapPayload = (
            rawCommandIntentForAcl as Record<string, unknown>
          ).payload as string;
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
          } else {
            log.info(
              {
                sourceChannel,
                channelId: resolvedMember.channel.id,
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
        // redemption path.
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
            bearerToken: mintBearerToken(),
            assistantId,
            canonicalAssistantId,
          });
          if (inviteResult)
            return {
              resolvedMember: null,
              earlyResponse: inviteResult,
              guardianVerifyCode,
            };
        }

        // ── 6-digit invite code intercept (inactive member) ──
        // Codes can reactivate revoked/pending members; non-matching codes
        // fall through. Blocked members are excluded here for consistency —
        // the redemption service would reject them anyway, but early exit
        // avoids unnecessary work.
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
            bearerToken: mintBearerToken(),
            assistantId,
            canonicalAssistantId,
          });
          if (codeInterceptResult)
            return {
              resolvedMember: null,
              earlyResponse: codeInterceptResult,
              guardianVerifyCode,
            };
        }

        if (denyInactiveMember) {
          log.info(
            {
              sourceChannel,
              channelId: resolvedMember.channel.id,
              status: resolvedMember.channel.status,
            },
            "Ingress ACL: member not active, denying",
          );

          // Slack-specific: re-verify inactive members via DM challenge
          // (same as non-member path). Blocked members are excluded —
          // the guardian made an explicit decision to block them.
          if (
            sourceChannel === "slack" &&
            resolvedMember.channel.status !== "blocked" &&
            (canonicalSenderId ?? rawSenderId)
          ) {
            const slackVerifyResult = initiateSlackVerificationChallenge({
              sourceChannel,
              senderUserId: (canonicalSenderId ?? rawSenderId)!,
            });

            if (slackVerifyResult.initiated) {
              try {
                notifyGuardianOfAccessRequest({
                  canonicalAssistantId,
                  sourceChannel,
                  conversationExternalId,
                  actorExternalId: canonicalSenderId ?? rawSenderId,
                  actorDisplayName,
                  actorUsername,
                  previousMemberStatus: channelStatusToMemberStatus(
                    resolvedMember.channel.status,
                  ),
                  messagePreview: truncate(
                    trimmedContent,
                    MESSAGE_PREVIEW_MAX_LENGTH,
                  ),
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
                  await deliverChannelReply(
                    dmCallbackUrl,
                    {
                      chatId: senderUserId,
                      text: `I don't recognize you yet! I've let ${resolveGuardianLabel(sourceChannel, canonicalAssistantId)} know you're trying to reach me. They'll need to share a 6-digit verification code with you — ask them directly if you know them. Once you have the code, reply here with it.`,
                      assistantId,
                    },
                    mintBearerToken(),
                  );
                } catch (err) {
                  log.error(
                    { err, senderUserId },
                    "Failed to deliver Slack verification DM to requester (inactive member)",
                  );
                }
              }

              return {
                resolvedMember,
                earlyResponse: Response.json({
                  accepted: true,
                  denied: true,
                  reason: "verification_challenge_sent",
                  verificationSessionId: slackVerifyResult.sessionId,
                }),
                guardianVerifyCode,
              };
            }
          }

          // For revoked/pending members, notify the guardian so they can
          // re-approve. Blocked members are intentionally excluded — the
          // guardian already made an explicit decision to block them.
          let guardianNotified = false;
          if (resolvedMember.channel.status !== "blocked") {
            try {
              const accessResult = notifyGuardianOfAccessRequest({
                canonicalAssistantId,
                sourceChannel,
                conversationExternalId,
                actorExternalId: canonicalSenderId ?? rawSenderId,
                actorDisplayName,
                actorUsername,
                previousMemberStatus: channelStatusToMemberStatus(
                  resolvedMember.channel.status,
                ),
                messagePreview: truncate(
                  trimmedContent,
                  MESSAGE_PREVIEW_MAX_LENGTH,
                ),
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
            ? `Hmm looks like you don't have access to talk to me. I'll let ${resolveGuardianLabel(sourceChannel, canonicalAssistantId)} know you tried talking to me and get back to you.`
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
              await deliverChannelReply(
                replyCallbackUrl,
                inactiveReplyPayload,
                mintBearerToken(),
              );
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
            earlyResponse: Response.json({
              accepted: true,
              denied: true,
              reason: `member_${channelStatusToMemberStatus(resolvedMember.channel.status)}`,
              ...(!inactiveReplyDelivered && { replyText: inactiveReplyText }),
            }),
            guardianVerifyCode,
          };
        }
      }

      if (resolvedMember.channel.policy === "deny") {
        log.info(
          { sourceChannel, channelId: resolvedMember.channel.id },
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
            await deliverChannelReply(
              replyCallbackUrl,
              denyPayload,
              mintBearerToken(),
            );
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
          earlyResponse: Response.json({
            accepted: true,
            denied: true,
            reason: "policy_deny",
            ...(!denyReplyDelivered && { replyText: denyReplyText }),
          }),
          guardianVerifyCode,
        };
      }

      // 'allow' or 'escalate' — update last seen timestamp.
      // touchContactInteraction is intentionally NOT called here because
      // duplicate detection hasn't run yet. It's called in
      // inbound-message-handler.ts after dedup so webhook retries don't
      // inflate interaction counts.
      touchChannelLastSeen(resolvedMember.channel.id);
    }
  }

  return { resolvedMember, guardianVerifyCode };
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
  bearerToken?: string;
  assistantId?: string;
  canonicalAssistantId: string;
}): Promise<Response | null> {
  const {
    rawToken,
    sourceChannel,
    externalChatId,
    externalMessageId,
    senderExternalUserId,
    senderName,
    senderUsername,
    replyCallbackUrl,
    bearerToken,
    assistantId,
    canonicalAssistantId,
  } = params;

  // Record the inbound event for dedup tracking BEFORE performing redemption.
  // Without this, duplicate webhook deliveries (common with Telegram) would
  // not be tracked: the first delivery redeems the invite and returns early,
  // then the retry finds an active member, passes ACL, and the raw
  // /start iv_<token> message leaks into the agent pipeline.
  const dedupResult = deliveryCrud.recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { assistantId: canonicalAssistantId },
  );

  if (dedupResult.duplicate) {
    return Response.json({
      accepted: true,
      duplicate: true,
      eventId: dedupResult.eventId,
    });
  }

  const outcome = redeemInvite({
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
        await deliverChannelReply(
          replyCallbackUrl,
          {
            chatId: externalChatId,
            text: replyText,
            assistantId,
          },
          bearerToken,
        );
      } catch (err) {
        log.error(
          { err, externalChatId },
          "Failed to deliver invite already-member reply",
        );
      }
    }
    deliveryStatus.markProcessed(dedupResult.eventId);
    return Response.json({
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "already_member",
    });
  }

  const replyText = getInviteRedemptionReply(outcome);

  if (replyCallbackUrl) {
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, externalChatId },
        "Failed to deliver invite redemption reply",
      );
    }
  }

  if (outcome.ok && outcome.type === "redeemed") {
    deliveryStatus.markProcessed(dedupResult.eventId);
    return Response.json({
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "redeemed",
      memberId: outcome.memberId,
    });
  }

  // Failed redemption — inform the user and deny
  deliveryStatus.markProcessed(dedupResult.eventId);
  return Response.json({
    accepted: true,
    eventId: dedupResult.eventId,
    denied: true,
    inviteRedemption: outcome.reason,
  });
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
  bearerToken?: string;
  assistantId?: string;
  canonicalAssistantId: string;
}): Promise<Response | null> {
  const {
    code,
    sourceChannel,
    externalChatId,
    externalMessageId,
    senderExternalUserId,
    senderName,
    senderUsername,
    replyCallbackUrl,
    bearerToken,
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
      const dedupResult = deliveryCrud.recordInbound(
        sourceChannel,
        externalChatId,
        externalMessageId,
        { assistantId: canonicalAssistantId },
      );

      if (dedupResult.duplicate) {
        return Response.json({
          accepted: true,
          duplicate: true,
          eventId: dedupResult.eventId,
        });
      }

      const mismatchReply = "This invite is not valid for this channel.";
      if (replyCallbackUrl) {
        try {
          await deliverChannelReply(
            replyCallbackUrl,
            {
              chatId: externalChatId,
              text: mismatchReply,
              assistantId,
            },
            bearerToken,
          );
        } catch (err) {
          log.error(
            { err, externalChatId },
            "Failed to deliver invite code channel-mismatch reply",
          );
        }
      }
      deliveryStatus.markProcessed(dedupResult.eventId);
      return Response.json({
        accepted: true,
        eventId: dedupResult.eventId,
        denied: true,
        inviteRedemption: "channel_mismatch",
      });
    }
    return null;
  }

  // Record the inbound event for dedup tracking BEFORE performing redemption,
  // matching the token intercept path. Without this, duplicate webhook
  // deliveries could slip through: the first delivery redeems the invite and
  // activates membership, then a retry finds an active member, passes ACL,
  // and the raw 6-digit message leaks into the agent pipeline.
  const dedupResult = deliveryCrud.recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { assistantId: canonicalAssistantId },
  );

  if (dedupResult.duplicate) {
    return Response.json({
      accepted: true,
      duplicate: true,
      eventId: dedupResult.eventId,
    });
  }

  let outcome: ReturnType<typeof redeemInviteByCode>;
  try {
    outcome = redeemInviteByCode({
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
    deliveryCrud.deleteInbound(dedupResult.eventId);
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
        await deliverChannelReply(
          replyCallbackUrl,
          {
            chatId: externalChatId,
            text: replyText,
            assistantId,
          },
          bearerToken,
        );
      } catch (err) {
        log.error(
          { err, externalChatId },
          "Failed to deliver invite code already-member reply",
        );
      }
    }
    deliveryStatus.markProcessed(dedupResult.eventId);
    return Response.json({
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "already_member",
    });
  }

  const replyText = getInviteRedemptionReply(outcome);

  if (replyCallbackUrl) {
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, externalChatId },
        "Failed to deliver invite code redemption reply",
      );
    }
  }

  if (outcome.ok && outcome.type === "redeemed") {
    deliveryStatus.markProcessed(dedupResult.eventId);
    return Response.json({
      accepted: true,
      eventId: dedupResult.eventId,
      inviteRedemption: "redeemed",
      memberId: outcome.memberId,
    });
  }

  // Failed redemption (expired, revoked, etc.) — inform and deny
  deliveryStatus.markProcessed(dedupResult.eventId);
  return Response.json({
    accepted: true,
    eventId: dedupResult.eventId,
    denied: true,
    inviteRedemption: !outcome.ok ? outcome.reason : undefined,
  });
}

// ---------------------------------------------------------------------------
// Slack verification challenge
// ---------------------------------------------------------------------------

interface SlackVerificationResult {
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
}): SlackVerificationResult {
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
