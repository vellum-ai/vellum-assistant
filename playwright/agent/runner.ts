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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
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

// ── Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins === 0) return `${remSecs}s`;
  return `${mins}m ${remSecs}s`;
}

// ── HTML Report ─────────────────────────────────────────────────────

interface TestReport {
  timestamp: string;
  summary: { passed: number; failed: number; totalDurationMs: number };
  tests: { name: string; passed: boolean; message: string; durationMs: number; duration: string }[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateHtmlReport(report: TestReport): string {
  const testRows = report.tests
    .map((t) => {
      const icon = t.passed ? "✅" : "❌";
      const encodedName = encodeURIComponent(t.name);
      const screenshotLink = `agent-screenshots/${encodedName}/`;
      const videoLink = `agent-videos/${encodedName}/screen-recording.mov`;
      return `<tr>
        <td>${icon} ${escapeHtml(t.name)}</td>
        <td>${t.passed ? "passed" : "failed"}</td>
        <td>${t.duration}</td>
        <td>${t.passed ? "" : escapeHtml(t.message)}</td>
        <td><a href="${screenshotLink}">screenshots</a> · <a href="${videoLink}">video</a></td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Agent Test Report</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
    h1 { margin-bottom: 4px; }
    .summary { color: #666; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; }
    a { color: #0366d6; }
  </style>
</head>
<body>
  <h1>Agent Test Report</h1>
  <p class="summary">${report.summary.passed} passed, ${report.summary.failed} failed — ${formatDuration(report.summary.totalDurationMs)} total — ${report.timestamp}</p>
  <table>
    <tr><th>Test</th><th>Status</th><th>Duration</th><th>Details</th><th>Artifacts</th></tr>
    ${testRows}
  </table>
</body>
</html>`;
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

  // Write test report for artifact consumption
  const reportDir = path.resolve(__dirname, "../test-results");
  mkdirSync(reportDir, { recursive: true });
  const report = {
    timestamp: new Date().toISOString(),
    summary: { passed, failed, totalDurationMs: totalDuration },
    tests: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      message: r.message,
      durationMs: r.durationMs,
      duration: formatDuration(r.durationMs),
    })),
  };
  writeFileSync(path.join(reportDir, "test-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(reportDir, "index.html"), generateHtmlReport(report));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
