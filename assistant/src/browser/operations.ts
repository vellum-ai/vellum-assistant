/**
 * Shared browser operations contract.
 *
 * This module is the single execution entrypoint for all browser
 * operations. Both the existing tool wrappers and the CLI command
 * builder consume this contract. All metadata is defined inline —
 * this module has no dependency on skill registration files.
 *
 * Responsibilities:
 *   - Dispatch to existing browser-execution.ts implementations.
 *   - Command-oriented metadata for CLI subcommand generation.
 *   - `wait_for_download` mode-constraint enforcement.
 */

import {
  executeBrowserAttach,
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserDetach,
  executeBrowserExtract,
  executeBrowserFillCredential,
  executeBrowserHover,
  executeBrowserNavigate,
  executeBrowserPressKey,
  executeBrowserScreenshot,
  executeBrowserScroll,
  executeBrowserSelectOption,
  executeBrowserSnapshot,
  executeBrowserStatus,
  executeBrowserType,
  executeBrowserWaitFor,
} from "../tools/browser/browser-execution.js";
import { normalizeBrowserMode } from "../tools/browser/browser-mode.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { BrowserOperationContext as ToolContext } from "./types.js";
import type { BrowserOperation } from "./types.js";

export type BrowserOperationLifecycle = "action" | "terminal" | "status";

const OPERATION_LIFECYCLE: Record<BrowserOperation, BrowserOperationLifecycle> =
  {
    navigate: "action",
    snapshot: "action",
    screenshot: "action",
    close: "terminal",
    attach: "action",
    detach: "terminal",
    click: "action",
    type: "action",
    press_key: "action",
    scroll: "action",
    select_option: "action",
    hover: "action",
    wait_for: "action",
    extract: "action",
    wait_for_download: "action",
    fill_credential: "action",
    status: "status",
  };

export function browserOperationLifecycle(
  operation: BrowserOperation,
): BrowserOperationLifecycle {
  return OPERATION_LIFECYCLE[operation];
}

// ── Dispatch handlers ────────────────────────────────────────────────

/**
 * Handler signature for a browser operation dispatcher.
 */
type OperationHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionResult>;

async function executeWaitForDownload(
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const modeResult = normalizeBrowserMode(input.browser_mode);
  if ("error" in modeResult) {
    return { content: `Error: ${modeResult.error}`, isError: true };
  }
  return {
    content: `Error: browser_wait_for_download does not support browser_mode "${modeResult.mode}". Use the virtual desktop browser and inspect its Downloads folder.`,
    isError: true,
  };
}

/**
 * Registry mapping each operation to its dispatch handler.
 * Every entry in BROWSER_OPERATIONS must have a corresponding handler.
 */
const DISPATCH_HANDLERS: Record<BrowserOperation, OperationHandler> = {
  navigate: executeBrowserNavigate,
  snapshot: executeBrowserSnapshot,
  screenshot: executeBrowserScreenshot,
  close: executeBrowserClose,
  attach: executeBrowserAttach,
  detach: executeBrowserDetach,
  click: executeBrowserClick,
  type: executeBrowserType,
  press_key: executeBrowserPressKey,
  scroll: executeBrowserScroll,
  select_option: executeBrowserSelectOption,
  hover: executeBrowserHover,
  wait_for: executeBrowserWaitFor,
  extract: executeBrowserExtract,
  wait_for_download: executeWaitForDownload,
  fill_credential: executeBrowserFillCredential,
  status: executeBrowserStatus,
};

// ── Execute ──────────────────────────────────────────────────────────

/**
 * Execute a browser operation by its canonical identifier.
 *
 * This is the single execution entrypoint. Callers pass the operation
 * name (e.g. `"navigate"`), a flat input object, and a {@link ToolContext}.
 * The function looks up the handler in the dispatch registry and
 * delegates to the existing browser-execution.ts implementation.
 *
 * @param operation - Canonical operation identifier (e.g. `"navigate"`).
 * @param input     - Flat input object matching the operation's field schema.
 * @param context   - Tool execution context (conversation ID, signal, etc.).
 * @returns The tool execution result from the underlying handler.
 *   If the operation identifier is not recognized, returns an error
 *   result (`isError: true`) rather than throwing.
 */
export async function executeBrowserOperation(
  operation: BrowserOperation,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const handler = DISPATCH_HANDLERS[operation];
  if (!handler) {
    return {
      content: `Error: Unknown browser operation "${operation}".`,
      isError: true,
    };
  }
  return handler(input, context);
}

// ── Command-oriented metadata ────────────────────────────────────────

export { BROWSER_OPERATION_META } from "./operation-meta.js";
