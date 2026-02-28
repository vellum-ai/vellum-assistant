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
import {
  buildGuardianRequestCodeInstruction,
  resolveGuardianQuestionInstructionMode,
} from './guardian-question-mode.js';
import type { NotificationChannel, RenderedChannelCopy } from './types.js';

type CopyTemplate = (payload: Record<string, unknown>) => RenderedChannelCopy;

function str(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

export function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Templates keyed by dot-separated sourceEventName strings matching producers.
const TEMPLATES: Record<string, CopyTemplate> = {
  'reminder.fired': (payload) => ({
    title: 'Reminder',
    body: str(payload.message, str(payload.label, 'A reminder has fired')),
  }),

  'schedule.complete': (payload) => ({
    title: 'Schedule Complete',
    body: `${str(payload.name, 'A schedule')} has finished running`,
  }),

  'guardian.question': (payload) => {
    const question = str(payload.questionText, 'A guardian question needs your attention');
    const requestCode = nonEmpty(typeof payload.requestCode === 'string' ? payload.requestCode : undefined);
    if (!requestCode) {
      return {
        title: 'Guardian Question',
        body: question,
      };
    }

    const normalizedCode = requestCode.toUpperCase();
    const modeResolution = resolveGuardianQuestionInstructionMode(payload);
    const instruction = buildGuardianRequestCodeInstruction(normalizedCode, modeResolution.mode);
    return {
      title: 'Guardian Question',
      body: `${question}\n\n${instruction}`,
    };
  },

  'ingress.access_request': (payload) => {
    const requester = str(payload.senderIdentifier, 'Someone');
    const requestCode = nonEmpty(typeof payload.requestCode === 'string' ? payload.requestCode : undefined);
    const sourceChannel = typeof payload.sourceChannel === 'string' ? payload.sourceChannel : undefined;
    const callerName = nonEmpty(typeof payload.senderName === 'string' ? payload.senderName : undefined);
    const lines: string[] = [];

    // Voice-originated access requests include caller name context
    if (sourceChannel === 'voice' && callerName) {
      lines.push(`${callerName} (${str(payload.senderExternalUserId, requester)}) is calling and requesting access to the assistant.`);
    } else {
      lines.push(`${requester} is requesting access to the assistant.`);
    }

    if (requestCode) {
      const code = requestCode.toUpperCase();
      lines.push(`Reply "${code} approve" to grant access or "${code} reject" to deny.`);
    }
    lines.push('Reply "open invite flow" to start Trusted Contacts invite flow.');
    return {
      title: 'Access Request',
      body: lines.join('\n'),
    };
  },

  'ingress.escalation': (payload) => ({
    title: 'Escalation',
    body: str(payload.senderIdentifier, 'An incoming message') + ' needs attention',
  }),

  'watcher.notification': (payload) => ({
    title: str(payload.title, 'Watcher Notification'),
    body: str(payload.body, 'A watcher event occurred'),
  }),

  'watcher.escalation': (payload) => ({
    title: str(payload.title, 'Watcher Escalation'),
    body: str(payload.body, 'A watcher event requires your attention'),
  }),

  'tool_confirmation.required_action': (payload) => ({
    title: 'Tool Confirmation',
    body: str(payload.toolName, 'A tool') + ' requires your confirmation',
  }),

  'activity.complete': (payload) => ({
    title: 'Activity Complete',
    body: str(payload.summary, 'An activity has completed'),
  }),

  'quick_chat.response_ready': (payload) => ({
    title: 'Response Ready',
    body: str(payload.preview, 'Your quick chat response is ready'),
  }),

  'voice.response_ready': (payload) => ({
    title: 'Voice Response',
    body: str(payload.preview, 'A voice response is ready'),
  }),

  'ride_shotgun.invitation': (payload) => ({
    title: 'Ride Shotgun',
    body: str(payload.message, 'You have been invited to ride shotgun'),
  }),
};

/**
 * Compose fallback notification copy for a signal when the decision
 * engine's LLM path is unavailable.
 *
 * Returns a map of channel -> RenderedChannelCopy for the requested channels.
 * Base title/body content comes from templates, then channel-specific
 * defaults are applied (for example Telegram deliveryText).
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
    result[ch] = applyChannelDefaults(ch, baseCopy, signal);
  }
  return result;
}

function applyChannelDefaults(
  channel: NotificationChannel,
  baseCopy: RenderedChannelCopy,
  signal: NotificationSignal,
): RenderedChannelCopy {
  const copy: RenderedChannelCopy = { ...baseCopy };

  if (channel === 'telegram' || channel === 'sms') {
    copy.deliveryText = buildChatSurfaceFallbackDeliveryText(baseCopy, signal);
  }

  return copy;
}

function buildChatSurfaceFallbackDeliveryText(
  baseCopy: RenderedChannelCopy,
  signal: NotificationSignal,
): string {
  const explicit = nonEmpty(baseCopy.deliveryText);
  if (explicit) return explicit;

  const body = nonEmpty(baseCopy.body);
  if (body) return body;

  const title = nonEmpty(baseCopy.title);
  if (title) return title;

  return signal.sourceEventName.replace(/[._]/g, ' ');
}

/**
 * Build generic copy when no template matches. Uses the signal's
 * sourceEventName and attention hints to produce something reasonable.
 */
function buildGenericCopy(signal: NotificationSignal): RenderedChannelCopy {
  const humanName = signal.sourceEventName.replace(/[._]/g, ' ');
  const urgencyPrefix = signal.attentionHints.urgency === 'high' ? 'Urgent: ' : '';
  const actionSuffix = signal.attentionHints.requiresAction ? ' — action required' : '';

  return {
    title: 'Notification',
    body: `${urgencyPrefix}${humanName}${actionSuffix}`,
  };
}
