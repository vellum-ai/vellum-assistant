/**
 * Minimal line-level diff utility with colored unified diff output.
 * No external dependencies.
 */

interface DiffEntry {
  type: 'same' | 'add' | 'remove';
  line: string;
}

/**
 * Compute a line-level diff using LCS (longest common subsequence).
 * O(n*m) time and space — fine for typical source files.
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffEntry[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', line: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffEntry[];
}

const CONTEXT_LINES = 3;

/**
 * Group diff entries into hunks with surrounding context lines.
 */
function buildHunks(entries: DiffEntry[]): Hunk[] {
  // Find ranges of changed lines
  const changeRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type !== 'same') {
      if (changeRanges.length > 0 && i - changeRanges[changeRanges.length - 1].end <= CONTEXT_LINES * 2) {
        // Merge with previous range if close enough
        changeRanges[changeRanges.length - 1].end = i + 1;
      } else {
        changeRanges.push({ start: i, end: i + 1 });
      }
    }
  }

  // Build hunks with context
  const hunks: Hunk[] = [];
  for (const range of changeRanges) {
    const contextStart = Math.max(0, range.start - CONTEXT_LINES);
    const contextEnd = Math.min(entries.length, range.end + CONTEXT_LINES);
    const hunkEntries = entries.slice(contextStart, contextEnd);

    // Count old/new lines for hunk header
    let oldLine = 1, newLine = 1;
    for (let i = 0; i < contextStart; i++) {
      if (entries[i].type === 'same' || entries[i].type === 'remove') oldLine++;
      if (entries[i].type === 'same' || entries[i].type === 'add') newLine++;
    }

    let oldCount = 0, newCount = 0;
    for (const entry of hunkEntries) {
      if (entry.type === 'same' || entry.type === 'remove') oldCount++;
      if (entry.type === 'same' || entry.type === 'add') newCount++;
    }

    hunks.push({
      oldStart: oldLine,
      oldCount,
      newStart: newLine,
      newCount,
      lines: hunkEntries,
    });
  }

  return hunks;
}

// ANSI color codes
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Format a colored unified diff from old and new file content.
 * Returns an empty string if the contents are identical.
 */
export function formatDiff(oldContent: string, newContent: string, filePath: string): string {
  if (oldContent === newContent) return '';

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const entries = computeLineDiff(oldLines, newLines);
  const hunks = buildHunks(entries);

  if (hunks.length === 0) return '';

  let output = `${DIM}--- a/${filePath}${RESET}\n`;
  output += `${DIM}+++ b/${filePath}${RESET}\n`;

  for (const hunk of hunks) {
    output += `${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}\n`;
    for (const entry of hunk.lines) {
      switch (entry.type) {
        case 'same':
          output += ` ${entry.line}\n`;
          break;
        case 'remove':
          output += `${RED}-${entry.line}${RESET}\n`;
          break;
        case 'add':
          output += `${GREEN}+${entry.line}${RESET}\n`;
          break;
      }
    }
  }

  return output;
}

/**
 * Format a "new file" diff (everything is added).
 * Truncates to maxLines to avoid flooding the terminal.
 */
export function formatNewFileDiff(content: string, filePath: string, maxLines = 20): string {
  const lines = content.split('\n');
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  let output = `${DIM}--- /dev/null${RESET}\n`;
  output += `${DIM}+++ b/${filePath}${RESET}\n`;
  output += `${CYAN}@@ -0,0 +1,${lines.length} @@${RESET}\n`;

  for (const line of displayLines) {
    output += `${GREEN}+${line}${RESET}\n`;
  }

  if (truncated) {
    output += `${DIM}... ${lines.length - maxLines} more lines${RESET}\n`;
  }

  return output;
}
