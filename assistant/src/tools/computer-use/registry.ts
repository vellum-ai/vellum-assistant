/**
 * Registers all computer-use proxy tools with the daemon's tool registry.
 *
 * Call `registerComputerUseTools()` during daemon startup to make the 12 `cu_*`
 * tools available for inference.
 */

import { registerTool } from '../registry.js';
import { allComputerUseTools } from './definitions.js';

export function registerComputerUseTools(): void {
  for (const tool of allComputerUseTools) {
    registerTool(tool);
  }
}
