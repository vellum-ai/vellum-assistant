/**
 * Deterministic, template-based copy generation for notification deliveries.
 *
 * This is the fallback path used when the decision engine's LLM-generated
 * copy is unavailable (fallbackUsed === true). It generates reasonable
 * copy from the signal's sourceEventName, contextPayload, and attentionHints.
 *
 * Each source event name has a set of fallback templates that interpolate
 * values from the context payload.
 */

import type { NotificationSignal } from './signal.js';
import type { NotificationChannel, RenderedChannelCopy } from './types.js';

type CopyTemplate = (payload: Record<string, unknown>) => RenderedChannelCopy;

function str(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

// Templates keyed by free-form sourceEventName strings.
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
 * Compose fallback notification copy for a signal when the decision
 * engine's LLM path is unavailable.
 *
 * Returns a map of channel -> RenderedChannelCopy for the requested channels.
 * All channels currently receive the same template output; per-channel
 * customisation can be layered on later.
 */
export function composeFallbackCopy(
  signal: NotificationSignal,
  channels: NotificationChannel[],
): Partial<Record<NotificationChannel, RenderedChannelCopy>> {
  const template = TEMPLATES[signal.sourceEventName];

  const baseCopy: RenderedChannelCopy = template
    ? template(signal.contextPayload)
    : buildGenericCopy(signal);

  const result: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
  for (const ch of channels) {
    result[ch] = { ...baseCopy };
  }
  return result;
}

/**
 * Build generic copy when no template matches. Uses the signal's
 * sourceEventName and attention hints to produce something reasonable.
 */
function buildGenericCopy(signal: NotificationSignal): RenderedChannelCopy {
  const humanName = signal.sourceEventName.replace(/_/g, ' ');
  const urgencyPrefix = signal.attentionHints.urgency === 'high' ? 'Urgent: ' : '';
  const actionSuffix = signal.attentionHints.requiresAction ? ' — action required' : '';

  return {
    title: 'Notification',
    body: `${urgencyPrefix}${humanName}${actionSuffix}`,
  };
}
