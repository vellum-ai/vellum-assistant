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
  CheckCircle,
  CircleDashed,
  Hash,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  RefreshCw,
  Send,
  Smartphone,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { ChannelId } from "@vellumai/service-contracts/channels";

import { DiscordLogo } from "@/components/icons/discord-logo";

import type { TagTone } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";
import type { AssistantChannelState } from "@/types/channel-types";

/**
 * Channels a client may be asked to draw before the availability response
 * arrives, which is why these are declared here rather than read from it:
 * several call sites are plain functions that cannot await a query.
 *
 * Listed once and shared by both maps below, so a channel cannot gain a label
 * and lose an icon. `satisfies` ties the list to the canonical vocabulary, so
 * a typo or a retired channel fails to compile rather than rendering a
 * fallback nobody notices.
 */
const RENDERED_CHANNELS = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "phone",
  "email",
  "a2a",
] as const satisfies readonly ChannelId[];

type RenderedChannel = (typeof RENDERED_CHANNELS)[number];

/** A channel's own svg mark, which sizes itself rather than taking a class. */
type BrandMark = typeof DiscordLogo;

/**
 * Whether an id is one of the channels drawn here. A plugin channel's id is
 * its plugin name, so what arrives at these lookups is any string, and this
 * is what separates the ones with an entry from the ones that fall back.
 */
function isRenderedChannel(id: string): id is RenderedChannel {
  return (RENDERED_CHANNELS as readonly string[]).includes(id);
}

const CHANNEL_LABELS: Record<RenderedChannel, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  phone: "Phone",
  email: "Email",
  a2a: "Assistant",
};

const CHANNEL_ICONS: Record<RenderedChannel, LucideIcon> = {
  // Slack has a brand SVG used in the header; this `#` glyph is its
  // Lucide stand-in for compact surfaces (sidebar section, footer fallback).
  slack: Hash,
  // Discord names its text channels the way Slack does, so it borrows the same
  // stand-in here. The brand mark is used where a surface has room for one.
  discord: Hash,
  telegram: Send,
  whatsapp: MessageCircle,
  phone: Phone,
  email: Mail,
  a2a: Bot,
};

/**
 * How a channel's operational health reads: which icon and words report it,
 * and the tone a design-library Tag would wear.
 *
 * Shared because two surfaces render the same verdict inside different
 * chrome. The Channels tab draws it as a Tag; the Contacts row draws it as
 * the inverted pill its sibling rows already use, so it cannot simply
 * borrow that component. Only the chrome differs, and a second copy of the
 * mapping is what would let one surface start saying something the other
 * does not.
 *
 * Absent health reads as connected: the channel measures nothing
 * operational, so there is no outage to report.
 */
const HEALTH_BADGES = {
  ok: {
    icon: CheckCircle,
    labelKey: "connectionCard.connected",
    tone: "positive",
  },
  failing: {
    icon: RefreshCw,
    labelKey: "connectionCard.reconnecting",
    tone: "warning",
  },
  unknown: {
    icon: CircleDashed,
    labelKey: "connectionCard.statusUnavailable",
    tone: "neutral",
  },
} as const satisfies Record<
  "ok" | "failing" | "unknown",
  { icon: LucideIcon; labelKey: string; tone: TagTone }
>;

export function useChannelHealthBadge(
  health: AssistantChannelState["health"],
): { Icon: LucideIcon; label: string; tone: TagTone } {
  const { t } = useTranslation("channels");
  const { icon, labelKey, tone } = HEALTH_BADGES[health ?? "ok"];
  return { Icon: icon, label: t(labelKey), tone };
}

/**
 * Human label for a channel id. Falls back to a Title-Cased version of the
 * id so a newly-added channel renders acceptably before it gets an entry
 * here. Returns a generic "channel" when the id is missing.
 */
export function getChannelLabel(channelId: string | null | undefined): string {
  if (!channelId) {
    return "channel";
  }
  return isRenderedChannel(channelId)
    ? CHANNEL_LABELS[channelId]
    : channelId.charAt(0).toUpperCase() + channelId.slice(1);
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
 * (header tag, footer secondary label). Channels with a brand mark still
 * answer with a Lucide stand-in here, since these surfaces are too small to
 * carry one; a caller with room renders the brand svg itself. An id with no
 * entry, which includes every plugin channel, gets the neutral message icon.
 */
export function getChannelIcon(
  channelId: string | null | undefined,
): LucideIcon {
  if (channelId && isRenderedChannel(channelId)) {
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
 * Brand marks for channels that ship one, keyed by channel rather than by the
 * declared glyph: `ChannelInfo.icon` carries a Lucide name and a brand svg is
 * not one. A channel absent here draws the Lucide glyph it declared, which
 * every client can resolve.
 */
const CHANNEL_BRAND_MARKS: Partial<Record<RenderedChannel, BrandMark>> = {
  discord: DiscordLogo,
};

/**
 * The brand mark for a channel, for a surface with room to draw one. Returns
 * nothing when the channel has none, and the caller falls back to the glyph.
 */
export function getChannelBrandMark(
  channelId: string | null | undefined,
): BrandMark | undefined {
  return channelId && isRenderedChannel(channelId)
    ? CHANNEL_BRAND_MARKS[channelId]
    : undefined;
}

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
