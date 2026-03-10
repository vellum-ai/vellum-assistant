/**
 * Dynamic Playwright test collection for agent-based test cases.
 *
 * Reads markdown files from the cases/ directory and creates a Playwright
 * test for each one. This lets Playwright's built-in HTML reporter, trace
 * viewer, and artifact attachment work out of the box for agent tests.
 *
 * Desktop video recording uses ffmpeg (avfoundation) instead of Playwright's
 * built-in video, because Playwright records the Chromium browser tab (blank
 * for native app tests) while ffmpeg captures the actual macOS desktop.
 */

import { type ChildProcess, execSync, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import path from "path";

import { test, expect } from "@playwright/test";

import { runAgent } from "../agent/agent";
import { setupFixture, type FixtureContext } from "../agent/fixtures";

// ── Markdown Parsing ────────────────────────────────────────────────

type TestStatus = "critical" | "stable" | "experimental";

function parseFrontmatter(content: string): { fixture?: string; requiredEnv?: string[]; status?: TestStatus; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { body: content };
  }

  const frontmatterBlock = frontmatterMatch[1];
  const body = frontmatterMatch[2];
  let fixture: string | undefined;
  let requiredEnv: string[] | undefined;
  let status: TestStatus | undefined;

  for (const line of frontmatterBlock.split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key.trim() === "fixture") {
      fixture = valueParts.join(":").trim();
    } else if (key.trim() === "required_env") {
      requiredEnv = valueParts.join(":").trim().split(",").map((v) => v.trim()).filter(Boolean);
    } else if (key.trim() === "status") {
      const raw = valueParts.join(":").trim().toLowerCase();
      if (raw === "critical" || raw === "stable" || raw === "experimental") {
        status = raw;
      }
    }
  }

  return { fixture, requiredEnv, status, body };
}

function checkRequiredEnv(requiredEnv: string[] | undefined): void {
  if (!requiredEnv) return;
  const missing = requiredEnv.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

// ── macOS Desktop Recording (ffmpeg) ────────────────────────────────
//
// We use ffmpeg with the avfoundation input device to record the macOS
// desktop. Unlike `screencapture -V`, ffmpeg properly finalizes the
// output file when stopped with SIGINT (writes moov atom, etc.).
//
// `screencapture -V <seconds>` only writes the file when the timer
// expires naturally — killing it with any signal produces no output.

type LogSeverity = "warn" | "error";

function logRecording(severity: LogSeverity, testName: string, message: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [screen-recording] [${severity}] [${testName}] ${message}\n`);
}

interface ScreenRecorder {
  proc: ChildProcess;
  videoPath: string;
  logPath: string;
}

/**
 * Detect the screen capture input device index for ffmpeg's avfoundation.
 * Returns the device index string (e.g. "1") or undefined if not found.
 */
function detectScreenDevice(): string | undefined {
  try {
    // ffmpeg -f avfoundation -list_devices true -i "" prints device list to stderr
    const output = execSync(
      'ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true',
      { encoding: "utf-8", timeout: 10_000, shell: "/bin/bash" },
    );
    // Look for "Capture screen" in the video devices section
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/\[(\d+)]\s+Capture screen/);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function startScreenRecording(videoPath: string, testName: string): ScreenRecorder | undefined {
  try {
    mkdirSync(path.dirname(videoPath), { recursive: true });

    // Check if ffmpeg is available
    try {
      execSync("which ffmpeg", { timeout: 5_000 });
    } catch {
      return undefined;
    }

    // Detect the screen capture device
    const screenDevice = detectScreenDevice();
    if (!screenDevice) {
      return undefined;
    }

    const logPath = path.join(path.dirname(videoPath), "ffmpeg.log");
    const logStream = createWriteStream(logPath);

    // Record at 10fps using the detected screen device, no audio.
    // Output as WebM (VP8) for universal browser playback in Playwright HTML report.
    const args = [
      "-f", "avfoundation",
      "-framerate", "10",
      "-capture_cursor", "1",
      "-i", `${screenDevice}:none`,
      "-c:v", "libvpx",
      "-b:v", "1M",
      "-crf", "30",
      "-y",
      videoPath,
    ];

    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });

    proc.on("error", (err) => {
      logRecording("error", testName, `ffmpeg spawn error: ${err.message}`);
    });

    proc.on("exit", () => {
      logStream.end();
    });

    return { proc, videoPath, logPath };
  } catch (e) {
    logRecording("error", testName, `startScreenRecording exception: ${e}`);
    return undefined;
  }
}

async function stopScreenRecording(recorder: ScreenRecorder | undefined, testName: string): Promise<void> {
  if (!recorder) return;
  const { proc } = recorder;
  if (proc.killed || proc.exitCode !== null) {
    return;
  }

  // SIGINT causes ffmpeg to finalize the file (write moov atom) and exit cleanly
  proc.kill("SIGINT");

  const exitResult = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    let resolved = false;
    proc.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        resolve({ code, signal: signal as string | null, timedOut: false });
      }
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ code: null, signal: null, timedOut: true });
      }
    }, 10_000); // ffmpeg may need time to finalize the file
  });

  if (exitResult.timedOut) {
    logRecording("warn", testName, "ffmpeg did not exit within 10s after SIGINT, sending SIGKILL");
    proc.kill("SIGKILL");
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

// ── Test Discovery & Registration ───────────────────────────────────

const casesDir = path.resolve(__dirname, "../cases");
const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith(".md"));

for (const file of caseFiles) {
  const filePath = path.join(casesDir, file);
  const rawContent = readFileSync(filePath, "utf-8");
  const { fixture, requiredEnv, status, body } = parseFrontmatter(rawContent);
  const testName = file.replace(/\.md$/, "");

  test(testName, async ({ page }, testInfo) => {
    const testFilter = (process.env.TEST_FILTER || "stable") as TestStatus;
    const statusPriority: Record<TestStatus, number> = { critical: 0, stable: 1, experimental: 2 };
    const effectiveStatus = status ?? "stable";
    if (statusPriority[effectiveStatus] > statusPriority[testFilter]) {
      test.skip();
      return;
    }

    checkRequiredEnv(requiredEnv);

    let fixtureCtx: FixtureContext | undefined;
    let recorder: ScreenRecorder | undefined;

    try {
      // Setup fixture if needed
      if (fixture) {
        fixtureCtx = await setupFixture(fixture, { workerIndex: testInfo.workerIndex, testName });
      }

      // Start desktop screen recording via ffmpeg (captures actual macOS desktop)
      const videoDir = path.resolve(
        __dirname,
        "../test-results/agent-videos",
        testName,
      );
      const videoPath = path.join(videoDir, "screen-recording.webm");
      recorder = startScreenRecording(videoPath, testName);

      const screenshotDir = path.resolve(
        __dirname,
        "../test-results/agent-screenshots",
        testName,
      );
      const traceLogPath = path.resolve(
        __dirname,
        "../test-results/agent-logs",
        `${testName}.log`,
      );

      // Run the agent
      const result = await runAgent({
        testContent: body,
        page,
        screenshotDir,
        traceLogPath,
        verbose: !!process.env.VERBOSE,
        workerIndex: testInfo.workerIndex,
        testName,
      });

      // Stop the screen recording BEFORE attaching so the file is finalized
      await stopScreenRecording(recorder, testName);
      const stoppedVideoPath = recorder?.videoPath;
      recorder = undefined;

      // Attach the trace log to the Playwright report
      try {
        const traceContent = readFileSync(traceLogPath, "utf-8");
        await testInfo.attach("agent-trace", {
          body: traceContent,
          contentType: "text/plain",
        });
      } catch {
        // trace file may not exist
      }

      // Attach screenshots to the Playwright report
      try {
        const screenshots = readdirSync(screenshotDir).filter((f) =>
          f.endsWith(".png"),
        );
        for (const screenshot of screenshots) {
          await testInfo.attach(screenshot, {
            path: path.join(screenshotDir, screenshot),
            contentType: "image/png",
          });
        }
      } catch {
        // screenshot dir may not exist
      }

      // Attach the desktop screen recording if available
      if (stoppedVideoPath && existsSync(stoppedVideoPath)) {
        try {
          await testInfo.attach("screen-recording", {
            path: stoppedVideoPath,
            contentType: "video/webm",
          });
        } catch {
          // video file may be empty or corrupt
        }
      }

      // Attach the ffmpeg log for debugging
      if (stoppedVideoPath) {
        const ffmpegLogPath = path.join(
          path.dirname(stoppedVideoPath),
          "ffmpeg.log",
        );
        try {
          if (existsSync(ffmpegLogPath)) {
            const ffmpegLog = readFileSync(ffmpegLogPath, "utf-8");
            await testInfo.attach("ffmpeg-log", {
              body: ffmpegLog,
              contentType: "text/plain",
            });
          }
        } catch {
          // best-effort
        }
      }

      // Attach the agent's reasoning to the Playwright report
      if (result.reasoning) {
        await testInfo.attach("agent-reasoning", {
          body: result.reasoning,
          contentType: "text/plain",
        });
      }

      // Assert the agent's test result
      const failureDetails = [
        `Agent test failed: ${result.message}`,
        result.reasoning ? `\nReasoning:\n${result.reasoning}` : "",
      ].join("");
      expect(result.passed, failureDetails).toBe(true);
    } finally {
      await stopScreenRecording(recorder, testName);
      if (fixtureCtx) await fixtureCtx.teardown().catch(() => {});
    }
  });
}
