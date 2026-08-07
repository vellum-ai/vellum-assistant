/**
 * Channels that installed plugins bring.
 *
 * A plugin is a channel because it declares ingress: `channels/ingress.json`
 * is the list of routes the outside world may reach it on, and reaching the
 * assistant from outside is what being a channel means. There is no second
 * file saying so, and nothing a plugin can set to claim the status without
 * declaring the reach that constitutes it.
 *
 * What the gateway does with that file is a separate matter, and stays the
 * gateway's: validating the routes, digesting them, holding them behind a
 * guardian's approval. This reads its presence and nothing else, so a
 * declaration the gateway rejects still surfaces here. That is the honest
 * report — the plugin is a channel and its ingress is broken — and it keeps a
 * schema this module does not own from deciding what the settings page lists.
 *
 * Presentation comes from the plugin's own manifest, where a plugin's title,
 * description and icon already belong. All three are optional and none gate
 * anything: a plugin with ingress and a bare `package.json` still appears,
 * under a name derived from its directory.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { isPluginDisabled } from "../plugins/disabled-state.js";
import { parsePluginPresentation } from "../plugins/external-plugin-loader.js";
import { listInstalledPluginDirs } from "../plugins/installed-plugin-dirs.js";

/**
 * The declaration that makes a plugin a channel. Owned by the gateway, which
 * parses it; named here only to test for it.
 */
export const PLUGIN_INGRESS_MANIFEST_RELPATH = "channels/ingress.json";

/**
 * Prefix separating plugin channel ids from the assistant's own.
 *
 * `ChannelId` is a closed union covering the channels the assistant routes,
 * verifies and applies admission policy to. A plugin channel is none of those
 * things yet, so it is namespaced rather than admitted to that union: a client
 * can display `plugin:imessage` without any code path mistaking it for a
 * channel the daemon knows how to deliver on.
 */
export const PLUGIN_CHANNEL_ID_PREFIX = "plugin:";

export interface PluginChannel {
  /** `plugin:<pluginName>`, the id clients key on. */
  id: string;
  /** Directory name of the declaring plugin. */
  plugin: string;
  /** Title for the channel row. */
  label: string;
  /** One line under the title. Absent when the manifest carries none. */
  description?: string;
  /** Lucide icon name without the `lucide-` prefix, when the manifest names one. */
  icon?: string;
}

/**
 * Title for a plugin with no `displayName`.
 *
 * Derived rather than defaulted to the raw directory name so `meeting-bot`
 * reads as "Meeting Bot" in a list beside "Slack" and "Telegram". A plugin
 * whose casing matters (iMessage) sets `displayName` and this never runs.
 */
function titleFromDirectory(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** True when the plugin declares ingress routes. */
function declaresIngress(pluginDir: string): boolean {
  return (
    statSync(join(pluginDir, PLUGIN_INGRESS_MANIFEST_RELPATH), {
      throwIfNoEntry: false,
    })?.isFile() === true
  );
}

/**
 * Every channel brought by an installed, enabled plugin.
 *
 * Disabled plugins are skipped, matching the source of truth the loader uses
 * for hooks, tools and routes: a disabled plugin holds no ingress either, and
 * one that reappeared here would offer a setup flow that cannot run.
 *
 * Order follows the plugins directory, and is stable for a stable install set.
 */
export async function discoverPluginChannels(): Promise<PluginChannel[]> {
  const channels: PluginChannel[] = [];

  for (const { name, dir } of listInstalledPluginDirs()) {
    if (isPluginDisabled(name) || !declaresIngress(dir)) {
      continue;
    }
    const presentation = await parsePluginPresentation(dir);
    channels.push({
      id: `${PLUGIN_CHANNEL_ID_PREFIX}${name}`,
      plugin: name,
      label: presentation?.displayName ?? titleFromDirectory(name),
      description: presentation?.description,
      icon: presentation?.icon,
    });
  }

  return channels;
}
