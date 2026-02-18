/**
 * Registers computer-use tools with the daemon's tool registry.
 *
 * The 12 computer_use_* action tools and the computer_use_request_control
 * escalation tool are now provided by the bundled computer-use skill.
 * This module retains registerComputerUseActionTools() for backward
 * compatibility (used by tests), but it is no longer called during
 * normal startup.
 */

import { registerTool } from '../registry.js';
import { allComputerUseTools } from './definitions.js';

/**
 * Register the 12 `computer_use_*` action proxy tools.
 * After cutover these are provided by the bundled computer-use skill instead.
 */
export function registerComputerUseActionTools(): void {
  for (const tool of allComputerUseTools) {
    registerTool(tool);
  }
}
