import type { SetupChannelId } from "@/types/channel-types";

interface ChannelMeta {
  /** The disconnect-dialog subject ("Disconnect {label}?"). */
  label: string;
  disconnectMessage: string;
  /**
   * Whether a connected channel surfaces the "Who can message" trust-floor
   * dropdown. Slack has none: its admission floors are managed per
   * conversation type (DMs vs. channels), with no channel-wide knob.
   */
  hasTrustFloorControl: boolean;
  /** One-line pitch for the disconnected empty state. Slack has none — its disconnected state is the setup wizard. */
  disconnectedPitch?: (displayName: string) => string;
}

/**
 * Per-adapter presentation metadata for the Channels tab: disconnect-dialog
 * copy, whether the connected panel shows the trust-floor control, and the
 * disconnected-state pitch. Shared by `AssistantChannelsList` (disconnect
 * dialog) and `ChannelPanel` (trust floor + empty state), so it lives in its
 * own module rather than having one component import it from the other.
 */
export const CHANNEL_META: Record<SetupChannelId, ChannelMeta> = {
  slack: {
    label: "Slack",
    disconnectMessage:
      "This clears the stored Slack bot and app tokens for this assistant. You can reconnect later.",
    hasTrustFloorControl: false,
  },
  telegram: {
    label: "Telegram",
    disconnectMessage:
      "This clears the stored Telegram bot token for this assistant. You can reconnect later.",
    hasTrustFloorControl: true,
    disconnectedPitch: (displayName) =>
      `Connect a Telegram bot so ${displayName} can send and receive messages on Telegram.`,
  },
  phone: {
    label: "Phone Calling",
    disconnectMessage:
      "This clears the stored Twilio credentials for this assistant. You can reconnect later.",
    hasTrustFloorControl: true,
    disconnectedPitch: (displayName) =>
      `Connect your Twilio account so ${displayName} can make and answer phone calls.`,
  },
};
