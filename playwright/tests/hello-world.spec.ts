import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import path from "path";

import { test, expect } from "@playwright/test";

const APP_DIR = path.resolve(__dirname, "../../clients/macos/dist");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME ?? "Vellum";
const LAUNCH_WAIT_MS = 5_000;
const STEP_WAIT_MS = 2_000;

function applescript(script: string): string {
  return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let appProcess: ChildProcess | null = null;

test.afterEach(async () => {
  if (appProcess) {
    appProcess.kill("SIGTERM");
    appProcess = null;
  }
  try {
    execSync(
      `osascript -e 'tell application "${APP_DISPLAY_NAME}" to quit'`,
      { timeout: 5_000 },
    );
  } catch {
    // App may already be closed
  }
});

test("open desktop app, select local flow, and paste Anthropic API key", async () => {
  // GIVEN the built macOS app exists
  const appPath = path.join(APP_DIR, `${APP_DISPLAY_NAME}.app`);
  expect(existsSync(appPath)).toBe(true);

  // AND we have an Anthropic API key
  expect(ANTHROPIC_API_KEY).not.toBe("");

  // WHEN we launch the app
  appProcess = spawn("open", ["-a", appPath, "--args", "--reset-onboarding"], {
    stdio: "ignore",
    detached: true,
  });
  await waitMs(LAUNCH_WAIT_MS);

  // AND click the "Own API Key" button on the welcome screen
  applescript(
    `tell application "System Events" to tell process "${APP_DISPLAY_NAME}" to click button "Start" of group 1 of group 1 of splitter group 1 of window 1`,
  );
  await waitMs(STEP_WAIT_MS);

  // AND paste the Anthropic API key into the secure text field
  applescript(
    `tell application "System Events" to tell process "${APP_DISPLAY_NAME}" to set value of text field 1 of group 1 of group 1 of splitter group 1 of window 1 to "${ANTHROPIC_API_KEY}"`,
  );
  await waitMs(STEP_WAIT_MS);

  // THEN the API key field should contain text (non-empty)
  const fieldValue = applescript(
    `tell application "System Events" to tell process "${APP_DISPLAY_NAME}" to get value of text field 1 of group 1 of group 1 of splitter group 1 of window 1`,
  );
  expect(fieldValue.length).toBeGreaterThan(0);
});
