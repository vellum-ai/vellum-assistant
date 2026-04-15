const LOCK_FILE_PATTERNS = [
  // Explicit lock manifest names
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^Cargo\.lock$/,
  /^Gemfile\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^composer\.lock$/,
  /^poetry\.lock$/,
  /^Pipfile\.lock$/,
  /^mix\.lock$/,
  /^flake\.lock$/,
  /^bun\.lock$/,
  // Catch-all: files ending in .lock or containing -lock. in name
  /\.lock$/i,
  /-lock\./,
];

const MAX_FILE_DIFF_CHARS = 5000;

/**
 * Check whether a file path looks like a lock file.
 */
function isLockFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return LOCK_FILE_PATTERNS.some((p) => p.test(basename));
}

/**
 * Count added and removed lines in a raw diff section.
 */
function countChanges(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/**
 * Extract the file path from a `diff --git a/... b/...` header line.
 */
function extractFilePath(header: string): string {
  const match = header.match(/^diff --git a\/(.+?) b\/(.+)/);
  return match ? match[2] : "";
}

/**
 * Reduce context lines around changed blocks from the default 3 to 1.
 *
 * Walks the hunk body line-by-line, keeping all changed lines (`+`/`-`)
 * and only 1 context line (lines starting with space) immediately before
 * and after each contiguous block of changes.
 */
function reduceContext(hunkBody: string[]): string[] {
  // Tag each line as "change" or "context"
  const isChange = hunkBody.map(
    (line) =>
      line.startsWith("+") ||
      line.startsWith("-") ||
      // "\ No newline at end of file" lines belong with the change
      line.startsWith("\\"),
  );

  const keep = new Array<boolean>(hunkBody.length).fill(false);

  for (let i = 0; i < hunkBody.length; i++) {
    if (isChange[i]) {
      keep[i] = true;
      // Keep 1 context line before
      if (i > 0 && !isChange[i - 1]) keep[i - 1] = true;
      // Keep 1 context line after
      if (i < hunkBody.length - 1 && !isChange[i + 1]) keep[i + 1] = true;
    }
  }

  return hunkBody.filter((_, i) => keep[i]);
}

/**
 * Compress a single file's diff section. Returns the compressed text.
 */
function compressFileDiff(section: string): string {
  const lines = section.split("\n");
  const headerLine = lines[0]; // diff --git ...
  const filePath = extractFilePath(headerLine);

  // Lock file: collapse to summary
  if (isLockFile(filePath)) {
    const { added, removed } = countChanges(section);
    return `${filePath}: +${added} -${removed} lines (lock file, details omitted)`;
  }

  // Binary file: keep as-is
  if (section.includes("Binary files") && section.includes("differ")) {
    return section.trimEnd();
  }

  const result: string[] = [];
  let i = 0;

  // Keep header lines (diff --git, index, ---, +++)
  while (i < lines.length && !lines[i].startsWith("@@")) {
    result.push(lines[i]);
    i++;
  }

  // Process hunks
  while (i < lines.length) {
    if (lines[i].startsWith("@@")) {
      result.push(lines[i]); // Keep @@ header
      i++;

      // Collect hunk body until next @@ or end
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith("@@")) {
        body.push(lines[i]);
        i++;
      }

      // Reduce context and append
      const reduced = reduceContext(body);
      result.push(...reduced);
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  let compressed = result.join("\n").trimEnd();

  // Large hunk truncation
  if (compressed.length > MAX_FILE_DIFF_CHARS) {
    const truncated = compressed.slice(0, MAX_FILE_DIFF_CHARS);
    // Count remaining lines
    const fullLines = compressed.split("\n").length;
    const truncatedLines = truncated.split("\n").length;
    const remaining = fullLines - truncatedLines;
    compressed = truncated + `\n... (${remaining} more lines)`;
  }

  return compressed;
}

/**
 * Compress `git diff` / `git show` output.
 *
 * - Reduces context lines from default 3 to 1 around changed blocks
 * - Collapses lock file diffs to a one-line summary
 * - Preserves binary file notices as-is
 * - Truncates large per-file diffs with a summary
 * - Passes through error output unchanged
 */
export function compressGitDiff(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  // Error case: non-zero exit, null exit (killed by signal), or stderr with
  // no exit code — return raw output so diagnostics aren't lost.
  if ((exitCode !== 0 && exitCode !== null) || (exitCode === null && stderr)) {
    return stderr ? `${stderr}\n${stdout}` : stdout;
  }

  if (!stdout.trim()) return stdout;

  // Split on `diff --git` boundaries, keeping the delimiter
  const sections = stdout.split(/^(?=diff --git )/m).filter(Boolean);

  // If no diff sections found, return as-is (e.g. commit message from git show)
  if (sections.length === 0) return stdout;

  // Check if there's preamble text before the first diff (e.g. git show commit info)
  const firstDiffIndex = stdout.indexOf("diff --git ");
  const preamble =
    firstDiffIndex > 0 ? stdout.slice(0, firstDiffIndex).trimEnd() : "";

  // Filter to only actual diff sections (skip preamble captured by the split)
  const diffSections = sections.filter((s) => s.startsWith("diff --git"));

  // No actual diff sections after filtering (e.g. git show on a merge commit
  // with no file changes, or truncated output) — return as-is.
  if (diffSections.length === 0) {
    let fallback = stdout;
    if (stderr.trim()) {
      fallback += "\n\n--- stderr ---\n" + stderr.trim();
    }
    return fallback;
  }

  const compressed = diffSections
    .map((section) => compressFileDiff(section.trimEnd()))
    .join("\n");

  let result = preamble ? preamble + "\n" + compressed : compressed;

  // Preserve stderr (e.g., git warnings) even on success
  if (stderr.trim()) {
    result += "\n\n--- stderr ---\n" + stderr.trim();
  }

  return result;
}
