/**
 * Utility functions for tool call display — friendly labels and icons.
 * Ported from the macOS desktop app's ChatBubbleToolHelpers.swift.
 */

import { truncate as truncateShared } from "@/domains/chat/utils/truncate";

/** Extract just the filename from a file path string. */
function extractFileName(path: string): string | null {
  if (!path) {
    return null;
  }
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  if (!last || last === ".") {
    return null;
  }
  return last;
}

/** Truncate a string to `max` characters, appending "..." if truncated. */
function truncate(str: string, max: number): string {
  return truncateShared(str, max, "...");
}

/**
 * Recognized browser operations from `assistant browser <operation>` commands.
 * Maps CLI operation names to a canonical browser action key.
 */
type BrowserOperation =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "snapshot"
  | "scroll"
  | "hover"
  | "select"
  | "drag"
  | "wait"
  | "back"
  | "forward"
  | "refresh"
  | "close"
  | "tab"
  | "press_key"
  | "wait_for"
  | "extract"
  | "fill_credential"
  | "unknown";

/**
 * Parse a bash command string to detect `assistant browser <operation> ...`.
 * Returns the detected browser operation or null if the command is not a
 * browser CLI invocation.
 */
export function parseBrowserOperation(
  command: string,
): BrowserOperation | null {
  if (!command) {
    return null;
  }
  // Normalize whitespace and trim
  const normalized = command.replace(/\s+/g, " ").trim();

  // Match `assistant browser <operation>` anywhere in the command.
  // Handles compound shell commands (e.g., `cd /tmp && assistant browser ...`)
  // and path-prefixed invocations (e.g., `./assistant browser ...`).
  const match = normalized.match(
    /(?:^|&&\s*|\|\|\s*|;\s*)(?:\S*\/)?assistant\s+browser\s+([^\s;&|]+)/i,
  );
  if (!match) {
    return null;
  }

  const op = match[1]!.toLowerCase();

  const knownOps: Set<string> = new Set<string>([
    "navigate",
    "click",
    "type",
    "screenshot",
    "snapshot",
    "scroll",
    "hover",
    "select",
    "drag",
    "wait",
    "back",
    "forward",
    "refresh",
    "close",
    "tab",
    "press_key",
    "wait_for",
    "extract",
    "fill_credential",
  ]);

  if (knownOps.has(op)) {
    return op as BrowserOperation;
  }

  // Fallback: any `assistant browser <op>` is treated as a generic browser
  // operation rather than returning null. This is more future-proof and
  // matches the vel logs parser behavior.
  return "unknown";
}

/**
 * Extract the browser operation from a tool call if the tool is bash/host_bash
 * and the command is an `assistant browser` invocation.
 */
function detectBrowserOp(
  toolName: string,
  inputSummary: string,
): BrowserOperation | null {
  const name = toolName.toLowerCase();
  if (name !== "bash" && name !== "host_bash") {
    return null;
  }
  return parseBrowserOperation(inputSummary);
}

/** Past-tense label for a browser operation. */
function browserOpLabel(op: BrowserOperation): string {
  switch (op) {
    case "navigate":
      return "Opened a page";
    case "click":
      return "Clicked on the page";
    case "type":
      return "Typed on the page";
    case "screenshot":
      return "Took a screenshot";
    case "snapshot":
      return "Captured page snapshot";
    case "scroll":
      return "Scrolled the page";
    case "hover":
      return "Hovered on the page";
    case "select":
      return "Selected on the page";
    case "drag":
      return "Dragged on the page";
    case "wait":
      return "Waited for the page";
    case "back":
      return "Went back";
    case "forward":
      return "Went forward";
    case "refresh":
      return "Refreshed the page";
    case "close":
      return "Closed the tab";
    case "tab":
      return "Switched tabs";
    case "press_key":
      return "Pressed a key";
    case "wait_for":
      return "Waited for a condition";
    case "extract":
      return "Extracted page content";
    case "fill_credential":
      return "Filled a credential";
    case "unknown":
      return "Used the browser";
  }
}

/** Present-tense (running) label for a browser operation. */
function browserOpRunningLabel(op: BrowserOperation): string {
  switch (op) {
    case "navigate":
      return "Opening a page";
    case "click":
      return "Clicking on the page";
    case "type":
      return "Typing on the page";
    case "screenshot":
      return "Taking a screenshot";
    case "snapshot":
      return "Capturing page snapshot";
    case "scroll":
      return "Scrolling the page";
    case "hover":
      return "Hovering on the page";
    case "select":
      return "Selecting on the page";
    case "drag":
      return "Dragging on the page";
    case "wait":
      return "Waiting for the page";
    case "back":
      return "Going back";
    case "forward":
      return "Going forward";
    case "refresh":
      return "Refreshing the page";
    case "close":
      return "Closing the tab";
    case "tab":
      return "Switching tabs";
    case "press_key":
      return "Pressing a key";
    case "wait_for":
      return "Waiting for a condition";
    case "extract":
      return "Extracting page content";
    case "fill_credential":
      return "Filling a credential";
    case "unknown":
      return "Using the browser";
  }
}

/** Icon identifier (lucide icon name) for a browser operation. */
function browserOpIcon(op: BrowserOperation): string {
  switch (op) {
    case "navigate":
    case "back":
    case "forward":
    case "tab":
      return "compass";
    case "click":
    case "hover":
    case "select":
    case "drag":
    case "scroll":
      return "compass";
    case "screenshot":
    case "snapshot":
      return "camera";
    case "type":
    case "press_key":
    case "fill_credential":
      return "compass";
    case "wait":
    case "wait_for":
    case "refresh":
    case "close":
      return "compass";
    case "extract":
      return "compass";
    case "unknown":
      return "compass";
  }
}

/** Extract a human-readable input summary from the tool input object. */
export function extractInputSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  if (name === "bash" || name === "host_bash") {
    const command = input.command ?? input.cmd;
    if (typeof command === "string") {
      return command.replace(/\s+/g, " ").trim();
    }
  }

  if (
    name === "file_read" ||
    name === "host_file_read" ||
    name === "file_write" ||
    name === "host_file_write" ||
    name === "file_edit" ||
    name === "host_file_edit"
  ) {
    const filePath = input.file_path ?? input.path ?? input.filePath;
    if (typeof filePath === "string") {
      return filePath;
    }
  }

  if (name === "grep" || name === "glob") {
    const pattern = input.pattern ?? input.query;
    if (typeof pattern === "string") {
      return pattern;
    }
  }

  if (name === "web_search") {
    const query = input.query ?? input.search;
    if (typeof query === "string") {
      return query;
    }
  }

  return "";
}

/**
 * Maps tool names to user-friendly past-tense labels.
 * Mirrors the desktop app's `friendlyToolLabel`.
 *
 * For bash/host_bash tool calls, inspects the command string to detect
 * `assistant browser <operation>` invocations and returns browser-specific
 * labels instead of generic shell-command labels.
 */
export function friendlyToolLabel(
  toolName: string,
  inputSummary: string = "",
): string {
  const name = toolName.toLowerCase();
  const summary = inputSummary.replace(/\s+/g, " ").trim();
  const fileName = extractFileName(summary);

  // Check for `assistant browser` CLI commands inside bash/host_bash calls
  const browserOp = detectBrowserOp(toolName, summary);
  if (browserOp) {
    return browserOpLabel(browserOp);
  }

  switch (name) {
    case "bash":
    case "host_bash":
      if (summary) {
        return `Ran \`${truncate(summary, 30)}\``;
      }
      return "Ran a command";

    case "file_read":
    case "host_file_read":
      if (fileName) {
        return `Read ${fileName}`;
      }
      return "Read a file";

    case "file_write":
    case "host_file_write":
      if (fileName) {
        return `Wrote ${fileName}`;
      }
      return "Wrote a file";

    case "file_edit":
    case "host_file_edit":
      if (fileName) {
        return `Edited ${fileName}`;
      }
      return "Edited a file";

    case "grep":
      if (summary) {
        return `Searched for '${truncate(summary, 25)}'`;
      }
      return "Searched files";

    case "glob":
      if (summary) {
        return `Searched for ${truncate(summary, 25)}`;
      }
      return "Found files";

    case "web_search":
      if (summary) {
        return `Searched '${truncate(summary, 25)}'`;
      }
      return "Searched the web";

    case "web_fetch":
      return "Fetched a webpage";

    default: {
      const display = toolName.replace(/_/g, " ");
      return `Used ${display}`;
    }
  }
}

/**
 * Maps tool names to user-friendly present-tense labels for the running state.
 * Mirrors the desktop app's `friendlyRunningLabel`.
 *
 * Accepts an optional `inputSummary` to detect `assistant browser` CLI
 * commands inside bash/host_bash calls.
 */
export function friendlyRunningLabel(
  toolName: string,
  inputSummary: string = "",
  buildingStatus?: string,
): string {
  // Check for browser CLI commands in bash/host_bash
  const browserOp = detectBrowserOp(toolName, inputSummary);
  if (browserOp) {
    return browserOpRunningLabel(browserOp);
  }

  // buildingStatus override for app tools — mirrors macOS ChatBubbleToolHelpers.swift
  if (buildingStatus) {
    const name = toolName.toLowerCase();
    if (name === "app_create" || name === "app_refresh" || name === "app_update") {
      return buildingStatus;
    }
  }

  switch (toolName.toLowerCase()) {
    case "bash":
    case "host_bash":
      return "Running a command";
    case "file_read":
    case "host_file_read":
      return "Reading a file";
    case "file_write":
    case "host_file_write":
      return "Writing a file";
    case "file_edit":
    case "host_file_edit":
      return "Editing a file";
    case "grep":
      return "Searching files";
    case "glob":
      return "Finding files";
    case "web_search":
      return "Searching the web";
    case "web_fetch":
      return "Fetching a webpage";

    case "app_create":
      return "Building your app";
    case "app_refresh":
    case "app_update":
      return "Refreshing your app";
    default: {
      const display = toolName.replace(/_/g, " ");
      return `Running ${display}`;
    }
  }
}

/**
 * Returns an array of progressive headline labels for long-running app tools.
 * These labels cycle in the progress card headline while the tool is running,
 * giving users a sense of forward momentum.
 *
 * Mirrors macOS ChatBubbleToolHelpers.swift progressiveLabels.
 */
export function progressiveLabels(toolName: string): string[] {
  switch (toolName.toLowerCase()) {
    case "app_create":
      return [
        "Choosing a visual direction",
        "Designing the layout",
        "Writing the interface",
        "Adding styles and colors",
        "Wiring up interactions",
        "Polishing the details",
        "Almost there",
      ];
    case "app_refresh":
    case "app_update":
      return [
        "Reviewing your app",
        "Applying changes",
        "Refreshing the interface",
        "Polishing the details",
      ];
    default:
      return [];
  }
}

/**
 * Title Case a snake_case / kebab-case tool name for use as a fallback display
 * label. Splits on `_` and `-` (one or more), filters out empty segments
 * produced by repeated separators, capitalizes the first letter of each word
 * and lowercases the remainder, then joins with spaces.
 *
 * Exported for reuse by the unified tool-progress card and the subagent
 * inline card so a single helper produces the "Tool Name" mapping across
 * the chat domain.
 */
export function titleCaseToolName(toolName: string): string {
  return toolName
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Short present-tense label for a tool name, matching the macOS desktop app's
 * `ToolCallData.friendlyName` from `ChatMessage.swift`.
 *
 * Unlike `friendlyToolLabel` (which is past-tense and context-aware), this
 * returns a fixed, short label suitable for pill/chip display.
 */
export function friendlyName(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case "bash":
    case "host_bash":
      return "Run Command";
    case "file_write":
    case "host_file_write":
      return "Write File";
    case "file_edit":
    case "host_file_edit":
      return "Edit File";
    case "file_read":
    case "host_file_read":
      return "Read File";
    case "glob":
      return "Find Files";
    case "grep":
      return "Search Files";
    case "web_fetch":
      return "Fetch URL";
    case "web_search":
      return "Web Search";
    case "browser_navigate":
      return "Open Page";
    case "browser_screenshot":
      return "Take Screenshot";
    case "browser_click":
      return "Click Element";
    case "browser_type":
      return "Type Text";
    case "app_create":
      return "Create App";
    case "app_refresh":
    case "app_update":
      return "Refresh App";
    case "skill_execute":
      return "Use Skill";
    default:
      return titleCaseToolName(toolName);
  }
}

/**
 * Broader category label for a tool name, matching the macOS desktop app's
 * `ToolCallData.toolCategory` from `ChatMessage.swift`.
 *
 * Uses prefix-based grouping for tool families (e.g. all `browser_*` tools
 * map to "Browser") rather than individual labels.
 */
export function toolCategory(toolName: string): string {
  const name = toolName.toLowerCase();

  switch (name) {
    case "bash":
    case "host_bash":
      return "Run Command";
    case "file_write":
    case "host_file_write":
      return "Write File";
    case "file_edit":
    case "host_file_edit":
      return "Edit File";
    case "file_read":
    case "host_file_read":
      return "Read File";
    case "glob":
      return "Find Files";
    case "grep":
      return "Search Files";
    case "web_fetch":
      return "Fetch URL";
    case "web_search":
      return "Web Search";
    case "credential_store":
      return "Secure Storage";
    case "skill_load":
      return "Skill";
    case "evaluate_typescript_code":
      return "Code Sandbox";
    case "document_create":
    case "document_update":
      return "Document";
    default:
      break;
  }

  // Prefix-based grouping
  if (name.startsWith("browser_")) return "Browser";
  if (name.startsWith("schedule_")) return "Scheduling";
  if (name.startsWith("watcher_")) return "Watcher";
  if (name.startsWith("memory_")) return "Memory";

  return titleCaseToolName(toolName);
}

/**
 * Maps tool names to icon identifiers (lucide icon names).
 * Mirrors the desktop app's `friendlyToolIcon`.
 *
 * Accepts an optional `inputSummary` to detect `assistant browser` CLI
 * commands inside bash/host_bash calls.
 */
export function friendlyToolIcon(
  toolName: string,
  inputSummary: string = "",
): string {
  // Check for browser CLI commands in bash/host_bash
  const browserOp = detectBrowserOp(toolName, inputSummary);
  if (browserOp) {
    return browserOpIcon(browserOp);
  }

  switch (toolName.toLowerCase()) {
    case "bash":
    case "host_bash":
      return "terminal";
    case "file_read":
    case "host_file_read":
      return "file-text";
    case "file_write":
    case "host_file_write":
      return "file-plus";
    case "file_edit":
    case "host_file_edit":
      return "pencil";
    case "grep":
    case "glob":
    case "web_search":
      return "search";
    case "web_fetch":
      return "globe";

    default:
      return "wrench";
  }
}
