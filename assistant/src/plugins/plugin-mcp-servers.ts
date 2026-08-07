/**
 * Plugin-contributed MCP servers.
 *
 * A plugin declares MCP servers in a root `mcp.json`, per the Agent
 * Plugins 1.0.0 specification:
 *
 *     {
 *       "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
 *       "mcpServers": {
 *         "unabyss": { "type": "streamable-http", "url": "https://mcp.unabyss.com" }
 *       }
 *     }
 *
 * This module reads those files and projects each entry onto the
 * assistant's own `McpServerConfig` shape, so a plugin-declared server can
 * flow through the same surfaces as one configured in `config.json`.
 *
 * Failure isolation follows the spec: an invalid top-level `mcp.json`
 * disables MCP for that plugin only, and an invalid individual server
 * disables only that entry. Neither ever throws — a malformed file in one
 * plugin must not remove another plugin's servers from a listing.
 *
 * Authentication is deliberately absent. Agent Plugins 1.0.0 defines no
 * portable OAuth or credential-reference fields; authentication is
 * client-managed, and any `headers` in the file are literal package data.
 * A plugin therefore cannot ship a credential, and the assistant's own
 * credential store stays the only place secrets live.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type AllPluginInfo,
  listAllPlugins,
  type ListInstalledPluginsOptions,
} from "../cli/lib/list-installed-plugins.js";
import type { McpServerConfig, McpTransport } from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("plugin-mcp-servers");

/** Filename a plugin declares its MCP servers in, at the plugin root. */
export const PLUGIN_MCP_MANIFEST = "mcp.json";

/**
 * Risk level assigned to a plugin-declared server. `mcp.json` has no risk
 * field — the spec defines none — so the assistant's own default applies.
 * `high` matches `McpServerConfigSchema` and is the safe direction: a
 * plugin cannot lower the approval bar for the tools it introduces.
 */
const PLUGIN_SERVER_DEFAULT_RISK = "high" as const;

// ---------------------------------------------------------------------------
// Wire schema (Agent Plugins 1.0.0)
// ---------------------------------------------------------------------------

const PluginStdioServerSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const PluginHttpServerSchema = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const PluginMcpServerSchema = z.discriminatedUnion("type", [
  PluginStdioServerSchema,
  PluginHttpServerSchema,
]);

const PluginMcpManifestSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** One MCP server declared by one plugin. */
export interface PluginMcpServer {
  /** Server id in the assistant's namespace — see {@link buildServerId}. */
  readonly id: string;
  /** Directory name of the plugin that declared it. */
  readonly pluginName: string;
  /** Key this server appears under in the plugin's `mcp.json`. */
  readonly serverKey: string;
  /** Projected onto the assistant's own server-config shape. */
  readonly config: McpServerConfig;
}

/** A plugin's `mcp.json` that could not be used, in whole or in part. */
export interface PluginMcpIssue {
  readonly pluginName: string;
  /** Absent when the whole manifest is unusable rather than one entry. */
  readonly serverKey?: string;
  readonly message: string;
}

export interface PluginMcpServersResult {
  readonly servers: readonly PluginMcpServer[];
  readonly issues: readonly PluginMcpIssue[];
}

/**
 * Server id for a plugin-declared server.
 *
 * Plugin servers share one namespace with `config.json` servers and with
 * each other, so the plugin name is the qualifier. The redundant case is
 * collapsed: a plugin named `unabyss` whose only server key is also
 * `unabyss` yields `unabyss`, not `unabyss__unabyss` — which matters
 * because the id is embedded in every tool name the server contributes
 * (`mcp__<id>__<tool>`).
 */
export function buildServerId(pluginName: string, serverKey: string): string {
  return pluginName === serverKey ? pluginName : `${pluginName}__${serverKey}`;
}

/**
 * Expand the two path variables the Agent Plugins spec defines for stdio
 * servers. They interpolate textually in `args`, `env` values, and `cwd`
 * only — never in `command`, a URL, or a header, so a manifest cannot use
 * them to build the executable path itself.
 */
export function interpolatePluginPaths(
  value: string,
  pluginRoot: string,
  pluginData: string,
): string {
  return value
    .replaceAll("${PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${PLUGIN_DATA}", pluginData);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read every installed plugin's `mcp.json` and return the servers they
 * declare, plus anything that could not be read.
 *
 * A disabled plugin is skipped entirely: `.disabled` means the plugin
 * contributes no hooks and no tools, and an MCP server it declares is no
 * different.
 */
export function readPluginMcpServers(
  opts: ListInstalledPluginsOptions = {},
): PluginMcpServersResult {
  const servers: PluginMcpServer[] = [];
  const issues: PluginMcpIssue[] = [];
  const seen = new Map<string, string>();

  let plugins: readonly AllPluginInfo[];
  try {
    plugins = listAllPlugins(opts);
  } catch (err) {
    // The plugins directory being unreadable is not a reason to fail a
    // listing that also has config-defined servers in it.
    log.warn({ err }, "Could not enumerate plugins for MCP declarations");
    return { servers: [], issues: [] };
  }

  for (const plugin of plugins) {
    if (plugin.disabled) {
      continue;
    }
    const manifestPath = join(plugin.target, PLUGIN_MCP_MANIFEST);
    if (!existsSync(manifestPath)) {
      continue;
    }

    const parsed = parseManifest(manifestPath);
    if ("error" in parsed) {
      issues.push({ pluginName: plugin.name, message: parsed.error });
      continue;
    }

    for (const [serverKey, raw] of Object.entries(parsed.mcpServers)) {
      if (serverKey.trim().length === 0) {
        issues.push({
          pluginName: plugin.name,
          message: "server key must be a non-empty string; skipping",
        });
        continue;
      }

      const entry = PluginMcpServerSchema.safeParse(raw);
      if (!entry.success) {
        issues.push({
          pluginName: plugin.name,
          serverKey,
          message: `invalid server entry: ${entry.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        });
        continue;
      }

      const id = buildServerId(plugin.name, serverKey);
      const previous = seen.get(id);
      if (previous) {
        // Two plugins claiming one id would silently shadow each other, and
        // the loser's tools would just be missing. Report both instead.
        issues.push({
          pluginName: plugin.name,
          serverKey,
          message: `server id "${id}" is already declared by plugin "${previous}"; skipping`,
        });
        continue;
      }
      seen.set(id, plugin.name);

      // The spec allows `cwd` on a stdio server; the assistant's transport
      // has no such field. Dropping it silently would leave a server that
      // resolves its relative paths against the wrong directory and fails
      // for no visible reason, so say so.
      if (entry.data.type === "stdio" && entry.data.cwd) {
        issues.push({
          pluginName: plugin.name,
          serverKey,
          message: `"cwd" is not supported by this host and was ignored; the server runs in the daemon's working directory`,
        });
      }

      servers.push({
        id,
        pluginName: plugin.name,
        serverKey,
        config: {
          transport: projectTransport(entry.data, plugin.target),
          enabled: true,
          defaultRiskLevel: PLUGIN_SERVER_DEFAULT_RISK,
          maxTools: 20,
        },
      });
    }
  }

  return { servers, issues };
}

function parseManifest(
  path: string,
): { mcpServers: Record<string, unknown> } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      error: `${PLUGIN_MCP_MANIFEST} unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      error: `${PLUGIN_MCP_MANIFEST} invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const manifest = PluginMcpManifestSchema.safeParse(json);
  if (!manifest.success) {
    return {
      error: `${PLUGIN_MCP_MANIFEST} is missing a valid "mcpServers" object`,
    };
  }
  return { mcpServers: manifest.data.mcpServers };
}

/**
 * Project one spec-shaped entry onto the assistant's transport union. The
 * two vocabularies already agree on type names and required fields, so this
 * is a field copy plus path interpolation for the stdio case.
 */
function projectTransport(
  entry: z.infer<typeof PluginMcpServerSchema>,
  pluginRoot: string,
): McpTransport {
  if (entry.type === "stdio") {
    const pluginData = join(pluginRoot, "data");
    const expand = (v: string): string =>
      interpolatePluginPaths(v, pluginRoot, pluginData);
    return {
      type: "stdio",
      command: entry.command,
      args: (entry.args ?? []).map(expand),
      ...(entry.env && {
        env: Object.fromEntries(
          Object.entries(entry.env).map(([k, v]) => [k, expand(v)]),
        ),
      }),
    };
  }
  return {
    type: entry.type,
    url: entry.url,
    ...(entry.headers && { headers: entry.headers }),
  };
}
