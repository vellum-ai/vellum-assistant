/**
 * Registers computer-use tools with the daemon's tool registry.
 *
 * Split into action tools (12 `computer_use_*`) and the escalation tool
 * (`request_computer_control`) so the cutover (PR 09) can stop registering
 * action tools without affecting the escalation tool.
 */

import { registerTool } from '../registry.js';
import { allComputerUseTools } from './definitions.js';
import { requestComputerControlTool } from './request-computer-control.js';

/**
 * Register the 12 `computer_use_*` action proxy tools.
 * After cutover these will be provided by the bundled computer-use skill instead.
 */
export function registerComputerUseActionTools(): void {
  for (const tool of allComputerUseTools) {
    registerTool(tool);
  }
}

/**
 * Register the `request_computer_control` escalation proxy tool.
 * This remains a core tool even after cutover.
 */
export function registerRequestComputerControlTool(): void {
  registerTool(requestComputerControlTool);
}

/**
 * Register all computer-use tools (action + escalation).
 * Backward-compatible wrapper — call sites that need both can still use this.
 */
export function registerComputerUseTools(): void {
  registerComputerUseActionTools();
  registerRequestComputerControlTool();
}
