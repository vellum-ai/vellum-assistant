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
  { id: "schedule.notify", description: "Scheduled notification triggered (one-shot or recurring)" },
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
  {
    id: "ride_shotgun.invitation",
    description: "Invitation to ride shotgun on a session",
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

export interface NotificationEventContextPayloadMap {
  "guardian.question": GuardianQuestionPayload;
}

export type NotificationContextPayload<TEventName extends string = string> =
  TEventName extends keyof NotificationEventContextPayloadMap
    ? NotificationEventContextPayloadMap[TEventName]
    : Record<string, unknown>;

export interface NotificationSignal<TEventName extends string = string> {
  signalId: string;
  createdAt: number; // epoch ms
  sourceChannel: NotificationSourceChannel; // see NOTIFICATION_SOURCE_CHANNELS registry
  sourceSessionId: string;
  sourceEventName: TEventName; // free-form: 'reminder_fired', 'schedule_complete', 'guardian_question', etc.
  contextPayload: NotificationContextPayload<TEventName>;
  attentionHints: AttentionHints;
  /** Routing intent from the source (e.g. reminder). Controls post-decision channel enforcement. */
  routingIntent?: RoutingIntent;
  /** Free-form hints from the source for the decision engine (e.g. preferred channels). */
  routingHints?: Record<string, unknown>;
  /**
   * Per-channel conversation affinity hint. When set, the decision engine
   * must force thread reuse to the specified conversation for that channel,
   * bypassing LLM judgment. Used to enforce deterministic guardian thread
   * affinity within a call session.
   */
  conversationAffinityHint?: Partial<Record<string, string>>;
}
