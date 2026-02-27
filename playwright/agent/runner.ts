/**
 * Agent-based Playwright test runner.
 *
 * Reads markdown files from the cases/ directory, sets up required fixtures,
 * launches a browser, and runs an Anthropic agent for each test case.
 *
 * Usage:
 *   bun run agent/runner.ts [--headed] [--verbose] [case-filter]
 */

import "dotenv/config";

import { type ChildProcess, spawn } from "child_process";
import { mkdirSync, readdirSync, readFileSync } from "fs";
import path from "path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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
  durationMs: number;
}

// ── Markdown Parsing ────────────────────────────────────────────────

function parseFrontmatter(content: string): { fixture?: string; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { body: content };
  }

  const frontmatterBlock = frontmatterMatch[1];
  const body = frontmatterMatch[2];
  let fixture: string | undefined;

  for (const line of frontmatterBlock.split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key.trim() === "fixture") {
      fixture = valueParts.join(":").trim();
    }
  }

  return { fixture, body };
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

// ── Runner ──────────────────────────────────────────────────────────

/**
 * Start a macOS screen recording via `screencapture -v`.
 * Returns the child process so it can be stopped later with SIGINT.
 */
function startScreenRecording(videoPath: string): ChildProcess | undefined {
  try {
    mkdirSync(path.dirname(videoPath), { recursive: true });
    const proc = spawn("screencapture", ["-v", "-x", videoPath], {
      stdio: "ignore",
      detached: true,
    });
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

    // Start macOS screen recording (captures the actual desktop, not the browser tab)
    const videoDir = path.resolve(__dirname, "../test-results/agent-videos", testCase.name);
    const videoPath = path.join(videoDir, "screen-recording.mov");
    recorder = startScreenRecording(videoPath);

    // Run the agent
    const result = await runAgent({
      testContent,
      page,
      screenshotDir,
      verbose,
    });

    return {
      name: testCase.name,
      passed: result.passed,
      message: result.message,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: testCase.name,
      passed: false,
      message: `Runner error: ${message}`,
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

  // Launch browser
  const browser = await chromium.launch({ headless: !headed });
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

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
