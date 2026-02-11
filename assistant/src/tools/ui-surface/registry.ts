/**
 * Registers all UI surface proxy tools with the daemon's tool registry.
 *
 * Called per-session by Session and ComputerUseSession (not at daemon startup)
 * so that ui_* tools are only available in contexts where a surfaceProxyResolver
 * is wired up to handle them.  The proxy resolver intercepts ui_show/ui_update/
 * ui_dismiss before they can fall through to CU tool dispatch, preventing stalls.
 */

import { registerTool } from '../registry.js';
import { allUiSurfaceTools } from './definitions.js';

export function registerUiSurfaceTools(): void {
  for (const tool of allUiSurfaceTools) {
    registerTool(tool);
  }
}
