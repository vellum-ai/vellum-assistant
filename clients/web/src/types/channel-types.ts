import type { ChannelsReadinessGetResponse } from "@/generated/daemon/types.gen";

export type ChannelReadinessSnapshot =
  ChannelsReadinessGetResponse["snapshots"][number];

/**
 * Channels that have user-facing setup flows in the UI. Constrained against
 * the generated readiness snapshot type so drift is caught at compile time.
 */
export const SETUP_CHANNEL_IDS = [
  "slack",
  "telegram",
  "phone",
] as const satisfies readonly ChannelReadinessSnapshot["channel"][];
export type SetupChannelId = (typeof SETUP_CHANNEL_IDS)[number];

export function isSetupChannelId(value: string): value is SetupChannelId {
  return (SETUP_CHANNEL_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Channel setup state (UI-only; shared by the Channels tab and the Contacts
// assistant detail)
// ---------------------------------------------------------------------------

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface AssistantChannelState {
  key: SetupChannelId;
  /** Whether the channel is working right now. Lists render this directly. */
  status: ChannelStatus;
  /**
   * Whether setup is finished, regardless of whether it is working.
   *
   * Separate from {@link AssistantChannelState.status} because the two answer
   * different questions and a channel can be configured while down. Required,
   * so a caller that means "is this set up" cannot reach for the working state
   * by omission: which one a decision wants has to be stated.
   */
  configured: boolean;
  /** Absent when the channel measures nothing operational. */
  health?: ChannelReadinessSnapshot["health"];
  address?: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Plugin-declared channels
// ---------------------------------------------------------------------------

/**
 * A channel an installed plugin brings by declaring ingress: a row of
 * `/v1/channels/available` whose `source` is `plugin:<name>`.
 *
 * Kept apart from {@link AssistantChannelState} rather than widened into it:
 * the built-in adapters carry a readiness snapshot, a credential form, a
 * disconnect path and a trust floor, and a plugin channel has none of those
 * here. Its id is namespaced (`plugin:<name>`), so the two sets cannot
 * collide in a selection key.
 */
export interface PluginChannelSummary {
  /** Directory name of the declaring plugin. */
  plugin: string;
  /**
   * Rail key and URL segment, {@link PLUGIN_CHANNEL_KEY_PREFIX} then the
   * plugin name. Namespaced rather than bare so a plugin can never collide
   * with a built-in adapter's key, whatever it is called: the separation is a
   * property of the key here, not a promise kept somewhere else.
   */
  key: string;
  label: string;
  description?: string;
  /** Lucide icon name without the `lucide-` prefix. */
  icon?: string;
}

/** Namespace for a plugin channel's rail key and URL segment. */
export const PLUGIN_CHANNEL_KEY_PREFIX = "plugins-";

/** Rail key and URL segment for a plugin channel. */
export function pluginChannelKey(plugin: string): string {
  return `${PLUGIN_CHANNEL_KEY_PREFIX}${plugin}`;
}

/** Key of whichever row the Channels rail has selected. */
export type ChannelRowKey = SetupChannelId | string;

export function isPluginChannelKey(key: string): boolean {
  return key.startsWith("plugin:");
}
