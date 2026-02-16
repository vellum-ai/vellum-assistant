const MAX_DIFF_LINES = 8;

/**
 * Build a compact inline diff from an old→new string replacement.
 * Lines are prefixed with - / + and truncated if the change is large.
 */
export function formatEditDiff(oldString: string, newString: string): string {
  const removed = oldString.length > 0
    ? truncateLines(oldString.split('\n'), MAX_DIFF_LINES).map(l => `- ${l}`)
    : [];
  const added = newString.length > 0
    ? truncateLines(newString.split('\n'), MAX_DIFF_LINES).map(l => `+ ${l}`)
    : [];

  return [...removed, ...added].join('\n');
}

/**
 * Build a one-line summary for a file write.
 */
export function formatWriteSummary(oldContent: string, newContent: string, isNewFile: boolean): string {
  const newLineCount = newContent.split('\n').length;
  if (isNewFile) {
    return `(new file, ${newLineCount} line${newLineCount !== 1 ? 's' : ''})`;
  }
  const oldLineCount = oldContent.split('\n').length;
  return `(${oldLineCount} → ${newLineCount} lines)`;
}

function truncateLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept.push(`... (${lines.length - max} more lines)`);
  return kept;
}
