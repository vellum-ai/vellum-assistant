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
 * Plugin servers are projected onto the same `McpServerConfig` shape by
 * `readPluginMcpServers`, so past this point nothing downstream needs to
 * know where a server came from, with one exception: credentials. A
 * plugin controls both its server key and its URL, so a plugin server
 * must never resolve `mcp:<serverId>:*` from the credential store. That
 * is why the plugin ids are returned alongside the merged config rather
 * than folded into it — callers pass them to
 * `McpServerManager.start` as `credentialIsolatedServerIds`.
 */

import { type McpConfig, McpConfigSchema } from "../config/schemas/mcp.js";
import { readPluginMcpServers } from "../plugins/mcp-servers.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-effective-config");

export interface EffectiveMcpConfig {
  /** Workspace servers merged with every plugin-declared server. */
  readonly config: McpConfig;
  /** Ids within `config.servers` that came from a plugin's `mcp.json`. */
  readonly pluginServerIds: ReadonlySet<string>;
}

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
): EffectiveMcpConfig {
  // An absent `mcp` key still has to yield the schema's own defaults
  // (`globalMaxTools`), since plugin servers alone are enough to need them.
  const base = workspaceConfig ?? McpConfigSchema.parse({});
  const servers: McpConfig["servers"] = { ...base.servers };
  const pluginServerIds = new Set<string>();

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
    pluginServerIds.add(server.id);
  }

  return {
    config: { ...base, servers },
    pluginServerIds,
  };
}
