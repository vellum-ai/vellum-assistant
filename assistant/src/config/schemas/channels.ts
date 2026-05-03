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
    botUserId: z
      .string({ error: "slack.botUserId must be a string" })
      .default("")
      .describe("Slack bot user ID"),
    botUsername: z
      .string({ error: "slack.botUsername must be a string" })
      .default("")
      .describe("Slack bot display name"),
  })
  .describe("Slack channel configuration");
