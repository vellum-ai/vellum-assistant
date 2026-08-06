/**
 * Parser for plugin-declared channels under `<pluginDir>/channels/`.
 *
 * A plugin that carries a way for someone to reach the assistant declares it
 * in `channels/channel.json`, alongside the `ingress.json` the gateway reads
 * from the same directory. The two are deliberately separate files: ingress is
 * a request for public reach that a guardian approves, and this is display
 * metadata that grants nothing. A plugin that receives webhooks but is not a
 * channel declares only the first, and a channel that needs no public route
 * declares only the second.
 *
 * The plugin's identity comes from the directory the file is read from, never
 * from its contents, so a manifest cannot claim to be another plugin's
 * channel. Errors are per-plugin: one unreadable declaration never hides a
 * sibling's.
 *
 * Pure filesystem and parsing. Nothing here decides whether a channel works,
 * only that a plugin says it has one.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { isPluginDisabled } from "../plugins/disabled-state.js";
import {
  isInsidePluginRoot,
  listInstalledPluginDirs,
} from "../plugins/installed-plugin-dirs.js";

/** Path of a channel declaration within its plugin directory. */
export const PLUGIN_CHANNEL_MANIFEST_RELPATH = "channels/channel.json";

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

const channelManifestSchema = z
  .object({
    /** Title shown on the channel row, e.g. "iMessage". */
    label: z.string().min(1),
    /** One line under the title, saying what reaching the assistant here means. */
    subtitle: z.string().min(1),
    /**
     * Lucide icon name without the `lucide-` prefix, matching `ChannelInfo`
     * so a plugin channel renders through the same icon path as a built-in.
     */
    icon: z
      .string()
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        "icon must be a lucide name in kebab-case",
      )
      .refine((v) => !v.startsWith("lucide-"), {
        message: "icon must omit the lucide- prefix; clients add it",
      }),
  })
  .strict();

export interface PluginChannelDeclaration {
  /** `plugin:<pluginName>`, the id clients key on. */
  id: string;
  /** Directory name of the declaring plugin. */
  plugin: string;
  label: string;
  subtitle: string;
  icon: string;
}

/** A declaration that was found but could not be used, and why. */
export interface PluginChannelProblem {
  plugin: string;
  reason: string;
}

export interface PluginChannelDiscovery {
  channels: PluginChannelDeclaration[];
  problems: PluginChannelProblem[];
}

/** Read and validate one plugin's declaration, if it has one. */
function readDeclaration(
  plugin: string,
  pluginDir: string,
): PluginChannelDeclaration | PluginChannelProblem | undefined {
  const manifestPath = join(pluginDir, PLUGIN_CHANNEL_MANIFEST_RELPATH);
  // Existence first: containment resolves the path, which cannot answer for
  // one that is not there, and most plugins are not channels.
  if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    return undefined;
  }
  if (!isInsidePluginRoot(manifestPath, pluginDir)) {
    // A link pointing out of the plugin would let one install supply
    // another's declaration.
    return { plugin, reason: "declaration resolves outside the plugin" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return { plugin, reason: "unreadable or malformed JSON" };
  }

  const parsed = channelManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { plugin, reason: z.prettifyError(parsed.error) };
  }

  return {
    id: `${PLUGIN_CHANNEL_ID_PREFIX}${plugin}`,
    plugin,
    ...parsed.data,
  };
}

/**
 * Every channel declared by an installed, enabled plugin.
 *
 * Disabled plugins are skipped, matching the source of truth the loader uses
 * for hooks, tools and routes: a disabled plugin holds no channel either, and
 * one that reappeared in this list would offer a setup flow that cannot run.
 *
 * Order follows the plugins directory, and is stable for a stable install set.
 */
export function discoverPluginChannels(): PluginChannelDiscovery {
  const channels: PluginChannelDeclaration[] = [];
  const problems: PluginChannelProblem[] = [];

  for (const { name, dir } of listInstalledPluginDirs()) {
    if (isPluginDisabled(name)) {
      continue;
    }
    const result = readDeclaration(name, dir);
    if (!result) {
      continue;
    }
    if ("reason" in result) {
      problems.push(result);
    } else {
      channels.push(result);
    }
  }

  return { channels, problems };
}
