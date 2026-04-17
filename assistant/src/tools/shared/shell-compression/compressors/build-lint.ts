/**
 * Compress build/lint output.
 *
 * - On success (exitCode === 0): collapse to summary with warning count.
 * - On failure: keep all error/warning lines, collapse info/note/help lines.
 */
export function compressBuildOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  const combined = stderr ? `${stderr}\n${stdout}` : stdout;
  const lines = combined.split("\n");

  if (exitCode === 0) {
    return compressSuccessOutput(lines);
  }

  return compressFailureOutput(lines);
}

function compressSuccessOutput(lines: string[]): string {
  const warnings: string[] = [];
  let lastLine = "";

  for (const line of lines) {
    if (isWarningLine(line)) {
      warnings.push(line);
    }
    if (line.trim()) {
      lastLine = line;
    }
  }

  const parts: string[] = [];
  parts.push("Build succeeded.");

  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning(s):`);
    parts.push(...warnings);
  }

  if (lastLine && !isWarningLine(lastLine) && lastLine !== "Build succeeded.") {
    parts.push(lastLine);
  }

  return parts.join("\n");
}

function compressFailureOutput(lines: string[]): string {
  const errorLines: string[] = [];
  const warningLines: string[] = [];
  let infoCount = 0;

  for (const line of lines) {
    if (isErrorLine(line) || isWarningLine(line)) {
      if (isErrorLine(line)) {
        errorLines.push(line);
      } else {
        warningLines.push(line);
      }
    } else if (isInfoLine(line)) {
      infoCount++;
    } else if (line.trim()) {
      // Keep non-categorized lines that might be stack traces or context
      errorLines.push(line);
    }
  }

  const result: string[] = [...errorLines, ...warningLines];

  if (infoCount > 0) {
    result.push(`(${infoCount} info lines omitted)`);
  }

  return result.join("\n");
}

function isErrorLine(line: string): boolean {
  return (
    /\berror\b/i.test(line) ||
    /\berror\[E/.test(line) ||
    /\berror TS\d+/.test(line) ||
    /\bERROR\b/.test(line) ||
    /^\s*\d+\s+error/.test(line)
  );
}

function isWarningLine(line: string): boolean {
  return (
    /\bwarning\b/i.test(line) ||
    /\bwarn\b/i.test(line) ||
    /\bWARN(ING)?\b/.test(line) ||
    /^\s*\d+\s+warning/.test(line)
  );
}

// `note:` and `help:` are intentionally NOT treated as info lines here.
// In Rust compiler output, `note: expected i32, found &str` and `help:
// try using a conversion method` carry the actual type-mismatch detail
// and suggested fix for the preceding error, so collapsing them would
// strip the diagnostic context the assistant needs to reason about the
// failure. They fall through to the non-categorized branch of
// compressFailureOutput and are preserved alongside the error.
function isInfoLine(line: string): boolean {
  return /\binfo\b/i.test(line) || /\bINFO\b/.test(line);
}
