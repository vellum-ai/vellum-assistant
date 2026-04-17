/**
 * Shared browser operations contract.
 *
 * This module is the single execution entrypoint for all browser
 * operations. Both the tool wrappers (bundled-skills/browser/tools/)
 * and the CLI command builder consume this contract. It does NOT
 * read from skill tool JSON definitions — all metadata is defined inline.
 *
 * Responsibilities:
 *   - Canonical operation <-> tool name mapping (bijective).
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
import {
  BROWSER_OPERATIONS,
  type BrowserOperation,
  type BrowserOperationMeta,
} from "./types.js";

// ── Tool name constants ──────────────────────────────────────────────

/**
 * All canonical browser operation identifiers (re-exported from types).
 */
export const BROWSER_OPERATION_NAMES: readonly BrowserOperation[] =
  BROWSER_OPERATIONS;

/**
 * All `browser_*` tool names derived from operation identifiers.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_OPERATIONS.map(
  (op) => `browser_${op}`,
);

// ── Bidirectional name mapping ───────────────────────────────────────

/**
 * Convert a `browser_*` tool name to its canonical operation ID.
 * Returns `undefined` if the tool name does not match a known operation.
 */
export function browserToolNameToOperation(
  toolName: string,
): BrowserOperation | undefined {
  if (!toolName.startsWith("browser_")) return undefined;
  const candidate = toolName.slice("browser_".length);
  if ((BROWSER_OPERATIONS as readonly string[]).includes(candidate)) {
    return candidate as BrowserOperation;
  }
  return undefined;
}

/**
 * Convert a canonical operation ID to its `browser_*` tool name.
 * Returns `undefined` if the operation is not a known identifier.
 */
export function browserOperationToToolName(
  operation: string,
): string | undefined {
  if ((BROWSER_OPERATIONS as readonly string[]).includes(operation)) {
    return `browser_${operation}`;
  }
  return undefined;
}

// ── Dispatch handlers ────────────────────────────────────────────────

/**
 * Handler signature for a browser operation dispatcher.
 */
type OperationHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionResult>;

/**
 * Inline `wait_for_download` handler. This logic currently lives in the
 * tool wrapper (`browser-wait-for-download.ts`); it is replicated here
 * so the shared contract can dispatch it without depending on the
 * wrapper. The wrapper can be repointed to this contract in a later PR.
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
        `Error: wait_for_download does not support browser_mode "${mode}". ` +
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
 * @throws If the operation identifier is not recognized.
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

/**
 * Metadata for every browser operation, describing fields, types, and
 * constraints. Used by the CLI command builder to generate subcommands.
 *
 * The `browser_mode` and `activity` fields are omitted from per-operation
 * metadata because they are common to all operations and handled by the
 * CLI framework as global options.
 */
export const BROWSER_OPERATION_META: readonly BrowserOperationMeta[] = [
  {
    operation: "navigate",
    description: "Navigate the browser to a URL and return the page title.",
    fields: [
      {
        name: "url",
        type: "string",
        description: "The URL to navigate to.",
        required: true,
      },
      {
        name: "allow_private_network",
        type: "boolean",
        description: "Allow navigation to localhost/private-network hosts.",
        required: false,
      },
    ],
  },
  {
    operation: "snapshot",
    description:
      "List interactive elements on the current page with unique IDs.",
    fields: [],
  },
  {
    operation: "screenshot",
    description: "Take a visual screenshot of the current page.",
    fields: [
      {
        name: "full_page",
        type: "boolean",
        description:
          "Capture the full scrollable page instead of just the viewport.",
        required: false,
      },
    ],
  },
  {
    operation: "close",
    description: "Close the browser page for the current conversation.",
    fields: [
      {
        name: "close_all_pages",
        type: "boolean",
        description: "Close all browser pages and the browser context.",
        required: false,
      },
    ],
  },
  {
    operation: "attach",
    description: "Attach the Chrome debugger to the active browser tab.",
    fields: [],
  },
  {
    operation: "detach",
    description: "Detach the Chrome debugger from the active browser tab.",
    fields: [],
  },
  {
    operation: "click",
    description: "Click an element on the page.",
    fields: [
      {
        name: "element_id",
        type: "string",
        description: "Element ID from a previous browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector to target.",
        required: false,
      },
    ],
  },
  {
    operation: "type",
    description: "Type text into an input element.",
    fields: [
      {
        name: "text",
        type: "string",
        description: "The text to type into the element.",
        required: true,
      },
      {
        name: "element_id",
        type: "string",
        description: "Element ID from a previous browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector to target.",
        required: false,
      },
      {
        name: "clear_first",
        type: "boolean",
        description: "Clear existing content before typing. Default: true.",
        required: false,
      },
      {
        name: "press_enter",
        type: "boolean",
        description: "Press Enter after typing the text.",
        required: false,
      },
    ],
  },
  {
    operation: "press_key",
    description: "Press a keyboard key, optionally targeting an element.",
    fields: [
      {
        name: "key",
        type: "string",
        description:
          'The key to press (e.g. "Enter", "Escape", "Tab", "ArrowDown").',
        required: true,
      },
      {
        name: "element_id",
        type: "string",
        description: "Optional element ID from browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "Optional CSS selector to target.",
        required: false,
      },
    ],
  },
  {
    operation: "scroll",
    description: "Scroll the page or a specific element.",
    fields: [
      {
        name: "direction",
        type: "string",
        description: "The direction to scroll.",
        required: true,
        enum: ["up", "down", "left", "right"],
      },
      {
        name: "amount",
        type: "number",
        description: "The number of pixels to scroll. Default: 500.",
        required: false,
      },
      {
        name: "element_id",
        type: "string",
        description: "Optional element ID to scroll within.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "Optional CSS selector of element to scroll within.",
        required: false,
      },
    ],
  },
  {
    operation: "select_option",
    description: "Select an option from a native <select> element.",
    fields: [
      {
        name: "element_id",
        type: "string",
        description: "Element ID of the <select> from browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector for the <select> element.",
        required: false,
      },
      {
        name: "value",
        type: "string",
        description: "The value attribute of the <option> to select.",
        required: false,
      },
      {
        name: "label",
        type: "string",
        description: "The visible text of the <option> to select.",
        required: false,
      },
      {
        name: "index",
        type: "number",
        description: "The zero-based index of the <option> to select.",
        required: false,
      },
    ],
  },
  {
    operation: "hover",
    description: "Hover over an element on the page.",
    fields: [
      {
        name: "element_id",
        type: "string",
        description: "Element ID from a previous browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector to target.",
        required: false,
      },
    ],
  },
  {
    operation: "wait_for",
    description:
      "Wait for a condition: a CSS selector, text, or fixed duration.",
    fields: [
      {
        name: "selector",
        type: "string",
        description: "Wait for an element matching this CSS selector.",
        required: false,
      },
      {
        name: "text",
        type: "string",
        description: "Wait for this text to appear on the page.",
        required: false,
      },
      {
        name: "duration",
        type: "number",
        description: "Wait for this many milliseconds.",
        required: false,
      },
      {
        name: "timeout",
        type: "number",
        description:
          "Maximum wait time in milliseconds. Default and max: 30000.",
        required: false,
      },
    ],
  },
  {
    operation: "extract",
    description: "Extract the text content of the current page.",
    fields: [
      {
        name: "include_links",
        type: "boolean",
        description: "Include a list of links found on the page.",
        required: false,
      },
    ],
  },
  {
    operation: "wait_for_download",
    description: "Wait for a file download to complete on the current page.",
    allowedModes: ["auto", "local"],
    fields: [
      {
        name: "timeout",
        type: "number",
        description:
          "Maximum wait time in milliseconds. Default: 30000, max: 120000.",
        required: false,
      },
    ],
  },
  {
    operation: "fill_credential",
    description:
      "Fill a stored credential into a form field without exposing the value.",
    fields: [
      {
        name: "service",
        type: "string",
        description: "Credential vault service name.",
        required: true,
      },
      {
        name: "field",
        type: "string",
        description: "Credential vault field name.",
        required: true,
      },
      {
        name: "element_id",
        type: "string",
        description: "Element ID from browser snapshot.",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector for target element.",
        required: false,
      },
      {
        name: "press_enter",
        type: "boolean",
        description: "Press Enter after filling.",
        required: false,
      },
    ],
  },
  {
    operation: "status",
    description: "Check browser backend readiness and remediation guidance.",
    fields: [
      {
        name: "check_local_launch",
        type: "boolean",
        description:
          "Run an active local Playwright launch probe. Default: false.",
        required: false,
      },
    ],
  },
];

// ── Lookup helper ────────────────────────────────────────────────────

/** Index for O(1) metadata lookups by operation. */
const META_BY_OPERATION = new Map<BrowserOperation, BrowserOperationMeta>(
  BROWSER_OPERATION_META.map((m) => [m.operation, m]),
);

/**
 * Get metadata for a specific operation. Returns `undefined` if the
 * operation is not recognized.
 */
export function getBrowserOperationMeta(
  operation: BrowserOperation,
): BrowserOperationMeta | undefined {
  return META_BY_OPERATION.get(operation);
}
