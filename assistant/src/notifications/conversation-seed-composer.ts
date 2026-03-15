/**
 * Surface-aware conversation seed message composer.
 *
 * Generates richer seed content for notification conversations than the concise
 * title/body used in native notification popups. Verbosity adapts to the
 * delivery surface: vellum/macos gets flowing prose, telegram gets compact.
 *
 * Composes from `copy.title/body` rather than hardcoded English templates
 * so LLM-localized copy is preserved for non-English users.
 *
 * This runs in the daemon runtime (not via skills), ensuring every
 * notification conversation has a readable seed message regardless of whether
 * the decision engine's LLM produced one.
 */

import type { InterfaceId } from "../channels/types.js";
import { isInterfaceId } from "../channels/types.js";
import type { NotificationSignal } from "./signal.js";
import type { NotificationChannel, RenderedChannelCopy } from "./types.js";

export type SurfaceVerbosity = "rich" | "compact";

const CHANNEL_DEFAULT_INTERFACE: Record<string, InterfaceId> = {
  vellum: "macos",
  telegram: "telegram",
};

const RICH_INTERFACES = new Set<InterfaceId>(["macos", "ios", "vellum"]);

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
  if (typeof hint === "string" && isInterfaceId(hint)) {
    return RICH_INTERFACES.has(hint) ? "rich" : "compact";
  }

  const sourceIface = contextPayload.sourceInterface;
  if (typeof sourceIface === "string" && isInterfaceId(sourceIface)) {
    return RICH_INTERFACES.has(sourceIface) ? "rich" : "compact";
  }

  const defaultIface = CHANNEL_DEFAULT_INTERFACE[channel];
  if (defaultIface && RICH_INTERFACES.has(defaultIface)) return "rich";
  return "compact";
}

/**
 * Check whether a model-provided conversationSeedMessage is usable.
 *
 * Rejects empty strings, raw JSON dumps, and excessively long content.
 * Min-length is 3 (not higher) to support concise CJK text.
 */
export function isConversationSeedSane(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (trimmed.length > 2000) return false;
  // Reject raw JSON dumps
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}

/**
 * Build a human-readable label from a dot-delimited event name.
 *
 * e.g. "schedule.notify" → "Schedule notify", "guardian.question" → "Guardian question"
 */
function humanizeEventName(eventName: string): string {
  const words = eventName.replace(/[._]/g, " ").trim();
  if (words.length === 0) return "Notification";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Derive a fallback seed from signal metadata when rendered copy is blank.
 *
 * Extracts the most useful fields from `contextPayload` (common keys like
 * message, summary, body, preview, senderIdentifier, title, label, questionText) and combines
 * them with a humanized event name. This ensures notification conversations retain
 * usable audit context even when the decision engine produces empty copy.
 */
function buildContextFallback(signal: NotificationSignal): string {
  const label = humanizeEventName(signal.sourceEventName);
  const payload = signal.contextPayload;

  // Try common payload keys in priority order
  const candidateKeys = [
    "message",
    "summary",
    "body",
    "preview",
    "senderIdentifier",
    "title",
    "label",
    "questionText",
    "name",
  ];
  for (const key of candidateKeys) {
    const val = payload[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return `${label}: ${val.trim()}`;
    }
  }

  return label;
}

/**
 * Check whether rendered copy has usable content in title or body.
 */
function hasCopyContent(copy: RenderedChannelCopy): boolean {
  const hasTitle = Boolean(
    copy.title && copy.title.trim() && copy.title !== "Notification",
  );
  const hasBody = Boolean(copy.body && copy.body.trim());
  return hasTitle || hasBody;
}

/**
 * Compose a conversation seed message from signal context.
 *
 * Builds from `copy.title` and `copy.body` so that LLM-localized content
 * is preserved. Surface-aware formatting makes the seed richer on
 * desktop (flowing prose) and compact on mobile (title + body separated).
 *
 * When rendered copy is blank, falls back to signal metadata (event name
 * and context payload) so notification conversations always have usable content.
 */
export function composeConversationSeed(
  signal: NotificationSignal,
  channel: NotificationChannel,
  copy: RenderedChannelCopy,
): string {
  const verbosity = resolveVerbosity(channel, signal.contextPayload);

  // When copy is blank, fall back to context-based seed from signal metadata.
  if (!hasCopyContent(copy)) {
    return buildContextFallback(signal);
  }

  if (verbosity === "rich") {
    const parts: string[] = [];
    if (copy.title && copy.title !== "Notification") parts.push(copy.title);
    if (copy.body) parts.push(copy.body);
    const alreadyMentionsAction = parts.some((part) =>
      /\baction required\b/i.test(part),
    );
    if (
      signal.attentionHints.requiresAction &&
      parts.length > 0 &&
      !alreadyMentionsAction
    ) {
      parts.push("Action required.");
    }
    if (parts.length > 0) {
      return parts.join(". ").replace(/\.\./g, ".");
    }
  }

  return `${copy.title}\n\n${copy.body}`;
}
