/**
 * Dynamic Playwright test collection for agent-based test cases.
 *
 * Reads markdown files from the cases/ directory and creates a Playwright
 * test for each one. This lets Playwright's built-in HTML reporter, video
 * recording, and trace viewer work out of the box for agent tests.
 */

import { type ChildProcess, spawn } from "child_process";
import { mkdirSync, readdirSync, readFileSync } from "fs";
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

function startScreenRecording(videoPath: string): ChildProcess | undefined {
  try {
    mkdirSync(path.dirname(videoPath), { recursive: true });
    const proc = spawn("screencapture", ["-V", "600", "-x", videoPath], {
      stdio: "ignore",
      detached: true,
    });
    proc.on("error", () => {}); // ignore spawn failures (e.g., not on macOS)
    proc.unref();
    return proc;
  } catch {
    return undefined;
  }
}

async function stopScreenRecording(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill("SIGINT");
  await new Promise<void>((resolve) => {
    proc.on("exit", resolve);
    setTimeout(resolve, 3000);
  });
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
    let recorder: ChildProcess | undefined;

    try {
      // Setup fixture if needed
      if (fixture) {
        fixtureCtx = await setupFixture(fixture, { workerIndex: testInfo.workerIndex, testName });
      }

      // Start macOS screen recording (captures the desktop for native app tests)
      const videoDir = path.resolve(
        __dirname,
        "../test-results/agent-videos",
        testName,
      );
      const videoPath = path.join(videoDir, "screen-recording.mov");
      recorder = startScreenRecording(videoPath);

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
      await stopScreenRecording(recorder);
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
      try {
        await testInfo.attach("screen-recording.mov", {
          path: videoPath,
          contentType: "video/quicktime",
        });
      } catch {
        // video file may not exist or be empty
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
      await stopScreenRecording(recorder);
      if (fixtureCtx) await fixtureCtx.teardown().catch(() => {});
    }
  });
}
