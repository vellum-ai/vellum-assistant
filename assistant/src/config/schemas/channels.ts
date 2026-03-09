import { z } from "zod";

export const TwilioConfigSchema = z.object({
  accountSid: z
    .string({ error: "twilio.accountSid must be a string" })
    .default(""),
  phoneNumber: z
    .string({ error: "twilio.phoneNumber must be a string" })
    .default(""),
});

export const WhatsAppConfigSchema = z.object({
  phoneNumber: z
    .string({ error: "whatsapp.phoneNumber must be a string" })
    .default(""),
  deliverAuthBypass: z
    .boolean({ error: "whatsapp.deliverAuthBypass must be a boolean" })
    .default(false),
  timeoutMs: z
    .number({ error: "whatsapp.timeoutMs must be a number" })
    .int("whatsapp.timeoutMs must be an integer")
    .positive("whatsapp.timeoutMs must be a positive integer")
    .default(15_000),
  maxRetries: z
    .number({ error: "whatsapp.maxRetries must be a number" })
    .int("whatsapp.maxRetries must be an integer")
    .nonnegative("whatsapp.maxRetries must be a non-negative integer")
    .default(3),
  initialBackoffMs: z
    .number({ error: "whatsapp.initialBackoffMs must be a number" })
    .int("whatsapp.initialBackoffMs must be an integer")
    .positive("whatsapp.initialBackoffMs must be a positive integer")
    .default(1_000),
});

export const TelegramConfigSchema = z.object({
  botUsername: z
    .string({ error: "telegram.botUsername must be a string" })
    .default(""),
  apiBaseUrl: z
    .string({ error: "telegram.apiBaseUrl must be a string" })
    .default("https://api.telegram.org"),
  deliverAuthBypass: z
    .boolean({ error: "telegram.deliverAuthBypass must be a boolean" })
    .default(false),
  timeoutMs: z
    .number({ error: "telegram.timeoutMs must be a number" })
    .int("telegram.timeoutMs must be an integer")
    .positive("telegram.timeoutMs must be a positive integer")
    .default(15_000),
  maxRetries: z
    .number({ error: "telegram.maxRetries must be a number" })
    .int("telegram.maxRetries must be an integer")
    .nonnegative("telegram.maxRetries must be a non-negative integer")
    .default(3),
  initialBackoffMs: z
    .number({ error: "telegram.initialBackoffMs must be a number" })
    .int("telegram.initialBackoffMs must be an integer")
    .positive("telegram.initialBackoffMs must be a positive integer")
    .default(1_000),
});

export const SlackConfigSchema = z.object({
  deliverAuthBypass: z
    .boolean({ error: "slack.deliverAuthBypass must be a boolean" })
    .default(false),
  teamId: z.string({ error: "slack.teamId must be a string" }).default(""),
  teamName: z.string({ error: "slack.teamName must be a string" }).default(""),
  botUserId: z
    .string({ error: "slack.botUserId must be a string" })
    .default(""),
  botUsername: z
    .string({ error: "slack.botUsername must be a string" })
    .default(""),
});

export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
