/**
 * Launch the desktop application.
 *
 * Resolves the app path from environment variables and launches it
 * via `open -a`. This tool encapsulates the app launch logic so that
 * markdown test cases can simply say "Launch the App".
 */

import { execSync } from "child_process";
import path from "path";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "launch_app",
  description:
    "Launch the desktop application. Resolves the app path from the environment and opens it. No parameters needed.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function execute(
  _page: Page,
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const appDir = path.resolve(__dirname, "../../../clients/macos/dist");
  const appDisplayName = process.env.APP_DISPLAY_NAME ?? "Vellum";
  const appPath = path.join(appDir, `${appDisplayName}.app`);

  try {
    execSync(`open -a "${appPath}" --args --skip-onboarding --e2e-overlay`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return {
      result: { success: true, data: `Launched ${appDisplayName} from ${appPath}` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Failed to launch app: ${message}` },
    };
  }
}
