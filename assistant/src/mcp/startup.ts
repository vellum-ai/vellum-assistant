/**
 * Connect the configured MCP servers and register their tools.
 *
 * MCP tools are not loaded from disk the way core and workspace tools are:
 * something has to connect to each server, list its tools, and register the
 * results into this process's registry. That registry is per-process, so every
 * process that hosts agent turns has to run it for itself: the daemon at boot
 * and the schedule worker at startup alike. A process that skips this step has
 * the tools missing entirely rather than filtered out, and every `mcp__*` call
 * made in it fails as "Unknown tool".
 *
 * Both callers previously spelled this out inline; it lives here so the two
 * cannot drift, and so a third process that starts hosting turns has one call
 * to make.
 */

import type { McpConfig } from "../config/schemas/mcp.js";
import { createMcpToolsFromServer } from "../tools/mcp/mcp-tool-factory.js";
import { registerMcpTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { buildEffectiveMcpConfig } from "./effective-config.js";
import { getMcpServerManager } from "./manager.js";

const log = getLogger("mcp-startup");

/**
 * Start every enabled server in the effective MCP config (workspace entries
 * plus plugin-declared ones) and register the tools they report.
 *
 * Call after {@link initializeTools}, so core and workspace tools already own
 * their names when MCP registrations resolve: `registerMcpTools` yields to an
 * existing owner rather than displacing it.
 *
 * Never throws: a server that cannot be reached is logged and skipped, and a
 * failure of the whole step leaves the process running without MCP tools. This
 * is a startup step in processes whose other work must not be held hostage to
 * a third-party server being up.
 *
 * @param workspaceMcpConfig The `mcp` block of the assistant config, if any.
 * @returns The number of tools registered across all servers.
 */
export async function startConfiguredMcpServers(
  workspaceMcpConfig?: McpConfig,
): Promise<number> {
  const mcpConfig = buildEffectiveMcpConfig(workspaceMcpConfig);
  if (Object.keys(mcpConfig.servers).length === 0) {
    return 0;
  }

  const manager = getMcpServerManager();
  let registered = 0;
  try {
    const serverToolInfos = await manager.start(mcpConfig);
    for (const { serverId, serverConfig, tools } of serverToolInfos) {
      const mcpTools = createMcpToolsFromServer(
        tools,
        serverId,
        serverConfig,
        manager,
      );
      registered += registerMcpTools(serverId, mcpTools).length;
    }
  } catch (err) {
    log.error(
      { err },
      "MCP server initialization failed — continuing without MCP tools",
    );
    return registered;
  }

  log.info({ toolCount: registered }, "MCP tools registered");
  return registered;
}
