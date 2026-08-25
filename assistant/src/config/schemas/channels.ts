import { z } from "zod";

export const TwilioConfigSchema = z
  .object({
    accountSid: z
      .string({ error: "twilio.accountSid must be a string" })
      .default("")
      .describe("Twilio account SID for API authentication"),
    phoneNumber: z
      .string({ error: "twilio.phoneNumber must be a string" })
      .default("")
      .describe("Twilio phone number used for outbound calls and SMS"),
    setupStarted: z
      .boolean({ error: "twilio.setupStarted must be a boolean" })
      .default(false)
      .describe("Whether Twilio setup has ever been started"),
  })
  .describe("Twilio account configuration");

export const WhatsAppConfigSchema = z
  .object({
    phoneNumber: z
      .string({ error: "whatsapp.phoneNumber must be a string" })
      .default("")
      .describe("WhatsApp Business phone number"),
    deliverAuthBypass: z
      .boolean({ error: "whatsapp.deliverAuthBypass must be a boolean" })
      .default(false)
      .describe(
        "Whether to bypass authentication when delivering WhatsApp messages",
      ),
    timeoutMs: z
      .number({ error: "whatsapp.timeoutMs must be a number" })
      .int("whatsapp.timeoutMs must be an integer")
      .positive("whatsapp.timeoutMs must be a positive integer")
      .default(15_000)
      .describe("Timeout for WhatsApp API requests in milliseconds"),
    maxRetries: z
      .number({ error: "whatsapp.maxRetries must be a number" })
      .int("whatsapp.maxRetries must be an integer")
      .nonnegative("whatsapp.maxRetries must be a non-negative integer")
      .default(3)
      .describe(
        "Maximum number of retry attempts for failed WhatsApp API requests",
      ),
    initialBackoffMs: z
      .number({ error: "whatsapp.initialBackoffMs must be a number" })
      .int("whatsapp.initialBackoffMs must be an integer")
      .positive("whatsapp.initialBackoffMs must be a positive integer")
      .default(1_000)
      .describe(
        "Initial backoff delay between retries in milliseconds (doubles on each retry)",
      ),
  })
  .describe("WhatsApp Business channel configuration");

export const TelegramConfigSchema = z
  .object({
    botId: z
      .string({ error: "telegram.botId must be a string" })
      .default("")
      .describe("Telegram bot ID"),
    botUsername: z
      .string({ error: "telegram.botUsername must be a string" })
      .default("")
      .describe("Telegram bot username (without the @ prefix)"),
    apiBaseUrl: z
      .string({ error: "telegram.apiBaseUrl must be a string" })
      .default("https://api.telegram.org")
      .describe("Base URL for the Telegram Bot API"),
    // Written by the gateway reconciler, read by the health sweep. Deployment
    // state rather than user configuration: it records where this deployment
    // last pointed Telegram, so the sweep can tell our own registration from a
    // stale tunnel address or another deployment's callback. Unset until a
    // reconciliation succeeds, which the sweep reports as unverified rather
    // than healthy. Stripped by sanitize-for-transfer, like
    // ingress.publicBaseUrlManagedBy, because it does not travel between hosts.
    registeredWebhookUrl: z
      .string({ error: "telegram.registeredWebhookUrl must be a string" })
      .optional()
      .describe(
        "Webhook URL this deployment last registered with Telegram (managed by the gateway)",
      ),
    deliverAuthBypass: z
      .boolean({ error: "telegram.deliverAuthBypass must be a boolean" })
      .default(false)
      .describe(
        "Whether to bypass authentication when delivering Telegram messages",
      ),
    timeoutMs: z
      .number({ error: "telegram.timeoutMs must be a number" })
      .int("telegram.timeoutMs must be an integer")
      .positive("telegram.timeoutMs must be a positive integer")
      .default(15_000)
      .describe("Timeout for Telegram API requests in milliseconds"),
    maxRetries: z
      .number({ error: "telegram.maxRetries must be a number" })
      .int("telegram.maxRetries must be an integer")
      .nonnegative("telegram.maxRetries must be a non-negative integer")
      .default(3)
      .describe(
        "Maximum number of retry attempts for failed Telegram API requests",
      ),
    initialBackoffMs: z
      .number({ error: "telegram.initialBackoffMs must be a number" })
      .int("telegram.initialBackoffMs must be an integer")
      .positive("telegram.initialBackoffMs must be a positive integer")
      .default(1_000)
      .describe(
        "Initial backoff delay between retries in milliseconds (doubles on each retry)",
      ),
  })
  .describe("Telegram bot channel configuration");

export const A2AConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "a2a.enabled must be a boolean" })
      .default(false)
      .describe("Whether the A2A channel is enabled"),
  })
  .describe("Agent-to-Agent protocol channel configuration");

/**
 * Discord channel settings.
 *
 * All three are read back from Discord when a bot token validates and written
 * here so a connected panel can name the bot and build an install link
 * without another round trip. The bot user and the application are separate
 * ids: they coincide today, and a link built on that assumption would break
 * silently if they stopped.
 */
export const DiscordConfigSchema = z
  .object({
    botUserId: z
      .string({ error: "discord.botUserId must be a string" })
      .default("")
      .describe("Discord bot user ID"),
    botUsername: z
      .string({ error: "discord.botUsername must be a string" })
      .default("")
      .describe("Discord bot display name"),
    applicationId: z
      .string({ error: "discord.applicationId must be a string" })
      .default("")
      .describe("Discord application ID the bot belongs to"),
    inviteUrl: z
      .string({ error: "discord.inviteUrl must be a string" })
      .default("")
      .describe(
        "Install link for the bot's application, computed when a token validates",
      ),
  })
  .describe("Discord channel configuration");

export const SlackConfigSchema = z
  .object({
    deliverAuthBypass: z
      .boolean({ error: "slack.deliverAuthBypass must be a boolean" })
      .default(false)
      .describe(
        "Whether to bypass authentication when delivering Slack messages",
      ),
    teamId: z
      .string({ error: "slack.teamId must be a string" })
      .default("")
      .describe("Slack workspace team ID"),
    teamName: z
      .string({ error: "slack.teamName must be a string" })
      .default("")
      .describe("Slack workspace team name"),
    teamUrl: z
      .string({ error: "slack.teamUrl must be a string" })
      .default("")
      .describe("Slack workspace URL"),
    botUserId: z
      .string({ error: "slack.botUserId must be a string" })
      .default("")
      .describe("Slack bot user ID"),
    botUsername: z
      .string({ error: "slack.botUsername must be a string" })
      .default("")
      .describe("Slack bot display name"),
    threadMode: z
      .enum(["mention_only", "mention_then_thread"], {
        error:
          "slack.threadMode must be 'mention_only' or 'mention_then_thread'",
      })
      .default("mention_then_thread")
      .describe(
        "Controls whether the bot follows threads after an initial @mention. " +
          "'mention_only' requires every message to @-mention the bot. " +
          "'mention_then_thread' auto-follows the thread after the first mention.",
      ),
  })
  .describe("Slack channel configuration");
