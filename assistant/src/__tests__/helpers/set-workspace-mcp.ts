/**
 * Seed `$VELLUM_WORKSPACE_DIR/mcp.json` for tests that go through the
 * real workspace MCP loader.
 */

import type { McpConfig } from "../../config/schemas/mcp.js";
import { saveWorkspaceMcpConfig } from "../../mcp/workspace-mcp-config.js";

export function setWorkspaceMcp(servers: McpConfig["servers"]): void {
  saveWorkspaceMcpConfig({ servers });
}
