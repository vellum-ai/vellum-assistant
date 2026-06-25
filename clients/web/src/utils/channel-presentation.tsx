/**
 * Channel presentation registry — the single source of truth for how an
 * external messaging channel (Slack, Telegram, WhatsApp, phone, …) is
 * labelled and iconified across the web client.
 *
 * Conversations that originate from an external channel are read-only in
 * the app (see `isChannelConversation`). The chat surface tags them — in
 * the header and in the read-only footer — with the channel's human label
 * and an icon so they read as distinct from native Vellum conversations.
 * This module is the "adapter" layer for that presentation: add a channel
 * here once and every surface picks it up.
 *
 * Channel ids match the daemon's `channelBinding.sourceChannel` /
 * `originChannel` values (see gateway `CHANNEL_IDS`).
 */

import { createElement } from "react";
import {
  Bot,
  Hash,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Send,
  type LucideIcon,
} from "lucide-react";

const CHANNEL_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  phone: "Phone",
  email: "Email",
  a2a: "Assistant",
};

/**
 * Channels the user can meaningfully reply to from the channel's own app.
 * Drives whether the read-only footer appends a "You can reply in X." hint
 * — omitted for one-way surfaces like `phone` (voice) where "reply there"
 * is not a coherent instruction.
 */
const REPLYABLE_CHANNELS = new Set([
  "slack",
  "telegram",
  "whatsapp",
  "email",
]);

const CHANNEL_ICONS: Record<string, LucideIcon> = {
  // Slack has a brand SVG used in the header; this `#` glyph is its
  // Lucide stand-in for compact surfaces (sidebar section, footer fallback).
  slack: Hash,
  telegram: Send,
  whatsapp: MessageCircle,
  phone: Phone,
  email: Mail,
  a2a: Bot,
};

/**
 * Human label for a channel id. Falls back to a Title-Cased version of the
 * id so a newly-added channel renders acceptably before it gets an entry
 * here. Returns a generic "channel" when the id is missing.
 */
export function getChannelLabel(channelId: string | null | undefined): string {
  if (!channelId) return "channel";
  return (
    CHANNEL_LABELS[channelId] ??
    channelId.charAt(0).toUpperCase() + channelId.slice(1)
  );
}

/**
 * Lucide icon component for a channel id, for use as a small inline glyph
 * (header tag, footer secondary label). Slack is intentionally absent — it
 * has a brand SVG that callers render directly — so this returns a neutral
 * message icon for it, matching the fallback for unknown channels.
 */
export function getChannelIcon(channelId: string | null | undefined): LucideIcon {
  if (channelId && CHANNEL_ICONS[channelId]) return CHANNEL_ICONS[channelId];
  return MessageSquare;
}

/**
 * Renders the channel's inline glyph as a static component, so callers can
 * place `<ChannelIcon channelId={…} />` in JSX without selecting an icon
 * component during render (which trips `react-hooks/static-components`).
 * Resolves to a stable module-level icon via {@link getChannelIcon}.
 */
export function ChannelIcon({
  channelId,
  className,
}: {
  channelId: string | null | undefined;
  className?: string;
}) {
  return createElement(getChannelIcon(channelId), {
    className,
    "aria-hidden": true,
  });
}

/**
 * Copy for the read-only footer of a channel conversation.
 *
 * `message` always states the conversation is read-only, and appends a
 * "You can reply in {label}." hint for channels the user can answer from
 * their own app. `label` is reused for the "Open in {label}" link.
 */
export function getChannelReadonlyCopy(channelId: string | null | undefined): {
  label: string;
  message: string;
} {
  const label = getChannelLabel(channelId);
  const canReply = channelId ? REPLYABLE_CHANNELS.has(channelId) : false;
  const message = canReply
    ? `This ${label} conversation is read-only. You can reply in ${label}.`
    : `This ${label} conversation is read-only.`;
  return { label, message };
}
