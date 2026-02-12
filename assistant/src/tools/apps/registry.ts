/**
 * Registers all app tools with the daemon's tool registry.
 *
 * Called per-session by Session (not at daemon startup) so that app tools
 * including the proxy tool (app_open) are only available in contexts where
 * a surfaceProxyResolver is wired up to handle them.
 */

import { registerTool } from '../registry.js';
import { allAppTools } from './definitions.js';

export function registerAppTools(): void {
  for (const tool of allAppTools) {
    registerTool(tool);
  }
}
