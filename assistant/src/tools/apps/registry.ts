/**
 * Registers all app tools with the daemon's tool registry.
 *
 * Called once at daemon startup via initializeTools().
 */

import { registerTool } from '../registry.js';
import { allAppTools } from './definitions.js';

export function registerAppTools(): void {
  for (const tool of allAppTools) {
    registerTool(tool);
  }
}
