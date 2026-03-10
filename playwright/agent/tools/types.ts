/**
 * Shared types for Playwright agent tools.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

export interface ToolResult {
  success: boolean;
  data?: string;
  /** Base64-encoded PNG image data (e.g. from screenshot tool). */
  imageBase64?: string;
}

export interface TestResult {
  passed: boolean;
  message: string;
  reasoning: string;
}

export interface ToolContext {
  screenshotDir: string;
  screenshotCounter: { value: number };
  /** Playwright parallel worker index (0-based). Used to isolate temp files, app instances, etc. */
  workerIndex: number;
  /** Human-readable test name. Used to derive per-test file paths (e.g. e2e status overlay). */
  testName?: string;
}

export interface ToolHandlerResult {
  result: ToolResult;
  testResult?: TestResult;
}

export interface ToolModule {
  definition: Anthropic.Tool;
  execute: (page: Page, input: Record<string, unknown>, context: ToolContext) => Promise<ToolHandlerResult>;
}
