/**
 * Playwright tool definitions and handlers for the Anthropic agent.
 *
 * Each tool maps to a Playwright browser action. The agent calls these tools
 * to interact with the browser during test execution.
 */

import type { Page } from "playwright";
import type Anthropic from "@anthropic-ai/sdk";

// ── Types ───────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  data?: string;
}

export interface TestResult {
  passed: boolean;
  message: string;
}

// ── Tool Definitions ────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "goto",
    description:
      "Navigate the browser to a URL. Returns the HTTP status code of the response.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an element matching the given CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "fill",
    description: "Fill an input field with the given text value.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input element",
        },
        value: {
          type: "string",
          description: "The text to fill into the input",
        },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "check",
    description: "Check a checkbox element matching the given CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the checkbox element",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "get_text",
    description:
      "Get the text content of an element matching the given CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "get_page_content",
    description: "Get the full text content of the page body.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_current_url",
    description: "Get the current page URL.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "http_request",
    description:
      "Make an HTTP request and return the response body. Useful for fetching data from APIs (e.g., verification codes).",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to request" },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "screenshot",
    description:
      "Take a screenshot of the current page. Returns the file path of the saved screenshot.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name for the screenshot file (without extension)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "report_result",
    description:
      "Report the final test result. You MUST call this exactly once when you have completed all test steps and verified all expected outcomes.",
    input_schema: {
      type: "object" as const,
      properties: {
        passed: {
          type: "boolean",
          description: "Whether the test passed",
        },
        message: {
          type: "string",
          description:
            "Explanation of why the test passed or failed, including any relevant details",
        },
      },
      required: ["passed", "message"],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────

export async function executeTool(
  page: Page,
  toolName: string,
  toolInput: Record<string, unknown>,
  screenshotDir: string,
): Promise<{ result: ToolResult; testResult?: TestResult }> {
  try {
    switch (toolName) {
      case "goto": {
        const response = await page.goto(toolInput.url as string);
        const status = response?.status() ?? 0;
        return {
          result: { success: true, data: `Navigated to ${toolInput.url} (status: ${status})` },
        };
      }

      case "click": {
        await page.click(toolInput.selector as string);
        return {
          result: { success: true, data: `Clicked element: ${toolInput.selector}` },
        };
      }

      case "fill": {
        await page.fill(toolInput.selector as string, toolInput.value as string);
        return {
          result: {
            success: true,
            data: `Filled "${toolInput.selector}" with "${toolInput.value}"`,
          },
        };
      }

      case "check": {
        await page.check(toolInput.selector as string);
        return {
          result: { success: true, data: `Checked checkbox: ${toolInput.selector}` },
        };
      }

      case "get_text": {
        const text = await page.textContent(toolInput.selector as string);
        return {
          result: { success: true, data: text ?? "" },
        };
      }

      case "get_page_content": {
        const bodyText = await page.textContent("body");
        return {
          result: { success: true, data: bodyText ?? "" },
        };
      }

      case "get_current_url": {
        return {
          result: { success: true, data: page.url() },
        };
      }

      case "http_request": {
        const method = (toolInput.method as string) ?? "GET";
        const response = await fetch(toolInput.url as string, { method });
        const body = await response.text();
        return {
          result: { success: true, data: body },
        };
      }

      case "screenshot": {
        const { mkdirSync } = await import("fs");
        mkdirSync(screenshotDir, { recursive: true });
        const filePath = `${screenshotDir}/${toolInput.name as string}.png`;
        await page.screenshot({ path: filePath });
        return {
          result: { success: true, data: `Screenshot saved to ${filePath}` },
        };
      }

      case "report_result": {
        return {
          result: { success: true, data: "Test result reported" },
          testResult: {
            passed: toolInput.passed as boolean,
            message: toolInput.message as string,
          },
        };
      }

      default:
        return {
          result: { success: false, data: `Unknown tool: ${toolName}` },
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Error executing ${toolName}: ${message}` },
    };
  }
}
