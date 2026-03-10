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

function e2eStatusFilePath(testName: string): string {
  return `/tmp/vellum-e2e-status-${testName}.json`;
}

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
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const appDir = path.resolve(__dirname, "../../../clients/macos/dist");
  const appDisplayName = process.env.APP_DISPLAY_NAME ?? "Vellum";
  const appPath = path.join(appDir, `${appDisplayName}.app`);
  const statusFile = e2eStatusFilePath(context.testName ?? "unknown");

  try {
    const envArgs = [`--env "E2E_STATUS_FILE=${statusFile}"`];
    if (process.env.VELLUM_ASSISTANT_PLATFORM_URL) {
      envArgs.push(`--env "VELLUM_ASSISTANT_PLATFORM_URL=${process.env.VELLUM_ASSISTANT_PLATFORM_URL}"`);
    }
    if (process.env.BASE_DATA_DIR) {
      envArgs.push(`--env "BASE_DATA_DIR=${process.env.BASE_DATA_DIR}"`);
    }
    execSync(
      `open -a "${appPath}" ${envArgs.join(" ")}`,
      {
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
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
