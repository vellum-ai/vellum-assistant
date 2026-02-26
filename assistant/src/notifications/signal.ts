/**
 * NotificationSignal -- the flexible input from producers.
 * Uses free-form event names and structured attention hints that let the
 * decision engine route contextually.
 */

import type { NotificationChannel, ThreadCandidate } from './types.js';

export interface AttentionHints {
  requiresAction: boolean;
  urgency: 'low' | 'medium' | 'high';
  deadlineAt?: number; // epoch ms
  isAsyncBackground: boolean;
  visibleInSourceNow: boolean;
}

export type RoutingIntent = 'single_channel' | 'multi_channel' | 'all_channels';

export interface NotificationSignal {
  signalId: string;
  assistantId: string;
  createdAt: number; // epoch ms
  sourceChannel: string; // free-form: 'vellum', 'telegram', 'voice', 'scheduler', etc.
  sourceSessionId: string;
  sourceEventName: string; // free-form: 'reminder_fired', 'schedule_complete', 'guardian_question', etc.
  contextPayload: Record<string, unknown>;
  attentionHints: AttentionHints;
  /** Routing intent from the source (e.g. reminder). Controls post-decision channel enforcement. */
  routingIntent?: RoutingIntent;
  /** Free-form hints from the source for the decision engine (e.g. preferred channels). */
  routingHints?: Record<string, unknown>;
  /**
   * Per-channel candidate threads that the decision engine may select for reuse.
   * Built by the thread-candidates module and injected before the decision call.
   * Absent or empty means no reuse candidates are available (start_new only).
   */
  threadCandidates?: Partial<Record<NotificationChannel, ThreadCandidate[]>>;
}
