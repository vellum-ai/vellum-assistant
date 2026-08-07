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
  status: ChannelStatus;
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
  /** The row's `source`, `plugin:<pluginName>`, unique across the rail. */
  id: string;
  /** Directory name of the declaring plugin, for linking to its page. */
  plugin: string;
  label: string;
  description?: string;
  /** Lucide icon name without the `lucide-` prefix. */
  icon?: string;
}

/** Key of whichever row the Channels rail has selected. */
export type ChannelRowKey = SetupChannelId | string;

export function isPluginChannelKey(key: string): boolean {
  return key.startsWith("plugin:");
}
