/**
 * Channels installed plugins bring, for the Channels rail.
 *
 * Read from `/v1/channels/available`, which reports every channel in one list
 * and marks each with a `source`. Splitting on that here rather than asking
 * for a separate list keeps this client agreeing with the assistant about what
 * a channel is: the ones it ships and the ones a plugin brings differ in who
 * contributes them, not in kind.
 */

import { useQuery } from "@tanstack/react-query";

import { channelsAvailableGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  pluginChannelKey,
  type PluginChannelSummary,
} from "@/types/channel-types";

/** `plugin:<name>`, the source marking a channel an installed plugin brings. */
const PLUGIN_SOURCE_PREFIX = "plugin:";

/**
 * An assistant that predates `source` omits it, and one with no
 * channel-bringing plugins marks every row `default`. Both mean the same thing
 * here, so neither is an error state: the rail shows the built-ins alone.
 */
export function usePluginChannels(assistantId: string): PluginChannelSummary[] {
  const { data } = useQuery({
    ...channelsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    select: (response) =>
      response.channels
        .filter((channel) => channel.source?.startsWith(PLUGIN_SOURCE_PREFIX))
        .map((channel) => ({
          plugin: channel.id,
          key: pluginChannelKey(channel.id),
          label: channel.label,
          description: channel.subtitle,
          icon: channel.icon,
        })),
  });

  return data ?? [];
}
