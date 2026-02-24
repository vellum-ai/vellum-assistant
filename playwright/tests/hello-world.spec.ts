import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

import { test, expect } from "@playwright/test";

const APP_DIR = path.resolve(__dirname, "../../clients/macos/dist");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME ?? "Vellum";
const LAUNCH_WAIT_MS = 8_000;
const STEP_WAIT_MS = 3_000;
const RECORDING_DIR = path.resolve(__dirname, "../test-results");
const RECORDING_PATH = path.join(RECORDING_DIR, "test-recording.mov");

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
 * Returns the hierarchy as a string.
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
 * Start a screen recording using macOS screencapture CLI.
 * Returns the child process so it can be stopped later.
 */
function startScreenRecording(outputPath: string): ChildProcess {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  return spawn("screencapture", ["-v", "-C", "-G", "3", outputPath], {
    stdio: "ignore",
    detached: true,
  });
}

function stopScreenRecording(proc: ChildProcess): void {
  // screencapture -v stops on SIGINT
  proc.kill("SIGINT");
}

let appProcess: ChildProcess | null = null;
let recordingProcess: ChildProcess | null = null;

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
  if (recordingProcess) {
    stopScreenRecording(recordingProcess);
    recordingProcess = null;
    // Give screencapture a moment to finalize the file
    await waitMs(2_000);
  }
});

test("open desktop app, select local flow, and paste Anthropic API key", async () => {
  // Start screen recording for debugging
  recordingProcess = startScreenRecording(RECORDING_PATH);
  await waitMs(1_000);

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

  // Dump accessibility tree for debugging
  console.log("=== Accessibility Tree ===");
  console.log(dumpAccessibilityTree());
  console.log("=== End Accessibility Tree ===");

  // AND click the first "Start" button (the "Own API Key" card's Start button)
  // SwiftUI nests UI elements in groups. We use `entire contents` to search
  // recursively for the first button named "Start" in the window.
  applescript(`
    tell application "System Events"
      tell process "${APP_DISPLAY_NAME}"
        set frontmost to true
        delay 1
        -- Search entire window contents for buttons named "Start"
        set startButtons to every button of entire contents of window 1 whose name is "Start"
        if (count of startButtons) > 0 then
          click item 1 of startButtons
        else
          error "No 'Start' button found in the accessibility tree"
        end if
      end tell
    end tell
  `);
  await waitMs(STEP_WAIT_MS);

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
