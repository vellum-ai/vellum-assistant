/**
 * Registers all computer-use proxy tools with the daemon's tool registry.
 *
 * Call `registerComputerUseTools()` during daemon startup to make the 12 `cu_*`
 * tools available for inference.
 */

import { registerTool } from '../registry.js';
import { allComputerUseTools } from './definitions.js';
import { requestComputerControlTool } from './request-computer-control.js';

export function registerComputerUseTools(): void {
  for (const tool of allComputerUseTools) {
    registerTool(tool);
  }
  // Register the escalation tool separately — it is only added to text_qa
  // sessions (not CU sessions) to avoid recursive escalation.
  registerTool(requestComputerControlTool);
}
