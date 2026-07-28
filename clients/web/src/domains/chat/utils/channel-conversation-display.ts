import type { ConversationChannelBinding } from "@/types/conversation-types";

function cleanLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Best-effort human label for a non-Slack channel conversation, derived
 * from the generic external-conversation binding fields the daemon
 * serializes for every channel (`externalChatName`, `displayName`,
 * `username`).
 *
 * Slack has its own richer derivation (channel vs DM, lazy name
 * resolution, deep links) in `slack-conversation-display.ts`; this is the
 * generic fallback used for Telegram, WhatsApp, phone, etc. — e.g. a
 * Telegram DM surfaces the sender's display name.
 *
 * The raw `externalChatId` (e.g. a Telegram numeric chat id) is treated as
 * a non-label fallback and intentionally omitted: it is not meaningful to
 * a human reader. Returns `undefined` when no friendly name is available,
 * in which case the header label falls back to the channel name alone.
 */
export function getChannelBindingDisplayText(
  binding: ConversationChannelBinding | null | undefined,
): string | undefined {
  if (!binding) return undefined;
  const name =
    cleanLabel(binding.externalChatName) ??
    cleanLabel(binding.displayName) ??
    cleanLabel(binding.username);
  if (!name) return undefined;
  if (name === binding.externalChatId) return undefined;
  return name;
}
