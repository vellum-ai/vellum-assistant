/**
 * Playwright tool definitions and handlers for the Anthropic agent.
 *
 * Each tool is defined in its own file. This module collects them into
 * a single TOOL_DEFINITIONS array and provides a unified executeTool dispatcher.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import * as applescriptTool from "./applescript";
import * as check from "./check";
import * as click from "./click";
import * as fill from "./fill";
import * as getCurrentUrl from "./get-current-url";
import * as getPageContent from "./get-page-content";
import * as getText from "./get-text";
import * as goto from "./goto";
import * as httpRequest from "./http-request";
import * as reportResult from "./report-result";
import * as runShell from "./run-shell";
import * as screenshot from "./screenshot";
import * as waitTool from "./wait";
import type { ToolContext, ToolHandlerResult, ToolModule } from "./types";

export type { TestResult, ToolResult } from "./types";

// ── Tool Registry ───────────────────────────────────────────────────

const TOOLS: ToolModule[] = [
  applescriptTool,
  check,
  click,
  fill,
  getCurrentUrl,
  getPageContent,
  getText,
  goto,
  httpRequest,
  reportResult,
  runShell,
  screenshot,
  waitTool,
];

const toolsByName = new Map<string, ToolModule>(
  TOOLS.map((t) => [t.definition.name, t]),
);

export const TOOL_DEFINITIONS: Anthropic.Tool[] = TOOLS.map((t) => t.definition);

// ── Dispatcher ──────────────────────────────────────────────────────

export async function executeTool(
  page: Page,
  toolName: string,
  toolInput: Record<string, unknown>,
  screenshotDir: string,
): Promise<ToolHandlerResult> {
  const tool = toolsByName.get(toolName);
  if (!tool) {
    return {
      result: { success: false, data: `Unknown tool: ${toolName}` },
    };
  }

  const context: ToolContext = { screenshotDir };

  try {
    return await tool.execute(page, toolInput, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Error executing ${toolName}: ${message}` },
    };
  }
}
