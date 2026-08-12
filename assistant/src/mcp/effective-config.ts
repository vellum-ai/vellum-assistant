/**
 * The MCP configuration the daemon actually runs.
 *
 * Two sources contribute servers: the workspace `config.json`, which the
 * user owns, and each installed plugin's `mcp.json`, which its author
 * owns. Both must reach the MCP manager, so every consumer that starts
 * servers builds its config through here rather than reading
 * `config.mcp` directly — a path that only reads the workspace half
 * leaves a plugin's tools silently missing.
 *
 * Every server comes out attributed with its {@link McpServerSource}, so
 * the one place origin still matters downstream — a plugin server must
 * never resolve `mcp:<serverId>:*` from the credential store — reads it
 * off the server rather than from a caller-supplied list.
 */

import {
  type McpConfig,
  McpConfigSchema,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";
import { readPluginMcpServers } from "../plugins/mcp-servers.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-effective-config");

/**
 * Fingerprint of the plugin-declared servers in the config last built here.
 * Null until the first build, which happens during daemon startup.
 */
let lastBuiltPluginFingerprint: string | null = null;

/**
 * Merge the workspace MCP config with the servers plugins declare.
 *
 * A workspace entry outranks a plugin's declaration of the same id: the
 * user's own configuration is the more specific statement, and it is the
 * one they can edit. `internal_mcp_list` applies the same precedence, so
 * what the listing shows is what the daemon runs.
 */
export function buildEffectiveMcpConfig(
  workspaceConfig?: McpConfig,
): ResolvedMcpConfig {
  // An absent `mcp` key still has to yield the schema's own defaults
  // (`globalMaxTools`), since plugin servers alone are enough to need them.
  const base = workspaceConfig ?? McpConfigSchema.parse({});
  const servers: Record<string, ResolvedMcpServerConfig> = {};
  for (const [id, config] of Object.entries(base.servers)) {
    servers[id] = { ...config, source: "workspace" };
  }

  const { servers: pluginServers, issues } = readPluginMcpServers();
  for (const issue of issues) {
    log.warn(
      {
        plugin: issue.pluginName,
        ...(issue.serverKey && { serverKey: issue.serverKey }),
      },
      `Plugin MCP declaration problem: ${issue.message}`,
    );
  }

  for (const server of pluginServers) {
    if (Object.hasOwn(servers, server.id)) {
      log.warn(
        { plugin: server.pluginName, serverId: server.id },
        "Plugin MCP server shadowed by a workspace server of the same id; skipping",
      );
      continue;
    }
    servers[server.id] = server.config;
  }

  lastBuiltPluginFingerprint = fingerprintPluginServers();

  return { ...base, servers };
}

/**
 * Whether the plugin-declared servers on disk differ from the ones in the
 * config last built by {@link buildEffectiveMcpConfig}.
 *
 * The plugin source reconcile asks this after an install / uninstall /
 * upgrade / enable / disable, so an MCP reload happens exactly when a
 * plugin actually changed the server set — not on every unrelated plugin
 * edit, which would tear down healthy workspace connections for nothing.
 *
 * True before the first build, since nothing has been applied yet.
 */
export function pluginMcpServersChangedSinceLastBuild(): boolean {
  return fingerprintPluginServers() !== lastBuiltPluginFingerprint;
}

/**
 * Stable digest of every plugin-declared server: its id and the config it
 * resolves to. Covers a server appearing, disappearing, or changing its
 * transport — a disabled or uninstalled plugin contributes nothing, so it
 * drops out of the digest the same way a deleted `mcp.json` entry does.
 */
function fingerprintPluginServers(): string {
  const { servers } = readPluginMcpServers();
  return JSON.stringify(
    [...servers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => [s.id, s.config]),
  );
}

/** Test seam: forget the last built config, as on a fresh daemon. */
export function resetEffectiveMcpConfigForTests(): void {
  lastBuiltPluginFingerprint = null;
}
