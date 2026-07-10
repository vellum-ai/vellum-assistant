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
import { browserManager } from "../tools/browser/browser-manager.js";
import { normalizeBrowserMode } from "../tools/browser/browser-mode.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import type { BrowserOperation } from "./types.js";

// ── Dispatch handlers ────────────────────────────────────────────────

/**
 * Handler signature for a browser operation dispatcher.
 */
type OperationHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionResult>;

/**
 * Inline `wait_for_download` handler. Downloads are only supported
 * on auto/local browser modes; the handler validates the mode and
 * delegates to `browserManager.waitForDownload()`.
 */
async function executeWaitForDownload(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  // Validate browser_mode: only auto/local are supported for downloads.
  const modeResult = normalizeBrowserMode(input.browser_mode);
  if ("error" in modeResult) {
    return { content: `Error: ${modeResult.error}`, isError: true };
  }
  const { mode } = modeResult;
  if (mode !== "auto" && mode !== "local") {
    return {
      content:
        `Error: browser_wait_for_download does not support browser_mode "${mode}". ` +
        `File downloads require the local Playwright backend. ` +
        `Use browser_mode "auto" or "local" instead.`,
      isError: true,
    };
  }

  const timeout =
    typeof input.timeout === "number"
      ? Math.min(Math.max(input.timeout, 1000), 120_000)
      : 30_000;

  try {
    const download = await browserManager.waitForDownload(
      context.conversationId,
      timeout,
    );
    return {
      content: JSON.stringify({
        filename: download.filename,
        path: download.path,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
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

export { BROWSER_OPERATION_META } from "../util/browser-operation-meta.js";
