/**
 * Surface-aware thread seed message composer.
 *
 * Generates richer seed content for notification threads than the concise
 * title/body used in native notification popups. Verbosity adapts to the
 * delivery surface: vellum/macos gets 2-4 sentences, telegram gets 1-2.
 *
 * This runs in the daemon runtime (not via skills), ensuring every
 * notification thread has a readable seed message regardless of whether
 * the decision engine's LLM produced one.
 */

import { isInterfaceId } from '../channels/types.js';
import type { InterfaceId } from '../channels/types.js';
import type { NotificationSignal } from './signal.js';
import type { NotificationChannel, RenderedChannelCopy } from './types.js';

export type SurfaceVerbosity = 'rich' | 'compact';

const CHANNEL_DEFAULT_INTERFACE: Record<string, InterfaceId> = {
  vellum: 'macos',
  telegram: 'telegram',
};

const RICH_INTERFACES = new Set<InterfaceId>(['macos', 'ios', 'vellum']);

/**
 * Resolve verbosity level from delivery channel + optional interface hint.
 *
 * Inference strategy:
 *   1. Explicit `interfaceHint` in contextPayload if valid InterfaceId.
 *   2. `sourceInterface` from the originating conversation if valid.
 *   3. Channel default (vellum → macos → rich, telegram → compact).
 */
export function resolveVerbosity(
  channel: NotificationChannel,
  contextPayload: Record<string, unknown>,
): SurfaceVerbosity {
  const hint = contextPayload.interfaceHint;
  if (typeof hint === 'string' && isInterfaceId(hint)) {
    return RICH_INTERFACES.has(hint) ? 'rich' : 'compact';
  }

  const sourceIface = contextPayload.sourceInterface;
  if (typeof sourceIface === 'string' && isInterfaceId(sourceIface)) {
    return RICH_INTERFACES.has(sourceIface) ? 'rich' : 'compact';
  }

  const defaultIface = CHANNEL_DEFAULT_INTERFACE[channel];
  if (defaultIface && RICH_INTERFACES.has(defaultIface)) return 'rich';
  return 'compact';
}

/**
 * Check whether a model-provided threadSeedMessage is usable.
 *
 * Rejects empty strings, raw JSON dumps, and excessively long content.
 */
export function isThreadSeedSane(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 10) return false;
  if (trimmed.length > 2000) return false;
  // Reject raw JSON dumps
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return true;
}

function str(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

// ── Event-specific seed templates ───────────────────────────────────────

type SeedTemplate = (
  payload: Record<string, unknown>,
  signal: NotificationSignal,
  verbosity: SurfaceVerbosity,
) => string;

const SEED_TEMPLATES: Record<string, SeedTemplate> = {
  'reminder.fired': (payload, signal, verbosity) => {
    const message = str(payload.message, str(payload.label, 'A reminder has fired.'));
    if (verbosity === 'rich') {
      const parts = [`Reminder: ${message}`];
      if (signal.attentionHints.requiresAction) parts.push('This needs your attention.');
      return parts.join(' ');
    }
    return signal.attentionHints.requiresAction
      ? `Reminder: ${message} — action needed`
      : `Reminder: ${message}`;
  },

  'schedule.complete': (payload, _signal, verbosity) => {
    const name = str(payload.name, 'A schedule');
    if (verbosity === 'rich') {
      const summary = str(payload.summary, '');
      return summary
        ? `${name} has finished running. ${summary}`
        : `${name} has finished running. Check the results when you have a moment.`;
    }
    return `${name} has finished running.`;
  },

  'guardian.question': (payload, _signal, verbosity) => {
    const question = str(payload.questionText, 'A guardian question needs your attention.');
    if (verbosity === 'rich') {
      return `Guardian question: ${question} Reply in this thread to respond.`;
    }
    return `Guardian: ${question}`;
  },

  'ingress.escalation': (payload, signal, verbosity) => {
    const sender = str(payload.senderIdentifier, 'Someone');
    const preview = str(payload.preview, '');
    if (verbosity === 'rich') {
      const parts = [`${sender} sent a message that needs attention.`];
      if (preview) parts.push(`Preview: "${preview}"`);
      if (signal.attentionHints.requiresAction) parts.push('Please review and respond.');
      return parts.join(' ');
    }
    return `${sender} needs attention${preview ? `: "${preview}"` : '.'}`;
  },

  'tool_confirmation.required_action': (payload, _signal, verbosity) => {
    const toolName = str(payload.toolName, 'A tool');
    if (verbosity === 'rich') {
      return `${toolName} requires your confirmation before proceeding. Open this thread to review and approve the action.`;
    }
    return `${toolName} needs confirmation.`;
  },

  'activity.complete': (payload, _signal, verbosity) => {
    const summary = str(payload.summary, 'An activity has completed.');
    if (verbosity === 'rich') {
      return `Activity complete. ${summary}`;
    }
    return summary;
  },

  'quick_chat.response_ready': (payload, _signal, verbosity) => {
    const preview = str(payload.preview, 'Your response is ready.');
    if (verbosity === 'rich') {
      return `Your quick chat response is ready. ${preview}`;
    }
    return preview;
  },

  'watcher.notification': (payload, _signal, verbosity) => {
    const title = str(payload.title, 'Watcher');
    const body = str(payload.body, 'A watcher event occurred.');
    if (verbosity === 'rich') {
      return `${title}: ${body}`;
    }
    return body;
  },

  'watcher.escalation': (payload, signal, verbosity) => {
    const title = str(payload.title, 'Watcher Escalation');
    const body = str(payload.body, 'A watcher event requires your attention.');
    if (verbosity === 'rich') {
      const parts = [`${title}: ${body}`];
      if (signal.attentionHints.requiresAction) parts.push('Please review promptly.');
      return parts.join(' ');
    }
    return `${title}: ${body}`;
  },

  'voice.response_ready': (payload, _signal, verbosity) => {
    const preview = str(payload.preview, 'A voice response is ready.');
    if (verbosity === 'rich') {
      return `Voice response ready. ${preview}`;
    }
    return preview;
  },

  'ride_shotgun.invitation': (payload, _signal, verbosity) => {
    const message = str(payload.message, 'You have been invited to ride shotgun.');
    if (verbosity === 'rich') {
      return `Ride Shotgun invitation: ${message}`;
    }
    return message;
  },
};

/**
 * Compose a thread seed message from signal context.
 *
 * Returns a readable, surface-aware seed that is richer than the concise
 * notification title/body. Used as the fallback when the decision engine
 * does not produce a usable threadSeedMessage.
 */
export function composeThreadSeed(
  signal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
): string {
  const verbosity = resolveVerbosity(channel, signal.contextPayload);
  const template = SEED_TEMPLATES[signal.sourceEventName];

  if (template) {
    return template(signal.contextPayload, signal, verbosity);
  }

  return composeGenericSeed(signal, copy, verbosity);
}

function composeGenericSeed(
  signal: NotificationSignal,
  copy: RenderedChannelCopy,
  verbosity: SurfaceVerbosity,
): string {
  if (verbosity === 'rich') {
    const parts: string[] = [];
    if (copy.title && copy.title !== 'Notification') parts.push(copy.title);
    if (copy.body) parts.push(copy.body);
    if (signal.attentionHints.requiresAction) parts.push('Action required.');
    return parts.filter(Boolean).join('. ').replace(/\.\./g, '.');
  }

  return `${copy.title}\n\n${copy.body}`;
}
