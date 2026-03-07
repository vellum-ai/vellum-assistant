/**
 * Standalone agent-based test runner (bypasses Playwright's test framework).
 *
 * Prefer `bun run test` which uses Playwright's test runner and gives
 * you the full HTML report with video recordings, traces, and screenshots.
 *
 * This standalone runner is kept for quick local iteration without Playwright
 * overhead. It reads markdown files from cases/, sets up required fixtures,
 * launches a browser, and runs an Anthropic agent for each test case.
 *
 * Usage:
 *   bun run agent/runner.ts [--headed] [--verbose] [case-filter]
 */

import "dotenv/config";

import { type ChildProcess, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Well-known paths where Google Chrome is installed on each platform.
 * Returns the first path that exists on disk, or null if none found.
 */
function findSystemChrome(): string | null {
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    );
  } else {
    // Linux
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

import { runAgent } from "./agent";
import { setupFixture, type FixtureContext } from "./fixtures";

// ── Types ───────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  filePath: string;
  fixture?: string;
  rawContent: string;
}

interface TestCaseResult {
  name: string;
  passed: boolean;
  message: string;
  reasoning: string;
  durationMs: number;
}

// ── Markdown Parsing ────────────────────────────────────────────────

type TestStatus = "critical" | "stable" | "experimental";

function parseFrontmatter(content: string): { fixture?: string; status?: TestStatus; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { body: content };
  }

  const frontmatterBlock = frontmatterMatch[1];
  const body = frontmatterMatch[2];
  let fixture: string | undefined;
  let status: TestStatus | undefined;

  for (const line of frontmatterBlock.split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key.trim() === "fixture") {
      fixture = valueParts.join(":").trim();
    } else if (key.trim() === "status") {
      const raw = valueParts.join(":").trim().toLowerCase();
      if (raw === "critical" || raw === "stable" || raw === "experimental") {
        status = raw;
      }
    }
  }

  return { fixture, status, body };
}

// ── Test Discovery ──────────────────────────────────────────────────

function discoverTestCases(casesDir: string, filter?: string): TestCase[] {
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".md"));
  const cases: TestCase[] = [];

  for (const file of files) {
    const filePath = path.join(casesDir, file);
    const rawContent = readFileSync(filePath, "utf-8");
    const { fixture } = parseFrontmatter(rawContent);
    const name = file.replace(/\.md$/, "");

    if (filter && !name.includes(filter)) {
      continue;
    }

    cases.push({ name, filePath, fixture, rawContent });
  }

  return cases;
}

// ── Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins === 0) return `${remSecs}s`;
  return `${mins}m ${remSecs}s`;
}

// ── Runner ──────────────────────────────────────────────────────────

/**
 * Start a macOS screen recording via `screencapture -v`.
 * Returns the child process so it can be stopped later with SIGINT.
 */
function startScreenRecording(videoPath: string): ChildProcess | undefined {
  try {
    mkdirSync(path.dirname(videoPath), { recursive: true });
    // Use -V 600 (10 min max) so screencapture starts recording immediately
    // instead of opening an interactive session. We stop it early with SIGINT.
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

/**
 * Stop a screen recording by sending SIGINT, which tells screencapture
 * to finalize and save the video file.
 */
async function stopScreenRecording(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill("SIGINT");
  // Wait for the process to exit so the video file is fully written
  await new Promise<void>((resolve) => {
    proc.on("exit", resolve);
    setTimeout(resolve, 3000); // fallback timeout
  });
}

async function runTestCase(
  testCase: TestCase,
  browser: Browser,
  verbose: boolean,
): Promise<TestCaseResult> {
  const startTime = Date.now();
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let fixtureCtx: FixtureContext | undefined;
  let recorder: ChildProcess | undefined;

  try {
    // Setup fixture if needed
    if (testCase.fixture) {
      fixtureCtx = await setupFixture(testCase.fixture);
    }

    // Prepare test content (no variable substitution — markdown files are static)
    const { body } = parseFrontmatter(testCase.rawContent);
    const testContent = body;

    // Create browser context (no recordVideo — it captures the blank browser
    // tab, not the macOS desktop where the native app is being tested)
    context = await browser.newContext();
    page = await context.newPage();

    const screenshotDir = path.resolve(__dirname, "../test-results/agent-screenshots", testCase.name);
    const traceLogPath = path.resolve(__dirname, "../test-results/agent-logs", `${testCase.name}.log`);

    // Start macOS screen recording (captures the actual desktop, not the browser tab)
    const videoDir = path.resolve(__dirname, "../test-results/agent-videos", testCase.name);
    const videoPath = path.join(videoDir, "screen-recording.mov");
    recorder = startScreenRecording(videoPath);

    // Run the agent (workerIndex=0 since standalone runner is single-threaded)
    const result = await runAgent({
      testContent,
      page,
      screenshotDir,
      traceLogPath,
      verbose,
      workerIndex: 0,
    });

    return {
      name: testCase.name,
      passed: result.passed,
      message: result.message,
      reasoning: result.reasoning,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: testCase.name,
      passed: false,
      message: `Runner error: ${message}`,
      reasoning: "An unexpected error occurred in the runner before the agent could report a result.",
      durationMs: Date.now() - startTime,
    };
  } finally {
    await stopScreenRecording(recorder);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (fixtureCtx) await fixtureCtx.teardown().catch(() => {});
  }
}

// ── CLI Entry Point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed");
  const verbose = args.includes("--verbose");
  const filter = args.find((a) => !a.startsWith("--"));

  const casesDir = path.resolve(__dirname, "../cases");
  const testCases = discoverTestCases(casesDir, filter);

  if (testCases.length === 0) {
    console.log("No test cases found.");
    process.exit(0);
  }

  console.log(`\nFound ${testCases.length} test case(s)${filter ? ` matching "${filter}"` : ""}:\n`);
  for (const tc of testCases) {
    console.log(`  - ${tc.name}${tc.fixture ? ` [fixture: ${tc.fixture}]` : ""}`);
  }
  console.log();

  // Launch browser — prefer system Chrome if available
  const systemChrome = findSystemChrome();
  if (systemChrome) {
    console.log(`Using system Chrome: ${systemChrome}`);
  }
  const browser = await chromium.launch({
    headless: !headed,
    ...(systemChrome ? { executablePath: systemChrome } : {}),
  });
  const results: TestCaseResult[] = [];

  try {
    for (const testCase of testCases) {
      console.log(`▶ Running: ${testCase.name}`);
      const result = await runTestCase(testCase, browser, verbose);
      results.push(result);

      const icon = result.passed ? "✓" : "✗";
      const duration = (result.durationMs / 1000).toFixed(1);
      console.log(`  ${icon} ${result.name} (${duration}s)`);
      if (!result.passed) {
        console.log(`    ${result.message}`);
        if (result.reasoning) {
          console.log(`    Reasoning: ${result.reasoning}`);
        }
      }
      console.log();
    }
  } finally {
    await browser.close();
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log("─".repeat(60));
  console.log(
    `Results: ${passed} passed, ${failed} failed (${(totalDuration / 1000).toFixed(1)}s total)`,
  );
  console.log("─".repeat(60));

  // Write JSON test report for artifact consumption
  const reportDir = path.resolve(__dirname, "../test-results");
  mkdirSync(reportDir, { recursive: true });
  const report = {
    timestamp: new Date().toISOString(),
    summary: { passed, failed, totalDurationMs: totalDuration },
    tests: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      message: r.message,
      reasoning: r.reasoning,
      durationMs: r.durationMs,
      duration: formatDuration(r.durationMs),
    })),
  };
  writeFileSync(path.join(reportDir, "test-report.json"), JSON.stringify(report, null, 2));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
