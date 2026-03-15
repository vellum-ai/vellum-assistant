/**
 * Handle MCP reload signals from the CLI.
 *
 * When the CLI writes to `signals/mcp-reload`, the daemon's ConfigWatcher
 * detects the file change and invokes {@link handleMcpReloadSignal} to
 * restart MCP servers with the latest configuration.
 */

import { reloadMcpServers } from "../daemon/mcp-reload-service.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("signal:mcp-reload");

export function handleMcpReloadSignal(): void {
  reloadMcpServers().catch((err: unknown) => {
    log.error({ err }, "MCP reload triggered by signal file failed");
  });
}
