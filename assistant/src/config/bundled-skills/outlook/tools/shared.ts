/**
 * Shared utilities for Outlook skill tools.
 */

import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

// Re-export DNS rebinding protection helpers from the Gmail shared module.
// These are provider-agnostic and should be reused, not duplicated.
export { pinnedHttpsRequest } from "../../gmail/tools/shared.js";

// resolveRequestAddress lives in the shared network-safety module (not Gmail-specific).
export { resolveRequestAddress } from "../../../../tools/network/url-safety.js";
