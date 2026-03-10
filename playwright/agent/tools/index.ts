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
import * as clickElement from "./click-element";
import * as fill from "./fill";
import * as fillSecureCredential from "./fill-secure-credential";
import * as getCurrentUrl from "./get-current-url";
import * as getPageContent from "./get-page-content";
import * as getText from "./get-text";
import * as goto from "./goto";
import * as httpRequest from "./http-request";
import * as launchApp from "./launch-app";
import * as queryAndClick from "./query-and-click";
import * as queryAndType from "./query-and-type";
import * as queryElements from "./query-elements";
import * as readChatMessages from "./read-chat-messages";
import * as reportResult from "./report-result";
import * as runShell from "./run-shell";
import * as screenshot from "./screenshot";
import * as sendChatMessage from "./send-chat-message";
import * as typeEnvVar from "./type-env-var";
import * as typeIntoElement from "./type-into-element";
import * as waitTool from "./wait";
import * as waitForElement from "./wait-for-element";
import type { ToolContext, ToolHandlerResult, ToolModule } from "./types";

export type { TestResult, ToolResult } from "./types";

// ── Tool Registry ───────────────────────────────────────────────────

const TOOLS: ToolModule[] = [
  applescriptTool,
  check,
  click,
  clickElement,
  fill,
  fillSecureCredential,
  getCurrentUrl,
  getPageContent,
  getText,
  goto,
  httpRequest,
  launchApp,
  queryAndClick,
  queryAndType,
  queryElements,
  readChatMessages,
  reportResult,
  runShell,
  screenshot,
  sendChatMessage,
  typeEnvVar,
  typeIntoElement,
  waitTool,
  waitForElement,
];

const toolsByName = new Map<string, ToolModule>(
  TOOLS.map((t) => [t.definition.name, t]),
);

const SUMMARY_PROPERTY = {
  summary: {
    type: "string",
    description:
      "A short, human-readable description of what this tool call does (e.g. 'Click Sign In button', 'Read accessibility tree', 'Wait 3s for response'). Shown in the e2e status overlay.",
  },
} as const;

export const TOOL_DEFINITIONS: Anthropic.Tool[] = TOOLS.map((t) => {
  const schema = t.definition.input_schema as { type: "object"; properties: Record<string, unknown>; required?: string[] };
  return {
    ...t.definition,
    input_schema: {
      ...schema,
      properties: { ...schema.properties, ...SUMMARY_PROPERTY },
    },
  };
});

// ── Dispatcher ──────────────────────────────────────────────────────

export function createToolExecutor(screenshotDir: string, workerIndex: number = 0, testName?: string) {
  const context: ToolContext = {
    screenshotDir,
    screenshotCounter: { value: 0 },
    testName,
    workerIndex,
  };

  return async function executeTool(
    page: Page,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ToolHandlerResult> {
    const tool = toolsByName.get(toolName);
    if (!tool) {
      return {
        result: { success: false, data: `Unknown tool: ${toolName}` },
      };
    }

    try {
      return await tool.execute(page, toolInput, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: { success: false, data: `Error executing ${toolName}: ${message}` },
      };
    }
  };
}
