/**
 * Gateway → daemon inbound payload contract.
 *
 * Zod schema defining the wire format for messages forwarded from the
 * gateway to the daemon via `POST /v1/channels/inbound`. Both services
 * import from here so the contract is enforced at compile time.
 *
 * The gateway constructs this payload in `forwardToRuntime()` from the
 * normalized `GatewayInboundEvent`; the daemon validates and consumes
 * it in `handleChannelInbound()`.
 */

import { z } from "zod";

import { AdmissionPolicySchema } from "./admission-policy-contract.js";
import { TrustVerdictSchema } from "./trust-verdict-contract.js";

// ---------------------------------------------------------------------------
// Command intent (channel-initiated commands, e.g. Telegram /start)
// ---------------------------------------------------------------------------

export const CommandIntentSchema = z.object({
  type: z.string(),
  payload: z.string().optional(),
});

export type CommandIntent = z.infer<typeof CommandIntentSchema>;

// ---------------------------------------------------------------------------
// Source metadata — structured fields forwarded from the gateway's
// normalized inbound event. Replaces the untyped Record<string, unknown>.
// ---------------------------------------------------------------------------

export const SourceMetadataSchema = z
  .object({
    /** Provider-assigned update/event ID. */
    updateId: z.string().optional(),
    /** Provider message ID (e.g. Slack message `ts`). */
    messageId: z.string().optional(),
    /** Provider chat type (e.g. Telegram "private", "group"). */
    chatType: z.string().optional(),
    /** Thread/conversation-group ID (e.g. Slack `thread_ts`). */
    threadId: z.string().optional(),
    /** Channel name (e.g. Slack channel display name). */
    channelName: z.string().optional(),
    /** Actor's language code (e.g. "en", "es"). */
    languageCode: z.string().optional(),
    /** Whether the actor is a bot. */
    isBot: z.boolean().optional(),
    /** Actor's IANA timezone (e.g. "America/Los_Angeles"). */
    timezone: z.string().optional(),
    /** Human-readable timezone label (e.g. "Pacific Daylight Time"). */
    timezoneLabel: z.string().optional(),
    /** UTC offset in seconds. */
    timezoneOffsetSeconds: z.number().optional(),
    /** Slack-specific: actor is from an external workspace (Slack Connect). */
    isStranger: z.boolean().optional(),
    /** Slack-specific: actor is a guest / restricted account. */
    isRestricted: z.boolean().optional(),
    /** Transport-layer hints forwarded from the channel adapter. */
    hints: z.array(z.string()).optional(),
    /** Transport-layer UX brief. */
    uxBrief: z.string().optional(),
    /** Client-provided timezone for date formatting. */
    clientTimezone: z.string().optional(),
    /** Channel command intent (e.g. Telegram /start). */
    commandIntent: CommandIntentSchema.optional(),
    /** Slack-specific: whether the bot was @-mentioned. */
    slackBotMentioned: z.boolean().optional(),
    /** Slack workspace/team ID. */
    account: z.string().optional(),
    /**
     * Slack-specific: team ID the inbound actor belongs to. Threads to the
     * daemon as the `recipient_team_id` for channel reply streaming.
     */
    actorTeamId: z.string().optional(),

    /**
     * Per-channel inbound admission policy attached by the gateway. The
     * runtime admission-policy stage enforces the floor against the
     * resolved trust class; when absent, the runtime falls back to
     * `ADMISSION_POLICY_DEFAULT` (`trusted_contacts`).
     */
    admissionPolicy: AdmissionPolicySchema.optional(),

    /**
     * Per-actor trust verdict resolved by the gateway from its ACL DB;
     * absent until the gateway stamps it. Consumers must treat absence as
     * "not provided", never as a decision.
     */
    trustVerdict: TrustVerdictSchema.optional(),

    // Email-specific fields
    /** Email subject line. */
    emailSubject: z.string().optional(),
    /** Email recipient address. */
    emailRecipient: z.string().optional(),
    /** Email In-Reply-To header. */
    emailInReplyTo: z.string().optional(),
    /** Email References header. */
    emailReferences: z.string().optional(),
  })
  .passthrough();

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

// ---------------------------------------------------------------------------
// Runtime inbound payload — the full wire format
// ---------------------------------------------------------------------------

export const RuntimeInboundPayloadSchema = z.object({
  sourceChannel: z.string(),
  interface: z.string(),
  conversationExternalId: z.string(),
  externalMessageId: z.string(),
  content: z.string(),
  isEdit: z.boolean().optional(),
  callbackQueryId: z.string().optional(),
  callbackData: z.string().optional(),
  actorDisplayName: z.string().optional(),
  actorExternalId: z.string(),
  actorUsername: z.string().optional(),
  sourceMetadata: SourceMetadataSchema.optional(),
  attachmentIds: z.array(z.string()).optional(),
  replyCallbackUrl: z.string().optional(),
});

export type RuntimeInboundPayload = z.infer<typeof RuntimeInboundPayloadSchema>;
