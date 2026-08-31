import type { SetupChannelId } from "@/types/channel-types";

/** A credential form a channel can declare it is set up through. */
export type ChannelCredentialForm =
  | "slack-wizard"
  | "telegram-token"
  | "discord-token"
  | "twilio-credentials";

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
    | "channelMeta.email.label"
    | "channelMeta.phone.label";
  /**
   * Catalog key for the disconnect dialog's body.
   *
   * Undefined when a channel cannot be disconnected from here. The
   * capability itself is the delete-route record (`DISCONNECT_ROUTES`); this
   * key is its confirm dialog's copy, and a test holds the two equal so
   * neither can drift. Required, not optional, so a new channel states the
   * answer instead of inheriting one by omission.
   */
  disconnectMessageKey:
    | "channelMeta.slack.disconnectMessage"
    | "channelMeta.telegram.disconnectMessage"
    | "channelMeta.discord.disconnectMessage"
    | "channelMeta.phone.disconnectMessage"
    | undefined;
  /**
   * Whether a connected channel surfaces the "Who can message" trust-floor
   * dropdown. Slack has none: its admission floors are managed per
   * conversation type (DMs vs. channels), with no channel-wide knob.
   */
  hasTrustFloorControl: boolean;
  /**
   * The credential form this channel is set up through, undefined when it
   * has none.
   *
   * One fact for both surfaces. The Channels tab and the assistant's setup
   * drawer render the same wizards, and differ only in where they are
   * mounted, so which form a channel has is a property of the channel rather
   * than of either surface. Whether the tab reaches it inline or behind
   * "Connect manually" is presentation and stays in the tab.
   *
   * Declared per channel rather than inferred from a branch, because a
   * fallthrough cannot express "no form" and would hand such a channel
   * whichever form the last arm renders.
   */
  credentialForm: ChannelCredentialForm | undefined;
  /**
   * Catalog key for the disconnected empty state's pitch, which interpolates
   * `assistant`. Undefined for Slack: its disconnected state is the setup
   * wizard.
   */
  disconnectedPitchKey:
    | "channelMeta.telegram.disconnectedPitch"
    | "channelMeta.discord.disconnectedPitch"
    | "channelMeta.phone.disconnectedPitch"
    | undefined;
}

/*
 * `satisfies` rather than an annotation so each entry keeps its literal type:
 * `ChannelSetupType` is derived from which entries declare a form, and an
 * annotation would erase exactly the facts that derivation reads.
 */
export const CHANNEL_META = {
  slack: {
    labelKey: "channelMeta.slack.label",
    disconnectMessageKey: "channelMeta.slack.disconnectMessage",
    hasTrustFloorControl: false,
    credentialForm: "slack-wizard",
    disconnectedPitchKey: undefined,
  },
  telegram: {
    labelKey: "channelMeta.telegram.label",
    disconnectMessageKey: "channelMeta.telegram.disconnectMessage",
    hasTrustFloorControl: true,
    credentialForm: "telegram-token",
    disconnectedPitchKey: "channelMeta.telegram.disconnectedPitch",
  },
  discord: {
    labelKey: "channelMeta.discord.label",
    disconnectMessageKey: "channelMeta.discord.disconnectMessage",
    hasTrustFloorControl: true,
    credentialForm: "discord-token",
    disconnectedPitchKey: "channelMeta.discord.disconnectedPitch",
  },
  email: {
    labelKey: "channelMeta.email.label",
    // Email's setup is address and domain management rather than a
    // credential form, rendered by the panel's own email branch, so every
    // generic affordance is declared off: no form, no disconnect route, no
    // pitch. The trust floor is the one generic control it shares.
    disconnectMessageKey: undefined,
    hasTrustFloorControl: true,
    credentialForm: undefined,
    disconnectedPitchKey: undefined,
  },
  phone: {
    labelKey: "channelMeta.phone.label",
    disconnectMessageKey: "channelMeta.phone.disconnectMessage",
    hasTrustFloorControl: true,
    credentialForm: "twilio-credentials",
    disconnectedPitchKey: "channelMeta.phone.disconnectedPitch",
  },
} satisfies Record<SetupChannelId, ChannelMeta>;
