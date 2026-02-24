/**
 * Deterministic, template-based copy generation for notification deliveries.
 *
 * Each notification type has a set of fallback templates that interpolate
 * values from the event payload. Model-driven generation can be layered
 * on top later — the deterministic path guarantees delivery reliability
 * even when the LLM is unavailable or slow.
 */

import { NotificationType, type NotificationChannel } from './types.js';

export interface ComposedCopy {
  title: string;
  body: string;
  threadTitle?: string;
  threadSeedMessage?: string;
}

type CopyTemplate = (payload: Record<string, unknown>) => ComposedCopy;

function str(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

const TEMPLATES: Record<NotificationType, CopyTemplate> = {
  [NotificationType.ReminderFired]: (payload) => ({
    title: 'Reminder',
    body: str(payload.message, str(payload.label, 'A reminder has fired')),
  }),

  [NotificationType.ScheduleComplete]: (payload) => ({
    title: 'Schedule Complete',
    body: `${str(payload.name, 'A schedule')} has finished running`,
  }),

  [NotificationType.GuardianQuestionRequiredAction]: (payload) => ({
    title: 'Guardian Question',
    body: str(payload.questionText, 'A guardian question needs your attention'),
  }),

  [NotificationType.IngressEscalationRequiredAction]: (_payload) => ({
    title: 'Escalation',
    body: 'An incoming message needs attention',
  }),

  [NotificationType.ToolConfirmationRequiredAction]: (payload) => ({
    title: 'Tool Confirmation',
    body: str(payload.toolName, 'A tool') + ' requires your confirmation',
  }),

  [NotificationType.ActivityComplete]: (payload) => ({
    title: 'Activity Complete',
    body: str(payload.summary, 'An activity has completed'),
  }),

  [NotificationType.QuickChatResponseReady]: (payload) => ({
    title: 'Response Ready',
    body: str(payload.preview, 'Your quick chat response is ready'),
  }),

  [NotificationType.VoiceResponseReady]: (payload) => ({
    title: 'Voice Response',
    body: str(payload.preview, 'A voice response is ready'),
  }),

  [NotificationType.RideShotgunInvitation]: (payload) => ({
    title: 'Ride Shotgun',
    body: str(payload.message, 'You have been invited to ride shotgun'),
  }),
};

/**
 * Generate notification copy for the given type, channel, and payload.
 *
 * The `channel` parameter is accepted for future per-channel customisation
 * (e.g. shorter copy for push notifications) but is currently unused — all
 * channels receive the same template output.
 */
export function composeCopy(
  type: NotificationType,
  _channel: NotificationChannel,
  payload: Record<string, unknown>,
): ComposedCopy {
  const template = TEMPLATES[type];
  if (!template) {
    return {
      title: 'Notification',
      body: 'You have a new notification',
    };
  }
  return template(payload);
}
