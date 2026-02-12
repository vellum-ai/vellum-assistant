/**
 * Registers all UI surface proxy tools with the daemon's tool registry.
 *
 * Called once at daemon startup via initializeTools().
 */

import { registerTool } from '../registry.js';
import { allUiSurfaceTools } from './definitions.js';

export function registerUiSurfaceTools(): void {
  for (const tool of allUiSurfaceTools) {
    registerTool(tool);
  }
}
