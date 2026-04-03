/**
 * Registers feature-flag-gated system tools with the daemon's tool registry.
 *
 * Called once at daemon startup via initializeTools(). Tools that are always
 * registered (e.g. request_system_permission) are handled via the tool
 * manifest's explicit tools list; this module handles conditional registration.
 */

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { registerTool } from "../registry.js";
import { setPermissionModeTool } from "./set-permission-mode.js";

export function registerSystemTools(): void {
  try {
    const config = getConfig();
    if (isAssistantFeatureFlagEnabled("permission-controls-v2", config)) {
      registerTool(setPermissionModeTool);
    }
  } catch {
    // Config not yet loaded (e.g. during test setup) — permission mode tool stays off.
  }
}
