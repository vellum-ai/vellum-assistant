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
 * report, the plugin is a channel and its ingress is broken, and it keeps a
 * schema this module does not own from deciding what a settings page lists.
 *
 * Presentation comes from the plugin's own manifest, where a plugin's title,
 * description and icon already belong. All three are optional and none gate
 * anything: a plugin with ingress and a bare `package.json` still appears,
 * titled from its directory.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { isPluginDisabled } from "../plugins/disabled-state.js";
import { parsePluginPresentation } from "../plugins/external-plugin-loader.js";
import { listInstalledPluginDirs } from "../plugins/installed-plugin-dirs.js";
import { type AvailableChannel, isChannelId } from "./types.js";

/**
 * The declaration that makes a plugin a channel. Owned by the gateway, which
 * parses it; named here only to test for it.
 */
export const PLUGIN_INGRESS_MANIFEST_RELPATH = "channels/ingress.json";

/** Icon for a plugin naming none. The generic "a message arrives here" glyph. */
const FALLBACK_ICON = "message-square";

/**
 * Title for a plugin with no `displayName`.
 *
 * Derived rather than defaulted to the raw directory name so `meeting-bot`
 * reads as "Meeting Bot" beside "Slack" and "Telegram". A plugin whose casing
 * matters sets `displayName` and this never runs.
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
 * A plugin whose directory name is one of the assistant's own channels is
 * skipped: two rows sharing an id would be ambiguous to any client keying on
 * one, and the resolution that lets a plugin win would let it impersonate a
 * built-in channel. The assistant's keep the name.
 *
 * Disabled plugins are skipped too, matching the source of truth the loader
 * uses for hooks, tools and routes: a disabled plugin holds no ingress either,
 * and one that reappeared here would offer a setup flow that cannot run.
 *
 * Order follows the plugins directory, and is stable for a stable install set.
 */
export async function discoverPluginChannels(): Promise<AvailableChannel[]> {
  const channels: AvailableChannel[] = [];

  for (const { name, dir } of listInstalledPluginDirs()) {
    if (isPluginDisabled(name) || isChannelId(name) || !declaresIngress(dir)) {
      continue;
    }
    const presentation = await parsePluginPresentation(dir);
    const label = presentation?.displayName ?? titleFromDirectory(name);
    channels.push({
      id: name,
      source: `plugin:${name}`,
      label,
      subtitle: presentation?.description ?? `Provided by the ${label} plugin`,
      icon: presentation?.icon ?? FALLBACK_ICON,
      // No client-side verification flow exists for a plugin channel, so
      // clients render it display-only and never pre-warm a status for it.
      supportsVerification: false,
      // Openers for a setup conversation, which is what this field is for.
      // Deliberately not the verification copy the built-ins carry: there is
      // no identity to verify here, and inventing that wording would send
      // someone down a flow that does not exist.
      setupMessages: {
        guardian: `I want to set up ${label}. Can you help me?`,
        contact: `I'd like to reach you on ${label}. Can you help me get set up?`,
      },
    });
  }

  return channels;
}
