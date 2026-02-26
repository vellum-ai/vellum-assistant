/**
 * Surface-aware thread seed message composer.
 *
 * Generates richer seed content for notification threads than the concise
 * title/body used in native notification popups. Verbosity adapts to the
 * delivery surface: vellum/macos gets flowing prose, telegram gets compact.
 *
 * Composes from `copy.title/body` rather than hardcoded English templates
 * so LLM-localized copy is preserved for non-English users.
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
 * Min-length is 3 (not higher) to support concise CJK text.
 */
export function isThreadSeedSane(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (trimmed.length > 2000) return false;
  // Reject raw JSON dumps
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return true;
}

/**
 * Compose a thread seed message from signal context.
 *
 * Builds from `copy.title` and `copy.body` so that LLM-localized content
 * is preserved. Surface-aware formatting makes the seed richer on
 * desktop (flowing prose) and compact on mobile (title + body separated).
 */
export function composeThreadSeed(
  signal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
): string {
  const verbosity = resolveVerbosity(channel, signal.contextPayload);

  if (verbosity === 'rich') {
    const parts: string[] = [];
    if (copy.title && copy.title !== 'Notification') parts.push(copy.title);
    if (copy.body) parts.push(copy.body);
    if (signal.attentionHints.requiresAction && parts.length > 0) {
      parts.push('Action required.');
    }
    if (parts.length > 0) {
      return parts.join('. ').replace(/\.\./g, '.');
    }
  }

  return `${copy.title}\n\n${copy.body}`;
}
