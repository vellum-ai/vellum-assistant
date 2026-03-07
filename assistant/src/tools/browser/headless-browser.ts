import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserExtract,
  executeBrowserFillCredential,
  executeBrowserHover,
  executeBrowserNavigate,
  executeBrowserPressKey,
  executeBrowserScreenshot,
  executeBrowserScroll,
  executeBrowserSelectOption,
  executeBrowserSnapshot,
  executeBrowserType,
  executeBrowserWaitFor,
} from "./browser-execution.js";

// ── browser_navigate ─────────────────────────────────────────────────

class BrowserNavigateTool implements Tool {
  name = "browser_navigate";
  description =
    "Navigate a headless browser to a URL and return the page title and status. Use this to load web pages for inspection or interaction.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The URL to navigate to. If scheme is missing, https:// is assumed.",
          },
          allow_private_network: {
            type: "boolean",
            description:
              "If true, allows navigation to localhost/private-network hosts. Disabled by default for SSRF safety.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are navigating to and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["url"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserNavigate(input, context);
  }
}

registerTool(new BrowserNavigateTool());

// ── browser_snapshot ─────────────────────────────────────────────────

class BrowserSnapshotTool implements Tool {
  name = "browser_snapshot";
  description =
    'List interactive elements on the current page. Returns elements with unique IDs (e.g. "e1", "e5") that MUST be used with browser_click, browser_type, and browser_press_key. Always run this before interacting with elements — never guess or fabricate selectors.';
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are inspecting and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserSnapshot(input, context);
  }
}

registerTool(new BrowserSnapshotTool());

// ── browser_screenshot ───────────────────────────────────────────────

class BrowserScreenshotTool implements Tool {
  name = "browser_screenshot";
  description =
    "Take a visual screenshot of the current page. Returns a JPEG image.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          full_page: {
            type: "boolean",
            description:
              "Capture the full scrollable page instead of just the viewport.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are capturing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserScreenshot(input, context);
  }
}

registerTool(new BrowserScreenshotTool());

// ── browser_close ────────────────────────────────────────────────────

class BrowserCloseTool implements Tool {
  name = "browser_close";
  description =
    "Close the browser page for the current session, or all pages if close_all_pages is true.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          close_all_pages: {
            type: "boolean",
            description:
              "If true, close all browser pages and the browser context. Default: false (close only the current session page).",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserClose(input, context);
  }
}

registerTool(new BrowserCloseTool());

// ── browser_click ────────────────────────────────────────────────────

class BrowserClickTool implements Tool {
  name = "browser_click";
  description =
    "Click an element on the page. Always use element_id from browser_snapshot — do not fabricate CSS selectors. For native <select> elements, use browser_select_option instead. For autocomplete dropdowns, search suggestion lists, or address pickers, prefer browser_press_key with ArrowDown/ArrowUp + Enter instead of clicking dropdown items.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description:
              'The element ID from a previous browser_snapshot result (e.g. "e1").',
          },
          selector: {
            type: "string",
            description:
              "A CSS selector to target. Used as fallback when element_id is not available.",
          },
          timeout: {
            type: "number",
            description:
              "Max time in ms to wait for the element to be clickable (default: 10000).",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are clicking and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserClick(input, context);
  }
}

registerTool(new BrowserClickTool());

// ── browser_type ─────────────────────────────────────────────────────

class BrowserTypeTool implements Tool {
  name = "browser_type";
  description =
    "Type text into an input element. Target by element_id (from browser_snapshot) or CSS selector.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description:
              'The element ID from a previous browser_snapshot result (e.g. "e3").',
          },
          selector: {
            type: "string",
            description:
              "A CSS selector to target. Used as fallback when element_id is not available.",
          },
          text: {
            type: "string",
            description: "The text to type into the element.",
          },
          clear_first: {
            type: "boolean",
            description:
              "If true (default), clear existing content before typing. Set to false to append.",
          },
          press_enter: {
            type: "boolean",
            description: "If true, press Enter after typing the text.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are typing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["text"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserType(input, context);
  }
}

registerTool(new BrowserTypeTool());

// ── browser_press_key ────────────────────────────────────────────────

class BrowserPressKeyTool implements Tool {
  name = "browser_press_key";
  description =
    "Press a keyboard key, optionally targeting a specific element. Use for Enter, Escape, Tab, arrow keys, etc. Preferred method for navigating autocomplete dropdowns and search suggestion lists: use ArrowDown/ArrowUp to move through options, then Enter to select.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              'The key to press (e.g. "Enter", "Escape", "Tab", "ArrowDown", "a").',
          },
          element_id: {
            type: "string",
            description: "Optional element ID from browser_snapshot to target.",
          },
          selector: {
            type: "string",
            description: "Optional CSS selector to target.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["key"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserPressKey(input, context);
  }
}

registerTool(new BrowserPressKeyTool());

// ── browser_scroll ───────────────────────────────────────────────────

class BrowserScrollTool implements Tool {
  name = "browser_scroll";
  description =
    "Scroll the page or a specific element in a given direction. Useful for viewing content below the fold on long pages.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "The direction to scroll.",
          },
          amount: {
            type: "number",
            description: "The number of pixels to scroll (default: 500).",
          },
          element_id: {
            type: "string",
            description:
              "Optional element ID from browser_snapshot to scroll within.",
          },
          selector: {
            type: "string",
            description: "Optional CSS selector of element to scroll within.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are scrolling to see and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["direction"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserScroll(input, context);
  }
}

registerTool(new BrowserScrollTool());

// ── browser_select_option ────────────────────────────────────────────

class BrowserSelectOptionTool implements Tool {
  name = "browser_select_option";
  description =
    "Select an option from a native <select> element. Target by element_id (from browser_snapshot) or CSS selector. Specify the option by value, label, or index.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description:
              'The element ID of the <select> from browser_snapshot (e.g. "e4").',
          },
          selector: {
            type: "string",
            description:
              "A CSS selector for the <select> element. Used as fallback when element_id is not available.",
          },
          value: {
            type: "string",
            description: "The value attribute of the <option> to select.",
          },
          label: {
            type: "string",
            description: "The visible text of the <option> to select.",
          },
          index: {
            type: "number",
            description: "The zero-based index of the <option> to select.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are selecting and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserSelectOption(input, context);
  }
}

registerTool(new BrowserSelectOptionTool());

// ── browser_hover ────────────────────────────────────────────────────

class BrowserHoverTool implements Tool {
  name = "browser_hover";
  description =
    "Hover over an element on the page. Useful for revealing hover menus, tooltips, or dropdown content. Take a browser_snapshot after hovering to see newly revealed elements.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description:
              'The element ID from a previous browser_snapshot result (e.g. "e2").',
          },
          selector: {
            type: "string",
            description:
              "A CSS selector to target. Used as fallback when element_id is not available.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are hovering over and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserHover(input, context);
  }
}

registerTool(new BrowserHoverTool());

// ── browser_wait_for ─────────────────────────────────────────────────

class BrowserWaitForTool implements Tool {
  name = "browser_wait_for";
  description =
    "Wait for a condition: a CSS selector to appear, text to appear on the page, or a fixed duration in milliseconds. Provide exactly one mode.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "Wait for an element matching this CSS selector to appear.",
          },
          text: {
            type: "string",
            description: "Wait for this text to appear on the page.",
          },
          duration: {
            type: "number",
            description: "Wait for this many milliseconds.",
          },
          timeout: {
            type: "number",
            description:
              "Maximum wait time in milliseconds (default and max: 30000).",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are waiting for and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserWaitFor(input, context);
  }
}

registerTool(new BrowserWaitForTool());

// ── browser_extract ──────────────────────────────────────────────────

class BrowserExtractTool implements Tool {
  name = "browser_extract";
  description =
    "Extract the text content of the current page. Optionally include links. Output is capped to prevent excessive token usage.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          include_links: {
            type: "boolean",
            description:
              "If true, include a list of links found on the page (up to 200).",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are extracting and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserExtract(input, context);
  }
}

registerTool(new BrowserExtractTool());

// ── browser_fill_credential ──────────────────────────────────────────

class BrowserFillCredentialTool implements Tool {
  name = "browser_fill_credential";
  description =
    "Fill a stored credential into a form field without exposing the value. Target by element_id (from browser_snapshot) or CSS selector.";
  category = "browser";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description: "Credential vault service name (e.g. gmail)",
          },
          field: {
            type: "string",
            description: "Credential vault field name (e.g. password)",
          },
          element_id: {
            type: "string",
            description: "Element ID from browser_snapshot",
          },
          selector: {
            type: "string",
            description: "CSS selector for target element",
          },
          press_enter: {
            type: "boolean",
            description: "Press Enter after filling",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are filling in and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["service", "field"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeBrowserFillCredential(input, context);
  }
}

registerTool(new BrowserFillCredentialTool());
