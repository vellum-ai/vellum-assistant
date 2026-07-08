/**
 * NotificationSignal -- the flexible input from producers.
 * Uses free-form event names and structured attention hints that let the
 * decision engine route contextually.
 *
 * All data shapes are defined as Zod schemas — types are derived via
 * `z.infer` so runtime validation and compile-time types stay in sync.
 */

import { z } from "zod";

import type { ConversationCreateType } from "../persistence/conversation-crud.js";
import type { GuardianQuestionPayload } from "./guardian-question-mode.js";
import { UrgencySchema } from "./urgency.js";

// ── Source channel registry ────────────────────────────────────────────

export const NOTIFICATION_SOURCE_CHANNELS = [
  { id: "assistant_tool", description: "Assistant skill/tool invocation" },
  { id: "vellum", description: "Vellum native client (macOS/iOS)" },
  { id: "phone", description: "Phone call pipeline" },
  { id: "telegram", description: "Telegram channel" },
  { id: "whatsapp", description: "WhatsApp channel" },
  { id: "slack", description: "Slack channel" },
  { id: "email", description: "Email channel" },
  { id: "platform", description: "Platform-managed channel" },
  { id: "a2a", description: "Agent-to-agent protocol channel" },
  { id: "scheduler", description: "Scheduled task runner (reminders, cron)" },
  { id: "watcher", description: "File/event watcher subsystem" },
] as const;

export type NotificationSourceChannel =
  (typeof NOTIFICATION_SOURCE_CHANNELS)[number]["id"];

/** Typed tuple of all source channel IDs — usable with `z.enum()`. */
export const NOTIFICATION_SOURCE_CHANNEL_IDS = NOTIFICATION_SOURCE_CHANNELS.map(
  (c) => c.id,
) as unknown as readonly [
  NotificationSourceChannel,
  ...NotificationSourceChannel[],
];

export const NotificationSourceChannelSchema = z.enum(
  NOTIFICATION_SOURCE_CHANNEL_IDS,
);

export function isNotificationSourceChannel(
  value: unknown,
): value is NotificationSourceChannel {
  return (
    typeof value === "string" &&
    NOTIFICATION_SOURCE_CHANNELS.some((c) => c.id === value)
  );
}

// ── Source event name registry ─────────────────────────────────────────

export const NOTIFICATION_SOURCE_EVENT_NAMES = [
  {
    id: "user.send_notification",
    description: "User-initiated notification via assistant tool",
  },
  {
    id: "schedule.notify",
    description: "Scheduled notification triggered (one-shot or recurring)",
  },
  {
    id: "guardian.question",
    description: "Guardian approval question requiring response",
  },
  {
    id: "guardian.channel_activation",
    description:
      "Guardian channel activation code delivered for /start verification",
  },
  { id: "ingress.access_request", description: "Non-member requesting access" },
  {
    id: "ingress.access_request.callback_handoff",
    description: "Caller requested callback while unreachable",
  },
  {
    id: "ingress.escalation",
    description: "Incoming message escalated for attention",
  },
  {
    id: "ingress.trusted_contact.guardian_decision",
    description: "Guardian decided on trusted contact request",
  },
  {
    id: "ingress.trusted_contact.denied",
    description: "Trusted contact request denied",
  },
  {
    id: "ingress.trusted_contact.verification_sent",
    description: "Verification sent to trusted contact",
  },
  {
    id: "ingress.trusted_contact.activated",
    description: "Trusted contact activated",
  },
  {
    id: "watcher.notification",
    description: "Watcher detected a notable event",
  },
  {
    id: "watcher.escalation",
    description: "Watcher event requiring immediate attention",
  },
  {
    id: "tool_confirmation.required_action",
    description: "Tool requires user confirmation before executing",
  },
  { id: "activity.complete", description: "Background activity finished" },
  {
    id: "activity.failed",
    description:
      "Background job execution failed (model_provider, exception, or timeout)",
  },
  {
    id: "quick_chat.response_ready",
    description: "Quick chat response ready for review",
  },
  {
    id: "voice.response_ready",
    description: "Voice response ready for playback",
  },
  {
    id: "credential.health_alert",
    description:
      "OAuth credential health issue detected (expired, revoked, missing scopes)",
  },
] as const;

export type NotificationSourceEventName =
  (typeof NOTIFICATION_SOURCE_EVENT_NAMES)[number]["id"];

// ── Attention hints & routing ──────────────────────────────────────────

export const AttentionHintsSchema = z.object({
  requiresAction: z.boolean(),
  urgency: UrgencySchema,
  deadlineAt: z.number().optional(),
  isAsyncBackground: z.boolean(),
  visibleInSourceNow: z.boolean(),
});
export type AttentionHints = z.infer<typeof AttentionHintsSchema>;

export const RoutingIntentSchema = z.enum([
  "single_channel",
  "multi_channel",
  "all_channels",
]);
export type RoutingIntent = z.infer<typeof RoutingIntentSchema>;

// ── Typed context payloads ──────────────────────────────────────────────

/**
 * How the guardian was resolved for an access request.
 *
 * - `"source-channel-contact"` — Guardian was found via the originating channel's
 *   contact store and their principalId matches the assistant's anchor.
 * - `"vellum-anchor"` — No same-channel guardian matched; fell back to the
 *   assistant's vellum guardian principal.
 * - `"none"` — No guardian binding could be resolved at all.
 *
 * Downstream consumers (notification copy, routing) use this to decide whether
 * to append a "Was this you?" CTA or route notifications beyond the source channel.
 * This is channel-agnostic by design — any channel's access request that
 * resolves to a non-source-channel guardian gets the same treatment.
 */
export const GuardianResolutionSourceSchema = z.enum([
  "source-channel-contact",
  "vellum-anchor",
  "none",
]);
export type GuardianResolutionSource = z.infer<
  typeof GuardianResolutionSourceSchema
>;

export const AccessRequestContextPayloadSchema = z.object({
  requestId: z.string(),
  requestCode: z.string(),
  sourceChannel: z.string(),
  conversationExternalId: z.string(),
  actorExternalId: z.string(),
  actorDisplayName: z.string().nullable(),
  actorUsername: z.string().nullable(),
  senderIdentifier: z.string(),
  guardianBindingChannel: z.string().nullable(),
  guardianResolutionSource: GuardianResolutionSourceSchema,
  previousMemberStatus: z.string().nullable(),
  messagePreview: z.string().nullable(),
  isBot: z.boolean().optional(),
  isStranger: z.boolean().optional(),
  isRestricted: z.boolean().optional(),
  messageTs: z.string().optional(),
  /** `admitted` marks an introduction nudge for a floor-admitted sender. */
  trigger: z.enum(["denied", "admitted"]).optional(),
});
export type AccessRequestContextPayload = z.infer<
  typeof AccessRequestContextPayloadSchema
>;

export const GuardianChannelActivationPayloadSchema = z.object({
  verificationCode: z.string(),
  sourceChannel: z.string(),
  actorExternalId: z.string(),
  actorDisplayName: z.string().nullable(),
  actorUsername: z.string().nullable(),
  sessionId: z.string(),
  expiresAt: z.number(),
});
export type GuardianChannelActivationPayload = z.infer<
  typeof GuardianChannelActivationPayloadSchema
>;

export interface NotificationEventContextPayloadMap {
  "guardian.question": GuardianQuestionPayload;
  "ingress.access_request": AccessRequestContextPayload;
  "guardian.channel_activation": GuardianChannelActivationPayload;
}

export type NotificationContextPayload<TEventName extends string = string> =
  TEventName extends keyof NotificationEventContextPayloadMap
    ? NotificationEventContextPayloadMap[TEventName]
    : Record<string, unknown>;

export interface NotificationSignal<TEventName extends string = string> {
  signalId: string;
  createdAt: number; // epoch ms
  sourceChannel: NotificationSourceChannel; // see NOTIFICATION_SOURCE_CHANNELS registry
  sourceContextId: string;
  sourceEventName: TEventName; // free-form: 'reminder_fired', 'guardian_question', etc.
  contextPayload: NotificationContextPayload<TEventName>;
  attentionHints: AttentionHints;
  /** Routing intent from the source (e.g. reminder). Controls post-decision channel enforcement. */
  routingIntent?: RoutingIntent;
  /** Free-form hints from the source for the decision engine (e.g. preferred channels). */
  routingHints?: Record<string, unknown>;
  /**
   * Per-channel conversation affinity hint. When set, the decision engine
   * must force conversation reuse to the specified conversation for that channel,
   * bypassing LLM judgment. Used to enforce deterministic guardian conversation
   * affinity within a call session.
   */
  conversationAffinityHint?: Partial<Record<string, string>>;
  /**
   * Optional metadata propagated to the conversation created by the notification
   * pipeline. Allows signal producers (e.g. the scheduler) to set groupId,
   * scheduleJobId, or override the default "notification" source on the
   * resulting conversation so it appears in the correct folder on clients.
   */
  conversationMetadata?: {
    groupId?: string;
    scheduleJobId?: string;
    source?: string;
    conversationType?: ConversationCreateType;
  };
  /**
   * When true, the vellum-channel delivery materializes a fresh conversation
   * to host the notification (and any follow-up interaction). Set this only
   * for flows where the conversation IS the interaction surface — e.g.
   * guardian.question, tool grant requests, ingress access requests. Passive
   * notifications (scheduler fired, watcher alert, activity complete, etc.)
   * should leave this unset; they surface via the home feed and link back
   * to their originating conversation via `sourceContextId`.
   */
  requiresConversation?: boolean;
}
