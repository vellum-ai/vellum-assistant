/**
 * Build an inline diff from an old→new string replacement.
 * Lines are prefixed with - / +.
 */
export function formatEditDiff(oldString: string, newString: string): string {
  const removed =
    oldString.length > 0 ? oldString.split("\n").map((l) => `- ${l}`) : [];
  const added =
    newString.length > 0 ? newString.split("\n").map((l) => `+ ${l}`) : [];

  return [...removed, ...added].join("\n");
}

/**
 * Build a one-line summary for a file write.
 */
export function formatWriteSummary(
  oldContent: string,
  newContent: string,
  isNewFile: boolean,
): string {
  const newLineCount = newContent.split("\n").length;
  if (isNewFile) {
    return `(new file, ${newLineCount} line${newLineCount !== 1 ? "s" : ""})`;
  }
  const oldLineCount = oldContent.split("\n").length;
  return `(${oldLineCount} → ${newLineCount} lines)`;
}
