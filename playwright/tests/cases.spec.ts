/**
 * Dynamic Playwright test collection for agent-based test cases.
 *
 * Reads markdown files from the cases/ directory and creates a Playwright
 * test for each one. This lets Playwright's built-in HTML reporter, video
 * recording, and trace viewer work out of the box for agent tests.
 */

import { type ChildProcess, execSync, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
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

// ── macOS Screen Recording ──────────────────────────────────────────

/** Log file for screen recording diagnostics. */
const RECORDING_LOG_DIR = path.resolve(__dirname, "../test-results/agent-logs");

function logRecording(testName: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [screen-recording] ${message}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(RECORDING_LOG_DIR, { recursive: true });
    const logPath = path.join(RECORDING_LOG_DIR, `${testName}-screen-recording.log`);
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.write(line);
    stream.end();
  } catch {
    // best-effort
  }
}

let _probeCompleted = false;

function probeScreenRecording(testName: string): void {
  if (_probeCompleted) return;
  _probeCompleted = true;
  // Log system info for debugging
  try {
    const swVers = execSync("sw_vers 2>&1", { encoding: "utf-8", timeout: 5_000 }).trim();
    logRecording(testName, `macOS version:\n${swVers}`);
  } catch (e) {
    logRecording(testName, `sw_vers failed: ${e}`);
  }

  // Check screencapture help to see supported flags
  try {
    const help = execSync("screencapture -h 2>&1 || true", { encoding: "utf-8", timeout: 5_000, shell: "/bin/bash" }).trim();
    logRecording(testName, `screencapture help:\n${help}`);
  } catch (e) {
    logRecording(testName, `screencapture -h failed: ${e}`);
  }

  // Check if there's a display available
  try {
    const displays = execSync("system_profiler SPDisplaysDataType 2>&1 | head -30", { encoding: "utf-8", timeout: 10_000, shell: "/bin/bash" }).trim();
    logRecording(testName, `Display info:\n${displays}`);
  } catch (e) {
    logRecording(testName, `Display info failed: ${e}`);
  }

  // Take a reference screenshot to verify the screen is capturable
  try {
    mkdirSync(RECORDING_LOG_DIR, { recursive: true });
    const refPath = path.join(RECORDING_LOG_DIR, `${testName}-pre-recording-probe.png`);
    execSync(`screencapture -x ${JSON.stringify(refPath)}`, { timeout: 10_000 });
    if (existsSync(refPath)) {
      const size = statSync(refPath).size;
      logRecording(testName, `Pre-recording screenshot probe: ${refPath} (${size} bytes)`);
    } else {
      logRecording(testName, "Pre-recording screenshot probe: file not created");
    }
  } catch (e) {
    logRecording(testName, `Pre-recording screenshot probe failed: ${e}`);
  }
}

interface ScreenRecorder {
  proc: ChildProcess;
  stderrPath: string;
  videoPath: string;
}

function startScreenRecording(videoPath: string, testName: string): ScreenRecorder | undefined {
  try {
    mkdirSync(path.dirname(videoPath), { recursive: true });

    // Capture stderr to a file so we can diagnose failures
    const stderrPath = path.join(path.dirname(videoPath), "screencapture-stderr.log");
    const stderrStream = createWriteStream(stderrPath);

    logRecording(testName, `Starting screencapture: screencapture -V 600 -x ${videoPath}`);
    logRecording(testName, `stderr will be logged to: ${stderrPath}`);

    const proc = spawn("screencapture", ["-V", "600", "-x", videoPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Pipe stdout/stderr to log files
    proc.stdout?.on("data", (chunk: Buffer) => {
      logRecording(testName, `screencapture stdout: ${chunk.toString().trim()}`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      logRecording(testName, `screencapture stderr: ${msg}`);
      stderrStream.write(chunk);
    });

    proc.on("error", (err) => {
      logRecording(testName, `screencapture spawn error: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      logRecording(testName, `screencapture exited: code=${code}, signal=${signal}`);
      stderrStream.end();
    });

    logRecording(testName, `screencapture started with PID ${proc.pid}`);

    // Check if the process is still alive after a brief delay
    setTimeout(() => {
      if (proc.exitCode !== null) {
        logRecording(testName, `screencapture exited early with code ${proc.exitCode}`);
      } else {
        logRecording(testName, "screencapture still running after 1s (good)");
      }
    }, 1000);

    proc.unref();
    return { proc, stderrPath, videoPath };
  } catch (e) {
    logRecording(testName, `startScreenRecording exception: ${e}`);
    return undefined;
  }
}

async function stopScreenRecording(recorder: ScreenRecorder | undefined, testName: string): Promise<void> {
  if (!recorder) return;
  const { proc, videoPath } = recorder;
  if (proc.killed) {
    logRecording(testName, "screencapture already killed, skipping stop");
    return;
  }

  logRecording(testName, `Stopping screencapture (PID ${proc.pid}) with SIGINT`);
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
    }, 5000);
  });

  if (exitResult.timedOut) {
    logRecording(testName, "screencapture did not exit within 5s after SIGINT, sending SIGKILL");
    proc.kill("SIGKILL");
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  } else {
    logRecording(testName, `screencapture stopped: code=${exitResult.code}, signal=${exitResult.signal}`);
  }

  // Check the output file
  if (existsSync(videoPath)) {
    const stat = statSync(videoPath);
    logRecording(testName, `Video file: ${videoPath}, size=${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    // Use ffprobe or mdls to get video metadata if available
    try {
      const mdls = execSync(`mdls -name kMDItemDurationSeconds -name kMDItemCodecs -name kMDItemPixelWidth -name kMDItemPixelHeight ${JSON.stringify(videoPath)} 2>&1`, {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
      logRecording(testName, `Video metadata (mdls):\n${mdls}`);
    } catch {
      // mdls may not be available
    }

    // Check if the video has actual content by looking at file size
    // A completely blank 75s video would still be fairly large (several MB)
    // A very small file (<100KB) likely means recording failed
    if (stat.size < 1024) {
      logRecording(testName, "WARNING: Video file is very small (<1KB), likely empty or failed");
    } else if (stat.size < 100 * 1024) {
      logRecording(testName, "WARNING: Video file is small (<100KB), may be blank or very short");
    }
  } else {
    logRecording(testName, `WARNING: Video file does not exist at ${videoPath}`);
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
    if (status === "experimental" && !process.env.RUN_EXPERIMENTAL) {
      test.skip();
      return;
    }

    checkRequiredEnv(requiredEnv);

    let fixtureCtx: FixtureContext | undefined;
    let recorder: ScreenRecorder | undefined;

    try {
      // Setup fixture if needed
      if (fixture) {
        fixtureCtx = await setupFixture(fixture, { workerIndex: testInfo.workerIndex });
      }

      // Probe screen recording capabilities (runs once across all tests)
      probeScreenRecording(testName);

      // Start macOS screen recording (captures the desktop for native app tests)
      const videoDir = path.resolve(
        __dirname,
        "../test-results/agent-videos",
        testName,
      );
      const videoPath = path.join(videoDir, "screen-recording.mov");
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

      // Attach the macOS screen recording if available
      if (stoppedVideoPath && existsSync(stoppedVideoPath)) {
        try {
          const videoSize = statSync(stoppedVideoPath).size;
          logRecording(testName, `Attaching video to report: ${stoppedVideoPath} (${videoSize} bytes)`);
          await testInfo.attach("screen-recording.mov", {
            path: stoppedVideoPath,
            contentType: "video/quicktime",
          });
        } catch (e) {
          logRecording(testName, `Failed to attach video: ${e}`);
        }
      } else {
        logRecording(testName, `Video not available for attachment (path=${stoppedVideoPath})`);
      }

      // Attach the screen recording diagnostic log
      try {
        const recLogPath = path.join(RECORDING_LOG_DIR, `${testName}-screen-recording.log`);
        if (existsSync(recLogPath)) {
          const recLogContent = readFileSync(recLogPath, "utf-8");
          await testInfo.attach("screen-recording-diagnostics", {
            body: recLogContent,
            contentType: "text/plain",
          });
        }
      } catch {
        // best-effort
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
