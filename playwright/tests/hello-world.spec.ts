import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

import { test, expect } from "@playwright/test";

const APP_DIR = path.resolve(__dirname, "../../clients/macos/dist");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME ?? "Vellum";
const LAUNCH_WAIT_MS = 8_000;
const STEP_WAIT_MS = 3_000;
const SCREENSHOTS_DIR = path.resolve(__dirname, "../test-results/screenshots");

/**
 * Run a multi-line AppleScript via osascript. Uses a temp file to avoid
 * shell quoting issues with single-line -e invocations.
 */
function applescript(script: string): string {
  const scriptPath = "/tmp/pw-applescript.scpt";
  writeFileSync(scriptPath, script, "utf-8");
  return execSync(`osascript ${scriptPath}`, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dump the accessibility hierarchy of the app's first window for debugging.
 */
function dumpAccessibilityTree(): string {
  try {
    return applescript(`
      tell application "System Events"
        tell process "${APP_DISPLAY_NAME}"
          return entire contents of window 1
        end tell
      end tell
    `);
  } catch (err) {
    return `Failed to dump accessibility tree: ${err}`;
  }
}

/**
 * Take a screenshot and save it to the screenshots directory.
 */
function takeScreenshot(name: string): void {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  try {
    execSync(`screencapture -x ${filePath}`, { timeout: 10_000 });
  } catch {
    // screencapture may fail on some CI configurations
  }
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

  // AND we clear any previous onboarding state
  try {
    execSync(`defaults delete com.vellum.vellum-assistant`, {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    // Domain may not exist yet on a fresh runner
  }

  // WHEN we launch the app
  appProcess = spawn("open", ["-a", appPath], {
    stdio: "ignore",
    detached: true,
  });
  await waitMs(LAUNCH_WAIT_MS);

  takeScreenshot("01-after-launch");

  // Dump accessibility tree for debugging
  console.log("=== Accessibility Tree ===");
  console.log(dumpAccessibilityTree());
  console.log("=== End Accessibility Tree ===");

  // AND click the first button in the main group (the "Own API Key" Start button)
  // From the accessibility tree dump on CI, the buttons are unnamed and located at:
  //   button 1 of group 1 of window 1  (Own API Key - Start)
  //   button 2 of group 1 of window 1  (Vellum Account - Start)
  applescript(`
    tell application "System Events"
      tell process "${APP_DISPLAY_NAME}"
        set frontmost to true
        delay 1
        click button 1 of group 1 of window 1
      end tell
    end tell
  `);
  await waitMs(STEP_WAIT_MS);

  takeScreenshot("02-after-start-click");

  // Dump tree again to see the API key step
  console.log("=== Accessibility Tree (after Start click) ===");
  console.log(dumpAccessibilityTree());
  console.log("=== End Accessibility Tree ===");

  // AND type the Anthropic API key using keystroke (SecureField doesn't
  // support `set value` via System Events, so we type it character by character)
  applescript(`
    tell application "System Events"
      tell process "${APP_DISPLAY_NAME}"
        set frontmost to true
        delay 0.5
        keystroke "${ANTHROPIC_API_KEY}"
      end tell
    end tell
  `);
  await waitMs(STEP_WAIT_MS);

  takeScreenshot("03-after-api-key-entry");

  // THEN verify the app is still running and the window is present
  const windowCount = applescript(`
    tell application "System Events"
      tell process "${APP_DISPLAY_NAME}"
        count of windows
      end tell
    end tell
  `);
  expect(parseInt(windowCount, 10)).toBeGreaterThan(0);
});
