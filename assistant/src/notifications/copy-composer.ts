/**
 * Deterministic, template-based copy generation for notification deliveries.
 *
 * Each source event name has a set of fallback templates that interpolate
 * values from the event payload. Model-driven generation can be layered
 * on top later -- the deterministic path guarantees delivery reliability
 * even when the LLM is unavailable or slow.
 */

import type { NotificationChannel } from './types.js';

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

// Templates keyed by free-form sourceEventName strings instead of enum values.
const TEMPLATES: Record<string, CopyTemplate> = {
  reminder_fired: (payload) => ({
    title: 'Reminder',
    body: str(payload.message, str(payload.label, 'A reminder has fired')),
  }),

  schedule_complete: (payload) => ({
    title: 'Schedule Complete',
    body: `${str(payload.name, 'A schedule')} has finished running`,
  }),

  guardian_question_required_action: (payload) => ({
    title: 'Guardian Question',
    body: str(payload.questionText, 'A guardian question needs your attention'),
  }),

  ingress_escalation_required_action: (_payload) => ({
    title: 'Escalation',
    body: 'An incoming message needs attention',
  }),

  tool_confirmation_required_action: (payload) => ({
    title: 'Tool Confirmation',
    body: str(payload.toolName, 'A tool') + ' requires your confirmation',
  }),

  activity_complete: (payload) => ({
    title: 'Activity Complete',
    body: str(payload.summary, 'An activity has completed'),
  }),

  quick_chat_response_ready: (payload) => ({
    title: 'Response Ready',
    body: str(payload.preview, 'Your quick chat response is ready'),
  }),

  voice_response_ready: (payload) => ({
    title: 'Voice Response',
    body: str(payload.preview, 'A voice response is ready'),
  }),

  ride_shotgun_invitation: (payload) => ({
    title: 'Ride Shotgun',
    body: str(payload.message, 'You have been invited to ride shotgun'),
  }),
};

/**
 * Generate notification copy for the given source event name, channel, and payload.
 *
 * The `channel` parameter is accepted for future per-channel customisation
 * (e.g. shorter copy for push notifications) but is currently unused -- all
 * channels receive the same template output.
 */
export function composeCopy(
  sourceEventName: string,
  _channel: NotificationChannel,
  payload: Record<string, unknown>,
): ComposedCopy {
  const template = TEMPLATES[sourceEventName];
  if (!template) {
    return {
      title: 'Notification',
      body: 'You have a new notification',
    };
  }
  return template(payload);
}
