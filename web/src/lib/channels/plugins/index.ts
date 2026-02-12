import { ChannelId, ChannelPlugin } from "@/lib/channels/plugins/types";

const PLUGINS: Record<string, ChannelPlugin> = {};

export function listChannelPlugins(): ChannelPlugin[] {
  return Object.values(PLUGINS);
}

export function getChannelPlugin(channel: ChannelId): ChannelPlugin | null {
  return PLUGINS[String(channel)] ?? null;
}
