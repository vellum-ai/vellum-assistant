/**
 * Shared helper for invoking the ax-helper Swift CLI binary.
 *
 * The ax-helper binary provides direct macOS Accessibility API access
 * for querying UI elements, clicking, and typing — without requiring
 * the agent to compose AppleScript from scratch.
 */

import { execFileSync } from "child_process";
import path from "path";

import type { ToolContext } from "./types";

interface AXHelperResult {
  success: boolean;
  data: string;
}

function axHelperBinaryPath(): string {
  return path.resolve(__dirname, "../../ax-helper/.build/release/ax-helper");
}

export function runAXHelper(
  command: string,
  args: string[],
  context: ToolContext,
): AXHelperResult {
  const binaryPath = axHelperBinaryPath();
  const fullArgs = [command, ...args, "--worker", String(context.workerIndex)];

  try {
    const output = execFileSync(binaryPath, fullArgs, {
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    }).trim();

    const parsed = JSON.parse(output) as AXHelperResult;
    return parsed;
  } catch (error) {
    // If the binary outputs JSON on stderr or in the error, try to parse it
    if (error instanceof Error && "stdout" in error) {
      const stdout = (error as { stdout: string }).stdout?.trim();
      if (stdout) {
        try {
          return JSON.parse(stdout) as AXHelperResult;
        } catch {
          // Fall through to generic error
        }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, data: `ax-helper failed: ${message}` };
  }
}
