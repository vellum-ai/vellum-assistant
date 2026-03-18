/**
 * NotificationSignal -- the flexible input from producers.
 * Uses free-form event names and structured attention hints that let the
 * decision engine route contextually.
 */

import type { GuardianQuestionPayload } from "./guardian-question-mode.js";

// ── Source channel registry ────────────────────────────────────────────

export const NOTIFICATION_SOURCE_CHANNELS = [
  { id: "assistant_tool", description: "Assistant skill/tool invocation" },
  { id: "vellum", description: "Vellum native client (macOS/iOS)" },
  { id: "phone", description: "Phone call pipeline" },
  { id: "telegram", description: "Telegram channel" },
  { id: "slack", description: "Slack channel" },
  { id: "scheduler", description: "Scheduled task runner (reminders, cron)" },
  { id: "watcher", description: "File/event watcher subsystem" },
] as const;

export type NotificationSourceChannel =
  (typeof NOTIFICATION_SOURCE_CHANNELS)[number]["id"];

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
  { id: "schedule.complete", description: "Scheduled task finished running" },
  {
    id: "guardian.question",
    description: "Guardian approval question requiring response",
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
    id: "quick_chat.response_ready",
    description: "Quick chat response ready for review",
  },
  {
    id: "voice.response_ready",
    description: "Voice response ready for playback",
  },
] as const;

export type NotificationSourceEventName =
  (typeof NOTIFICATION_SOURCE_EVENT_NAMES)[number]["id"];

export function isNotificationSourceEventName(
  value: unknown,
): value is NotificationSourceEventName {
  return (
    typeof value === "string" &&
    NOTIFICATION_SOURCE_EVENT_NAMES.some((e) => e.id === value)
  );
}

// ── Attention hints & routing ──────────────────────────────────────────

export interface AttentionHints {
  requiresAction: boolean;
  urgency: "low" | "medium" | "high";
  deadlineAt?: number; // epoch ms
  isAsyncBackground: boolean;
  visibleInSourceNow: boolean;
}

export type RoutingIntent = "single_channel" | "multi_channel" | "all_channels";

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
export type GuardianResolutionSource =
  | "source-channel-contact"
  | "vellum-anchor"
  | "none";

export interface AccessRequestContextPayload {
  requestId: string;
  requestCode: string;
  sourceChannel: string;
  conversationExternalId: string;
  actorExternalId: string;
  actorDisplayName: string | null;
  actorUsername: string | null;
  senderIdentifier: string;
  guardianBindingChannel: string | null;
  guardianResolutionSource: GuardianResolutionSource;
  previousMemberStatus: string | null;
}

export interface NotificationEventContextPayloadMap {
  "guardian.question": GuardianQuestionPayload;
  "ingress.access_request": AccessRequestContextPayload;
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
  sourceEventName: TEventName; // free-form: 'reminder_fired', 'schedule_complete', 'guardian_question', etc.
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
}
