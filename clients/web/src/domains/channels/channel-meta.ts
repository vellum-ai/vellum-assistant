import type { SetupChannelId } from "@/types/channel-types";

/**
 * Per-adapter presentation metadata for the Channels tab.
 *
 * The copy itself lives in the `channels` catalog; this module holds the keys
 * that reach it. A data module cannot call `useTranslation()`, and a plain
 * string here would render English whatever the active locale is, which is how
 * the disconnect dialog and the disconnected empty state stayed English after
 * the domain was otherwise converted.
 *
 * Shared by `AssistantChannelsList` (disconnect dialog) and `ChannelPanel`
 * (trust floor + empty state), so it lives in its own module rather than
 * having one component import it from the other.
 */
interface ChannelMeta {
  /** Catalog key for the disconnect-dialog subject ("Disconnect {label}?"). */
  labelKey:
    | "channelMeta.slack.label"
    | "channelMeta.telegram.label"
    | "channelMeta.discord.label"
    | "channelMeta.phone.label";
  /**
   * Catalog key for the disconnect dialog's body.
   *
   * Optional, and its absence is what says a channel cannot be disconnected
   * from here: there is no route that clears Discord's credentials, so an
   * offered button would open a dialog whose confirm does nothing. Read as a
   * capability the way the transport reads an absent method, rather than
   * naming the channel in the component.
   */
  disconnectMessageKey?:
    | "channelMeta.slack.disconnectMessage"
    | "channelMeta.telegram.disconnectMessage"
    | "channelMeta.phone.disconnectMessage";
  /**
   * Whether a connected channel surfaces the "Who can message" trust-floor
   * dropdown. Slack has none: its admission floors are managed per
   * conversation type (DMs vs. channels), with no channel-wide knob.
   */
  hasTrustFloorControl: boolean;
  /**
   * The credential form "Connect manually" opens, when the channel has one.
   *
   * Named rather than inferred. This was a two-way branch that rendered
   * Telegram's wizard for Telegram and Twilio's credential form for anything
   * else, so a channel with no manual form at all was offered Twilio's:
   * Discord asked for an Account SID and saved phone credentials under a
   * Discord heading. A fallthrough cannot express "no form", so the capability
   * is data, and a channel added later gets nothing rather than the last
   * branch of a ternary.
   */
  manualEntry?: "telegram-token" | "twilio-credentials";
  /**
   * Catalog key for the disconnected empty state's pitch, which interpolates
   * `assistant`. Slack has none: its disconnected state is the setup wizard.
   */
  disconnectedPitchKey?:
    | "channelMeta.telegram.disconnectedPitch"
    | "channelMeta.discord.disconnectedPitch"
    | "channelMeta.phone.disconnectedPitch";
}

export const CHANNEL_META: Record<SetupChannelId, ChannelMeta> = {
  slack: {
    labelKey: "channelMeta.slack.label",
    disconnectMessageKey: "channelMeta.slack.disconnectMessage",
    hasTrustFloorControl: false,
  },
  telegram: {
    labelKey: "channelMeta.telegram.label",
    disconnectMessageKey: "channelMeta.telegram.disconnectMessage",
    hasTrustFloorControl: true,
    manualEntry: "telegram-token",
    disconnectedPitchKey: "channelMeta.telegram.disconnectedPitch",
  },
  discord: {
    labelKey: "channelMeta.discord.label",
    hasTrustFloorControl: true,
    disconnectedPitchKey: "channelMeta.discord.disconnectedPitch",
  },
  phone: {
    labelKey: "channelMeta.phone.label",
    disconnectMessageKey: "channelMeta.phone.disconnectMessage",
    hasTrustFloorControl: true,
    manualEntry: "twilio-credentials",
    disconnectedPitchKey: "channelMeta.phone.disconnectedPitch",
  },
};
