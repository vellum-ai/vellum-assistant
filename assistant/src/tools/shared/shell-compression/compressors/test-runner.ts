/**
 * Test-runner output compressor.
 *
 * Detects pytest, jest/vitest, cargo test, go test, and bun test output
 * formats. Preserves all failure messages, stack traces, and error output
 * verbatim while collapsing passing test lines to summary counts.
 */

// ── Compilation error patterns ─────────────────────────────────────
// If any of these appear in the combined output, we return it uncompressed
// because the developer needs the full context to diagnose build failures.
const COMPILATION_ERROR_PATTERNS = [
  /error\[E\d+\]/, // Rust compiler errors
  /SyntaxError/,
  /TypeError/,
  /cannot find module/i,
  /ReferenceError/,
  /ModuleNotFoundError/,
  /ImportError/,
  /CompileError/,
  /compile error/i,
];

function hasCompilationErrors(text: string): boolean {
  return COMPILATION_ERROR_PATTERNS.some((p) => p.test(text));
}

// ── Format detection ───────────────────────────────────────────────

function detectFormat(
  stdout: string,
): "pytest" | "jest" | "cargo" | "go" | "bun" | null {
  // pytest: look for the summary line pattern like "X passed" or "FAILURES"
  if (
    /\d+ passed/.test(stdout) &&
    (/={2,}\s*(FAILURES|ERRORS|short test summary)/.test(stdout) ||
      /={2,}\s*\d+ passed/.test(stdout))
  ) {
    return "pytest";
  }

  // jest/vitest: look for "Tests:" summary line or "Test Suites:" line
  if (/^(Tests|Test Suites):\s+/m.test(stdout)) {
    return "jest";
  }

  // cargo test: look for "test result:" summary
  if (/^test result:/m.test(stdout)) {
    return "cargo";
  }

  // bun test: look for bun-specific pass/fail summary (e.g., "X pass", "X fail")
  if (/^\s*\d+ pass$/m.test(stdout) || /bun test/i.test(stdout)) {
    return "bun";
  }

  // go test: look for "ok" or "FAIL" lines with package paths
  if (/^(ok|FAIL)\s+\S+/m.test(stdout) || /^---\s+(PASS|FAIL):/m.test(stdout)) {
    return "go";
  }

  return null;
}

// ── Pytest compressor ──────────────────────────────────────────────

function compressPytest(stdout: string): string {
  const lines = stdout.split("\n");
  const failureBlocks: string[] = [];
  let inFailureBlock = false;
  let summaryLine = "";
  let passedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of FAILURES or ERRORS section
    if (/^={2,}\s*(FAILURES|ERRORS)\s*={2,}/.test(line)) {
      inFailureBlock = true;
      failureBlocks.push(line);
      continue;
    }

    // Detect the summary line (e.g., "= 5 passed, 2 failed in 1.23s =")
    if (/^={2,}\s*.*\d+\s+(passed|failed|error)/.test(line)) {
      if (inFailureBlock) {
        // The summary line ends the failure block
        inFailureBlock = false;
      }
      summaryLine = line.replace(/^=+\s*/, "").replace(/\s*=+$/, "");
      continue;
    }

    // Detect short test summary section
    if (/^={2,}\s*short test summary/.test(line)) {
      inFailureBlock = true;
      failureBlocks.push(line);
      continue;
    }

    if (inFailureBlock) {
      failureBlocks.push(line);
      continue;
    }

    // Count PASSED lines in verbose output
    if (/PASSED/.test(line)) {
      passedCount++;
    }
  }

  // Build the summary from the pytest summary line if available
  const output: string[] = [];

  if (summaryLine) {
    output.push(summaryLine);
  } else if (passedCount > 0) {
    output.push(`${passedCount} passed`);
  }

  if (failureBlocks.length > 0) {
    output.push("");
    output.push(...failureBlocks);
  }

  return output.join("\n").trim();
}

// ── Jest / Vitest compressor ───────────────────────────────────────

function compressJest(stdout: string): string {
  const lines = stdout.split("\n");
  const failBlocks: string[] = [];
  const summaryLines: string[] = [];
  let inFailBlock = false;
  let passCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of a FAIL block
    if (/^\s*FAIL\s+/.test(line)) {
      inFailBlock = true;
      failBlocks.push(line);
      continue;
    }

    // PASS line — just count it
    if (/^\s*PASS\s+/.test(line)) {
      if (inFailBlock) {
        // A PASS line ends the previous FAIL block
        inFailBlock = false;
      }
      passCount++;
      continue;
    }

    // Summary lines (Tests:, Test Suites:, Time:, Snapshots:)
    if (/^(Tests|Test Suites|Time|Snapshots):\s+/.test(line)) {
      inFailBlock = false;
      summaryLines.push(line);
      continue;
    }

    // Lines inside a FAIL block — preserve verbatim
    if (inFailBlock) {
      failBlocks.push(line);
    }
  }

  const output: string[] = [];

  // Add summary lines first
  if (summaryLines.length > 0) {
    output.push(...summaryLines);
  }

  if (passCount > 0) {
    output.push(`${passCount} passing suites collapsed`);
  }

  if (failBlocks.length > 0) {
    output.push("");
    output.push(...failBlocks);
  }

  return output.join("\n").trim();
}

// ── Cargo test compressor ──────────────────────────────────────────

function compressCargo(stdout: string): string {
  const lines = stdout.split("\n");
  const failureLines: string[] = [];
  let summaryLine = "";
  let okCount = 0;
  let inFailureSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "failures:" header
    if (/^failures:/.test(line)) {
      inFailureSection = true;
      failureLines.push(line);
      continue;
    }

    // "test result:" summary
    if (/^test result:/.test(line)) {
      inFailureSection = false;
      summaryLine = line;
      continue;
    }

    // Lines containing FAILED or panicked
    if (/FAILED|panicked/.test(line)) {
      failureLines.push(line);
      continue;
    }

    if (inFailureSection) {
      failureLines.push(line);
      continue;
    }

    // Count passing tests (lines like "test foo::bar ... ok")
    if (/^test\s+.+\.\.\.\s+ok$/.test(line)) {
      okCount++;
    }
  }

  const output: string[] = [];

  if (summaryLine) {
    output.push(summaryLine);
  }

  if (okCount > 0) {
    output.push(`${okCount} passing tests collapsed`);
  }

  if (failureLines.length > 0) {
    output.push("");
    output.push(...failureLines);
  }

  return output.join("\n").trim();
}

// ── Go test compressor ─────────────────────────────────────────────

function compressGo(stdout: string): string {
  const lines = stdout.split("\n");
  const failBlocks: string[] = [];
  let inFailBlock = false;
  let passCount = 0;
  const packageSummaries: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- FAIL: starts a failure block
    if (/^---\s+FAIL:/.test(line)) {
      inFailBlock = true;
      failBlocks.push(line);
      continue;
    }

    // --- PASS: just count
    if (/^---\s+PASS:/.test(line)) {
      inFailBlock = false;
      passCount++;
      continue;
    }

    // Package-level FAIL line (e.g., "FAIL github.com/foo/bar 0.123s")
    if (/^FAIL\s+\S+/.test(line)) {
      inFailBlock = false;
      packageSummaries.push(line);
      continue;
    }

    // Package-level ok line (e.g., "ok github.com/foo/bar 0.123s")
    if (/^ok\s+\S+/.test(line)) {
      inFailBlock = false;
      packageSummaries.push(line);
      continue;
    }

    if (inFailBlock) {
      failBlocks.push(line);
    }
  }

  const output: string[] = [];

  if (passCount > 0) {
    output.push(`${passCount} passing tests collapsed`);
  }

  if (packageSummaries.length > 0) {
    output.push(...packageSummaries);
  }

  if (failBlocks.length > 0) {
    output.push("");
    output.push(...failBlocks);
  }

  return output.join("\n").trim();
}

// ── Bun test compressor ────────────────────────────────────────────

function compressBun(stdout: string): string {
  const lines = stdout.split("\n");
  const failBlocks: string[] = [];
  let inFailBlock = false;
  let passCount = 0;
  const summaryLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Failure indicator lines
    if (/^\s*✗/.test(line) || /^\s*fail\b/i.test(line)) {
      inFailBlock = true;
      failBlocks.push(line);
      continue;
    }

    // Pass indicator — count it
    if (/^\s*✓/.test(line) || /^\s*pass\b/i.test(line)) {
      inFailBlock = false;
      passCount++;
      continue;
    }

    // Summary lines (e.g., "42 pass", "1 fail", timing)
    if (/^\s*\d+\s+(pass|fail|skip|expect)/i.test(line)) {
      inFailBlock = false;
      summaryLines.push(line);
      continue;
    }

    if (inFailBlock) {
      failBlocks.push(line);
    }
  }

  const output: string[] = [];

  if (summaryLines.length > 0) {
    output.push(...summaryLines);
  }

  if (passCount > 0) {
    output.push(`${passCount} passing tests collapsed`);
  }

  if (failBlocks.length > 0) {
    output.push("");
    output.push(...failBlocks);
  }

  return output.join("\n").trim();
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Compress test runner output, preserving all failure details while
 * collapsing passing test lines to summary counts.
 *
 * Supports pytest, jest/vitest, cargo test, go test, and bun test formats.
 *
 * If compilation errors are detected, the full output is returned uncompressed
 * since the developer needs full context to diagnose build failures.
 */
export function compressTestOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  const combined = stdout + "\n" + stderr;

  // Compilation errors pass through uncompressed
  if (hasCompilationErrors(combined)) {
    return combined.trim();
  }

  const format = detectFormat(stdout);

  // If we can't detect a format, return everything
  if (!format) {
    return combined.trim();
  }

  let compressed: string;

  switch (format) {
    case "pytest":
      compressed = compressPytest(stdout);
      break;
    case "jest":
      compressed = compressJest(stdout);
      break;
    case "cargo":
      compressed = compressCargo(stdout);
      break;
    case "go":
      compressed = compressGo(stdout);
      break;
    case "bun":
      compressed = compressBun(stdout);
      break;
  }

  // If exit code is non-zero, preserve stderr verbatim
  if (exitCode !== 0 && exitCode !== null && stderr.trim()) {
    compressed = compressed + "\n\n--- stderr ---\n" + stderr.trim();
  }

  return compressed.trim();
}
