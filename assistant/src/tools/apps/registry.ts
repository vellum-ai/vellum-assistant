/**
 * Registers app proxy tools with the daemon's tool registry.
 *
 * Called once at daemon startup via initializeTools(). Only proxy tools
 * (e.g. app_open) are registered here - non-proxy data tools are now
 * provided by the app-builder skill via its TOOLS.json manifest.
 */

import { registerTool } from "../registry.js";
import { coreAppProxyTools } from "./definitions.js";

export function registerAppTools(): void {
  for (const tool of coreAppProxyTools) {
    registerTool(tool);
  }
}
