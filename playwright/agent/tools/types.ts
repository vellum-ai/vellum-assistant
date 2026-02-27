/**
 * Shared types for Playwright agent tools.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

export interface ToolResult {
  success: boolean;
  data?: string;
}

export interface TestResult {
  passed: boolean;
  message: string;
}

export interface ToolContext {
  screenshotDir: string;
}

export interface ToolHandlerResult {
  result: ToolResult;
  testResult?: TestResult;
}

export interface ToolModule {
  definition: Anthropic.Tool;
  execute: (page: Page, input: Record<string, unknown>, context: ToolContext) => Promise<ToolHandlerResult>;
}
