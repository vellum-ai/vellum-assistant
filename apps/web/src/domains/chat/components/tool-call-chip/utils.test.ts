import { describe, expect, test } from "bun:test";

import {
  extractInputSummary,
  friendlyName,
  friendlyRunningLabel,
  friendlyToolIcon,
  friendlyToolLabel,
  parseBrowserOperation,
  progressiveLabels,
  toolCategory,
} from "@/domains/chat/components/tool-call-chip/utils";

// ---------------------------------------------------------------------------
// parseBrowserOperation
// ---------------------------------------------------------------------------

describe("parseBrowserOperation", () => {
  test("detects navigate operation", () => {
    expect(
      parseBrowserOperation("assistant browser navigate https://example.com"),
    ).toBe("navigate");
  });

  test("detects click operation", () => {
    expect(parseBrowserOperation("assistant browser click #button")).toBe(
      "click",
    );
  });

  test("detects type operation", () => {
    expect(parseBrowserOperation("assistant browser type hello")).toBe("type");
  });

  test("detects screenshot operation", () => {
    expect(parseBrowserOperation("assistant browser screenshot")).toBe(
      "screenshot",
    );
  });

  test("detects snapshot operation", () => {
    expect(parseBrowserOperation("assistant browser snapshot")).toBe(
      "snapshot",
    );
  });

  test("detects scroll operation", () => {
    expect(parseBrowserOperation("assistant browser scroll down")).toBe(
      "scroll",
    );
  });

  test("detects hover operation", () => {
    expect(parseBrowserOperation("assistant browser hover .menu")).toBe(
      "hover",
    );
  });

  test("detects select operation", () => {
    expect(parseBrowserOperation("assistant browser select option-1")).toBe(
      "select",
    );
  });

  test("detects drag operation", () => {
    expect(parseBrowserOperation("assistant browser drag 100 200")).toBe(
      "drag",
    );
  });

  test("detects wait operation", () => {
    expect(parseBrowserOperation("assistant browser wait 5000")).toBe("wait");
  });

  test("detects back operation", () => {
    expect(parseBrowserOperation("assistant browser back")).toBe("back");
  });

  test("detects forward operation", () => {
    expect(parseBrowserOperation("assistant browser forward")).toBe("forward");
  });

  test("detects refresh operation", () => {
    expect(parseBrowserOperation("assistant browser refresh")).toBe("refresh");
  });

  test("detects close operation", () => {
    expect(parseBrowserOperation("assistant browser close")).toBe("close");
  });

  test("detects tab operation", () => {
    expect(parseBrowserOperation("assistant browser tab 2")).toBe("tab");
  });

  test("is case-insensitive for the command prefix", () => {
    expect(
      parseBrowserOperation("Assistant Browser Navigate https://example.com"),
    ).toBe("navigate");
  });

  test("handles extra whitespace", () => {
    expect(
      parseBrowserOperation(
        "  assistant   browser   navigate   https://example.com  ",
      ),
    ).toBe("navigate");
  });

  test("returns null for non-browser commands", () => {
    expect(parseBrowserOperation("ls -la")).toBeNull();
  });

  test("detects press_key operation", () => {
    expect(parseBrowserOperation("assistant browser press_key Enter")).toBe(
      "press_key",
    );
  });

  test("detects wait_for operation", () => {
    expect(parseBrowserOperation("assistant browser wait_for .loaded")).toBe(
      "wait_for",
    );
  });

  test("detects extract operation", () => {
    expect(parseBrowserOperation("assistant browser extract")).toBe("extract");
  });

  test("detects fill_credential operation", () => {
    expect(
      parseBrowserOperation("assistant browser fill_credential password"),
    ).toBe("fill_credential");
  });

  test("returns unknown for unrecognized browser operations", () => {
    expect(parseBrowserOperation("assistant browser unknownop foo")).toBe(
      "unknown",
    );
  });

  test("returns null for empty string", () => {
    expect(parseBrowserOperation("")).toBeNull();
  });

  test("returns null for partial match", () => {
    expect(parseBrowserOperation("assistant")).toBeNull();
    expect(parseBrowserOperation("assistant browser")).toBeNull();
  });

  // Compound shell commands
  test("detects operation after && in compound command", () => {
    expect(
      parseBrowserOperation(
        "cd /tmp && assistant browser navigate https://example.com",
      ),
    ).toBe("navigate");
  });

  test("detects operation after || in compound command", () => {
    expect(parseBrowserOperation("false || assistant browser click #btn")).toBe(
      "click",
    );
  });

  test("detects operation after ; in compound command", () => {
    expect(
      parseBrowserOperation("export FOO=bar; assistant browser screenshot"),
    ).toBe("screenshot");
  });

  // Path-prefixed invocations
  test("detects operation with relative path prefix", () => {
    expect(
      parseBrowserOperation("./assistant browser navigate https://example.com"),
    ).toBe("navigate");
  });

  test("detects operation with absolute path prefix", () => {
    expect(
      parseBrowserOperation("/usr/local/bin/assistant browser click #btn"),
    ).toBe("click");
  });

  test("detects operation with path prefix after &&", () => {
    expect(
      parseBrowserOperation("cd /app && ./assistant browser scroll down"),
    ).toBe("scroll");
  });

  // Trailing shell operators should not be captured as part of the operation
  test("stops at trailing semicolon without space", () => {
    expect(
      parseBrowserOperation("assistant browser screenshot;echo done"),
    ).toBe("screenshot");
  });

  test("stops at trailing && without space", () => {
    expect(
      parseBrowserOperation("assistant browser screenshot&&echo done"),
    ).toBe("screenshot");
  });

  test("stops at trailing || without space", () => {
    expect(
      parseBrowserOperation("assistant browser screenshot||echo done"),
    ).toBe("screenshot");
  });

  test("stops at trailing pipe without space", () => {
    expect(parseBrowserOperation("assistant browser screenshot|cat")).toBe(
      "screenshot",
    );
  });
});

// ---------------------------------------------------------------------------
// friendlyToolLabel — CLI-based browser operations
// ---------------------------------------------------------------------------

describe("friendlyToolLabel — CLI browser operations", () => {
  test("host_bash with assistant browser navigate renders opened page label", () => {
    expect(
      friendlyToolLabel(
        "host_bash",
        "assistant browser navigate https://example.com",
      ),
    ).toBe("Opened a page");
  });

  test("bash with assistant browser click renders clicked label", () => {
    expect(friendlyToolLabel("bash", "assistant browser click #submit")).toBe(
      "Clicked on the page",
    );
  });

  test("host_bash with assistant browser type renders typed label", () => {
    expect(
      friendlyToolLabel("host_bash", "assistant browser type hello world"),
    ).toBe("Typed on the page");
  });

  test("bash with assistant browser screenshot renders screenshot label", () => {
    expect(friendlyToolLabel("bash", "assistant browser screenshot")).toBe(
      "Took a screenshot",
    );
  });

  test("host_bash with assistant browser snapshot renders snapshot label", () => {
    expect(friendlyToolLabel("host_bash", "assistant browser snapshot")).toBe(
      "Captured page snapshot",
    );
  });

  test("bash with assistant browser scroll renders scroll label", () => {
    expect(friendlyToolLabel("bash", "assistant browser scroll down")).toBe(
      "Scrolled the page",
    );
  });

  test("bash with assistant browser hover renders hover label", () => {
    expect(
      friendlyToolLabel("bash", "assistant browser hover .menu-item"),
    ).toBe("Hovered on the page");
  });

  test("bash with assistant browser wait renders wait label", () => {
    expect(friendlyToolLabel("bash", "assistant browser wait 3000")).toBe(
      "Waited for the page",
    );
  });

  test("bash with assistant browser back renders back label", () => {
    expect(friendlyToolLabel("bash", "assistant browser back")).toBe(
      "Went back",
    );
  });

  test("bash with assistant browser forward renders forward label", () => {
    expect(friendlyToolLabel("bash", "assistant browser forward")).toBe(
      "Went forward",
    );
  });

  test("bash with assistant browser refresh renders refresh label", () => {
    expect(friendlyToolLabel("bash", "assistant browser refresh")).toBe(
      "Refreshed the page",
    );
  });

  test("bash with assistant browser close renders close label", () => {
    expect(friendlyToolLabel("bash", "assistant browser close")).toBe(
      "Closed the tab",
    );
  });

  test("bash with assistant browser tab renders tab label", () => {
    expect(friendlyToolLabel("bash", "assistant browser tab 2")).toBe(
      "Switched tabs",
    );
  });

  test("non-bash tool is not affected by browser-like input", () => {
    expect(
      friendlyToolLabel(
        "grep",
        "assistant browser navigate https://example.com",
      ),
    ).toBe("Searched for 'assistant browser navi...'");
  });

  test("bash with assistant browser press_key renders key press label", () => {
    expect(friendlyToolLabel("bash", "assistant browser press_key Enter")).toBe(
      "Pressed a key",
    );
  });

  test("bash with assistant browser wait_for renders wait condition label", () => {
    expect(
      friendlyToolLabel("bash", "assistant browser wait_for .loaded"),
    ).toBe("Waited for a condition");
  });

  test("bash with assistant browser extract renders extract label", () => {
    expect(friendlyToolLabel("bash", "assistant browser extract")).toBe(
      "Extracted page content",
    );
  });

  test("bash with assistant browser fill_credential renders credential label", () => {
    expect(
      friendlyToolLabel("bash", "assistant browser fill_credential password"),
    ).toBe("Filled a credential");
  });

  test("bash with unknown browser op falls back to generic browser label", () => {
    expect(friendlyToolLabel("bash", "assistant browser unknownop")).toBe(
      "Used the browser",
    );
  });

  test("bash with non-browser command falls back to generic command label", () => {
    expect(friendlyToolLabel("bash", "ls -la /tmp")).toBe("Ran `ls -la /tmp`");
  });
});

// ---------------------------------------------------------------------------
// friendlyRunningLabel — CLI-based browser operations
// ---------------------------------------------------------------------------

describe("friendlyRunningLabel — CLI browser operations", () => {
  test("host_bash with assistant browser navigate renders opening label", () => {
    expect(
      friendlyRunningLabel(
        "host_bash",
        "assistant browser navigate https://example.com",
      ),
    ).toBe("Opening a page");
  });

  test("bash with assistant browser click renders clicking label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser click #btn")).toBe(
      "Clicking on the page",
    );
  });

  test("bash with assistant browser type renders typing label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser type hello")).toBe(
      "Typing on the page",
    );
  });

  test("bash with assistant browser screenshot renders taking screenshot label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser screenshot")).toBe(
      "Taking a screenshot",
    );
  });

  test("bash with assistant browser snapshot renders capturing label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser snapshot")).toBe(
      "Capturing page snapshot",
    );
  });

  test("bash with assistant browser press_key renders pressing label", () => {
    expect(
      friendlyRunningLabel("bash", "assistant browser press_key Enter"),
    ).toBe("Pressing a key");
  });

  test("bash with assistant browser wait_for renders waiting label", () => {
    expect(
      friendlyRunningLabel("bash", "assistant browser wait_for .loaded"),
    ).toBe("Waiting for a condition");
  });

  test("bash with assistant browser extract renders extracting label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser extract")).toBe(
      "Extracting page content",
    );
  });

  test("bash with assistant browser fill_credential renders filling label", () => {
    expect(
      friendlyRunningLabel(
        "bash",
        "assistant browser fill_credential password",
      ),
    ).toBe("Filling a credential");
  });

  test("bash with unknown browser op falls back to generic browser running label", () => {
    expect(friendlyRunningLabel("bash", "assistant browser unknownop")).toBe(
      "Using the browser",
    );
  });

  test("bash with non-browser command falls back to generic running label", () => {
    expect(friendlyRunningLabel("bash", "npm install")).toBe(
      "Running a command",
    );
  });

  test("host_bash without input summary falls back to generic running label", () => {
    expect(friendlyRunningLabel("host_bash")).toBe("Running a command");
  });
});

// ---------------------------------------------------------------------------
// friendlyRunningLabel — buildingStatus override for app tools
// ---------------------------------------------------------------------------

describe("friendlyRunningLabel — buildingStatus", () => {
  test("app_create with buildingStatus returns the status string", () => {
    expect(friendlyRunningLabel("app_create", "", "Adding dark mode styles")).toBe(
      "Adding dark mode styles",
    );
  });

  test("app_refresh with buildingStatus returns the status string", () => {
    expect(friendlyRunningLabel("app_refresh", "", "Updating layout")).toBe(
      "Updating layout",
    );
  });

  test("app_update with buildingStatus returns the status string", () => {
    expect(friendlyRunningLabel("app_update", "", "Fixing responsive grid")).toBe(
      "Fixing responsive grid",
    );
  });

  test("app_create without buildingStatus returns default label", () => {
    expect(friendlyRunningLabel("app_create")).toBe("Building your app");
  });

  test("bash with buildingStatus ignores it and returns generic label", () => {
    expect(friendlyRunningLabel("bash", "", "Adding dark mode styles")).toBe(
      "Running a command",
    );
  });

  test("non-app tool with buildingStatus ignores it", () => {
    expect(friendlyRunningLabel("file_read", "", "Some status")).toBe(
      "Reading a file",
    );
  });
});

// ---------------------------------------------------------------------------
// friendlyToolIcon — CLI-based browser operations
// ---------------------------------------------------------------------------

describe("friendlyToolIcon — CLI browser operations", () => {
  test("host_bash with assistant browser navigate returns compass", () => {
    expect(
      friendlyToolIcon(
        "host_bash",
        "assistant browser navigate https://example.com",
      ),
    ).toBe("compass");
  });

  test("bash with assistant browser click returns compass", () => {
    expect(friendlyToolIcon("bash", "assistant browser click #btn")).toBe(
      "compass",
    );
  });

  test("bash with assistant browser screenshot returns camera", () => {
    expect(friendlyToolIcon("bash", "assistant browser screenshot")).toBe(
      "camera",
    );
  });

  test("bash with assistant browser snapshot returns camera", () => {
    expect(friendlyToolIcon("bash", "assistant browser snapshot")).toBe(
      "camera",
    );
  });

  test("bash with assistant browser press_key returns compass", () => {
    expect(friendlyToolIcon("bash", "assistant browser press_key Enter")).toBe(
      "compass",
    );
  });

  test("bash with assistant browser extract returns compass", () => {
    expect(friendlyToolIcon("bash", "assistant browser extract")).toBe(
      "compass",
    );
  });

  test("bash with unknown browser op returns compass", () => {
    expect(friendlyToolIcon("bash", "assistant browser unknownop")).toBe(
      "compass",
    );
  });

  test("bash with non-browser command returns terminal", () => {
    expect(friendlyToolIcon("bash", "npm install")).toBe("terminal");
  });

  test("host_bash without input summary returns terminal", () => {
    expect(friendlyToolIcon("host_bash")).toBe("terminal");
  });
});

// ---------------------------------------------------------------------------
// extractInputSummary — ensure browser commands pass through correctly
// ---------------------------------------------------------------------------

describe("extractInputSummary", () => {
  test("extracts command from bash tool call", () => {
    expect(
      extractInputSummary("bash", {
        command: "assistant browser navigate https://example.com",
      }),
    ).toBe("assistant browser navigate https://example.com");
  });

  test("extracts command from host_bash tool call", () => {
    expect(
      extractInputSummary("host_bash", {
        command: "assistant browser click #btn",
      }),
    ).toBe("assistant browser click #btn");
  });

  test("normalizes whitespace", () => {
    expect(
      extractInputSummary("bash", {
        command: "assistant  browser   navigate   https://example.com",
      }),
    ).toBe("assistant browser navigate https://example.com");
  });

  test("extracts from cmd field as fallback", () => {
    expect(
      extractInputSummary("host_bash", { cmd: "assistant browser screenshot" }),
    ).toBe("assistant browser screenshot");
  });
});

// ---------------------------------------------------------------------------
// friendlyToolLabel / friendlyRunningLabel / friendlyToolIcon — non-browser tools unchanged
// ---------------------------------------------------------------------------

describe("non-browser tools remain unchanged", () => {
  test("friendlyToolLabel for file_read", () => {
    expect(friendlyToolLabel("file_read", "/src/index.ts")).toBe(
      "Read index.ts",
    );
  });

  test("friendlyToolLabel for grep", () => {
    expect(friendlyToolLabel("grep", "TODO")).toBe("Searched for 'TODO'");
  });

  test("friendlyToolLabel for web_fetch", () => {
    expect(friendlyToolLabel("web_fetch")).toBe("Fetched a webpage");
  });

  test("friendlyRunningLabel for file_edit", () => {
    expect(friendlyRunningLabel("file_edit")).toBe("Editing a file");
  });

  test("friendlyToolIcon for grep", () => {
    expect(friendlyToolIcon("grep")).toBe("search");
  });

  test("friendlyToolIcon for unknown tool", () => {
    expect(friendlyToolIcon("some_custom_tool")).toBe("wrench");
  });
});

// ---------------------------------------------------------------------------
// progressiveLabels
// ---------------------------------------------------------------------------

describe("progressiveLabels", () => {
  test("app_create returns 7 labels", () => {
    const labels = progressiveLabels("app_create");
    expect(labels).toHaveLength(7);
    expect(labels[0]).toBe("Choosing a visual direction");
    expect(labels[6]).toBe("Almost there");
  });

  test("app_refresh returns 4 labels", () => {
    const labels = progressiveLabels("app_refresh");
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe("Reviewing your app");
    expect(labels[3]).toBe("Polishing the details");
  });

  test("app_update returns 4 labels (same as app_refresh)", () => {
    const labels = progressiveLabels("app_update");
    expect(labels).toHaveLength(4);
    expect(labels).toEqual(progressiveLabels("app_refresh"));
  });

  test("is case-insensitive", () => {
    expect(progressiveLabels("APP_CREATE")).toHaveLength(7);
    expect(progressiveLabels("App_Refresh")).toHaveLength(4);
  });

  test("unknown tools return empty array", () => {
    expect(progressiveLabels("bash")).toEqual([]);
    expect(progressiveLabels("file_read")).toEqual([]);
    expect(progressiveLabels("some_unknown_tool")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// friendlyName
// ---------------------------------------------------------------------------

describe("friendlyName", () => {
  test("bash returns Run Command", () => {
    expect(friendlyName("bash")).toBe("Run Command");
  });

  test("host_bash returns Run Command", () => {
    expect(friendlyName("host_bash")).toBe("Run Command");
  });

  test("file_write returns Write File", () => {
    expect(friendlyName("file_write")).toBe("Write File");
  });

  test("host_file_write returns Write File", () => {
    expect(friendlyName("host_file_write")).toBe("Write File");
  });

  test("file_edit returns Edit File", () => {
    expect(friendlyName("file_edit")).toBe("Edit File");
  });

  test("host_file_edit returns Edit File", () => {
    expect(friendlyName("host_file_edit")).toBe("Edit File");
  });

  test("file_read returns Read File", () => {
    expect(friendlyName("file_read")).toBe("Read File");
  });

  test("host_file_read returns Read File", () => {
    expect(friendlyName("host_file_read")).toBe("Read File");
  });

  test("glob returns Find Files", () => {
    expect(friendlyName("glob")).toBe("Find Files");
  });

  test("grep returns Search Files", () => {
    expect(friendlyName("grep")).toBe("Search Files");
  });

  test("web_fetch returns Fetch URL", () => {
    expect(friendlyName("web_fetch")).toBe("Fetch URL");
  });

  test("web_search returns Web Search", () => {
    expect(friendlyName("web_search")).toBe("Web Search");
  });

  test("browser_navigate returns Open Page", () => {
    expect(friendlyName("browser_navigate")).toBe("Open Page");
  });

  test("browser_screenshot returns Take Screenshot", () => {
    expect(friendlyName("browser_screenshot")).toBe("Take Screenshot");
  });

  test("browser_click returns Click Element", () => {
    expect(friendlyName("browser_click")).toBe("Click Element");
  });

  test("browser_type returns Type Text", () => {
    expect(friendlyName("browser_type")).toBe("Type Text");
  });

  test("app_create returns Create App", () => {
    expect(friendlyName("app_create")).toBe("Create App");
  });

  test("app_refresh returns Refresh App", () => {
    expect(friendlyName("app_refresh")).toBe("Refresh App");
  });

  test("app_update returns Refresh App", () => {
    expect(friendlyName("app_update")).toBe("Refresh App");
  });

  test("skill_execute returns Use Skill", () => {
    expect(friendlyName("skill_execute")).toBe("Use Skill");
  });

  test("is case-insensitive", () => {
    expect(friendlyName("BASH")).toBe("Run Command");
    expect(friendlyName("File_Read")).toBe("Read File");
  });

  test("unknown tool falls back to Title Case", () => {
    expect(friendlyName("some_custom_tool")).toBe("Some Custom Tool");
  });

  test("single-word unknown tool is capitalized", () => {
    expect(friendlyName("mytool")).toBe("Mytool");
  });
});

// ---------------------------------------------------------------------------
// toolCategory
// ---------------------------------------------------------------------------

describe("toolCategory", () => {
  test("bash returns Run Command", () => {
    expect(toolCategory("bash")).toBe("Run Command");
  });

  test("host_bash returns Run Command", () => {
    expect(toolCategory("host_bash")).toBe("Run Command");
  });

  test("file_write returns Write File", () => {
    expect(toolCategory("file_write")).toBe("Write File");
  });

  test("host_file_write returns Write File", () => {
    expect(toolCategory("host_file_write")).toBe("Write File");
  });

  test("file_edit returns Edit File", () => {
    expect(toolCategory("file_edit")).toBe("Edit File");
  });

  test("host_file_edit returns Edit File", () => {
    expect(toolCategory("host_file_edit")).toBe("Edit File");
  });

  test("file_read returns Read File", () => {
    expect(toolCategory("file_read")).toBe("Read File");
  });

  test("host_file_read returns Read File", () => {
    expect(toolCategory("host_file_read")).toBe("Read File");
  });

  test("glob returns Find Files", () => {
    expect(toolCategory("glob")).toBe("Find Files");
  });

  test("grep returns Search Files", () => {
    expect(toolCategory("grep")).toBe("Search Files");
  });

  test("web_fetch returns Fetch URL", () => {
    expect(toolCategory("web_fetch")).toBe("Fetch URL");
  });

  test("web_search returns Web Search", () => {
    expect(toolCategory("web_search")).toBe("Web Search");
  });

  test("credential_store returns Secure Storage", () => {
    expect(toolCategory("credential_store")).toBe("Secure Storage");
  });

  test("skill_load returns Skill", () => {
    expect(toolCategory("skill_load")).toBe("Skill");
  });

  test("evaluate_typescript_code returns Code Sandbox", () => {
    expect(toolCategory("evaluate_typescript_code")).toBe("Code Sandbox");
  });

  test("document_create returns Document", () => {
    expect(toolCategory("document_create")).toBe("Document");
  });

  test("document_update returns Document", () => {
    expect(toolCategory("document_update")).toBe("Document");
  });

  // Prefix-based grouping
  test("browser_click returns Browser (prefix grouping)", () => {
    expect(toolCategory("browser_click")).toBe("Browser");
  });

  test("browser_navigate returns Browser (prefix grouping)", () => {
    expect(toolCategory("browser_navigate")).toBe("Browser");
  });

  test("browser_screenshot returns Browser (prefix grouping)", () => {
    expect(toolCategory("browser_screenshot")).toBe("Browser");
  });

  test("schedule_create returns Scheduling (prefix grouping)", () => {
    expect(toolCategory("schedule_create")).toBe("Scheduling");
  });

  test("schedule_delete returns Scheduling (prefix grouping)", () => {
    expect(toolCategory("schedule_delete")).toBe("Scheduling");
  });

  test("watcher_create returns Watcher (prefix grouping)", () => {
    expect(toolCategory("watcher_create")).toBe("Watcher");
  });

  test("watcher_remove returns Watcher (prefix grouping)", () => {
    expect(toolCategory("watcher_remove")).toBe("Watcher");
  });

  test("memory_read returns Memory (prefix grouping)", () => {
    expect(toolCategory("memory_read")).toBe("Memory");
  });

  test("memory_write returns Memory (prefix grouping)", () => {
    expect(toolCategory("memory_write")).toBe("Memory");
  });

  test("is case-insensitive", () => {
    expect(toolCategory("BASH")).toBe("Run Command");
    expect(toolCategory("BROWSER_CLICK")).toBe("Browser");
  });

  test("unknown tool falls back to Title Case", () => {
    expect(toolCategory("some_custom_tool")).toBe("Some Custom Tool");
  });
});
