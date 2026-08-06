/**
 * Channels declared by installed plugins, for the Channels rail.
 *
 * Read from `/v1/channels/available`, the same endpoint the Contacts page
 * uses for the built-in list, so a plugin that declares a channel appears
 * without this client shipping anything per-plugin.
 */

import { useQuery } from "@tanstack/react-query";

import { channelsAvailableGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginChannelSummary } from "@/types/channel-types";

/**
 * An assistant that predates `pluginChannels` omits the field, and one with
 * no channel-declaring plugins sends it empty. Both mean the same thing here,
 * so neither is an error state: the rail simply shows the built-ins.
 */
export function usePluginChannels(assistantId: string): PluginChannelSummary[] {
  const { data } = useQuery({
    ...channelsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    select: (response) => response.pluginChannels ?? [],
  });

  return data ?? [];
}
