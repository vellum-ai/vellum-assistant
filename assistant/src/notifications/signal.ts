/**
 * NotificationSignal -- the flexible input from producers.
 * Uses free-form event names and structured attention hints that let the
 * decision engine route contextually.
 */

import type { GuardianQuestionPayload } from "./guardian-question-mode.js";

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
  sourceChannel: string; // free-form: 'vellum', 'telegram', 'voice', 'scheduler', etc.
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
