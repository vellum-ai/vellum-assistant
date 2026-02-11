/**
 * Registers all UI surface proxy tools with the daemon's tool registry.
 *
 * Call `registerUiSurfaceTools()` during daemon startup to make the `ui_*`
 * tools available for inference.
 */

import { registerTool } from '../registry.js';
import { allUiSurfaceTools } from './definitions.js';

export function registerUiSurfaceTools(): void {
  for (const tool of allUiSurfaceTools) {
    registerTool(tool);
  }
}
