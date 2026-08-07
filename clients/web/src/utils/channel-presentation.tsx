/**
 * Channel presentation registry — the single source of truth for how an
 * external messaging channel (Slack, Telegram, WhatsApp, phone, …) is
 * labelled and iconified across the web client.
 *
 * The chat surface tags conversations that originate from an external
 * channel — in the header and channel footer — with the channel's human
 * label and an icon so they read as distinct from native Vellum
 * conversations. This module is the "adapter" layer for that presentation:
 * add a channel here once and every surface picks it up.
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
  Smartphone,
  Video,
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
  if (!channelId) {
    return "channel";
  }
  return (
    CHANNEL_LABELS[channelId] ??
    channelId.charAt(0).toUpperCase() + channelId.slice(1)
  );
}

/**
 * Label for the "open this conversation in its source channel" affordance
 * (top-bar source pill, conversation-header menu item). One derivation so
 * the two surfaces can't drift.
 */
export function getOpenInChannelLabel(
  channelId: string | null | undefined,
): string {
  return `Open in ${getChannelLabel(channelId)}`;
}

/**
 * Lucide icon component for a channel id, for use as a small inline glyph
 * (header tag, footer secondary label). Slack is intentionally absent — it
 * has a brand SVG that callers render directly — so this returns a neutral
 * message icon for it, matching the fallback for unknown channels.
 */
export function getChannelIcon(
  channelId: string | null | undefined,
): LucideIcon {
  if (channelId && CHANNEL_ICONS[channelId]) {
    return CHANNEL_ICONS[channelId];
  }
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
 * Lucide icons a plugin channel may name in its `channels/channel.json`.
 *
 * A fixed map rather than a lookup over the whole `lucide-react` namespace:
 * resolving by name dynamically means importing every icon lucide ships, and
 * a settings rail is not worth that bundle. The declared name still travels
 * in the API for clients that can resolve it without the same cost.
 *
 * An unrecognised name falls back rather than failing. A plugin whose icon is
 * missing here renders as a generic channel, which is a smaller problem than
 * a blank row, and the fix is one entry.
 */
const PLUGIN_CHANNEL_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  hash: Hash,
  mail: Mail,
  "message-circle": MessageCircle,
  "message-square": MessageSquare,
  phone: Phone,
  send: Send,
  smartphone: Smartphone,
  video: Video,
};

/**
 * Renders a plugin channel's declared glyph. Same static-component treatment
 * as {@link ChannelIcon}: the component is chosen from a module-level map
 * rather than constructed during render.
 */
export function PluginChannelIcon({
  icon,
  className,
}: {
  icon: string | null | undefined;
  className?: string;
}) {
  return createElement((icon && PLUGIN_CHANNEL_ICONS[icon]) || MessageSquare, {
    className,
    "aria-hidden": true,
  });
}
