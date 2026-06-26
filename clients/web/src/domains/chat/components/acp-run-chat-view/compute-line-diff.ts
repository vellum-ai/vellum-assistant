/**
 * Dependency-free line-level diff for the ACP file-diff view.
 *
 * Splits both sides on `\n` and runs an LCS to classify each line as added,
 * removed, or unchanged context. Pure — no third-party deps, no I/O.
 */

export type DiffRowType = "add" | "del" | "ctx" | "too-large";

export interface DiffRow {
  type: DiffRowType;
  text: string;
  /** 1-based line number in `oldText`, present for `del` and `ctx` rows. */
  oldNo?: number;
  /** 1-based line number in `newText`, present for `add` and `ctx` rows. */
  newNo?: number;
}

/**
 * Above this many lines on either side we skip the O(n·m) LCS and emit a
 * single sentinel row so huge inputs don't lock up the renderer.
 */
const MAX_DIFF_LINES = 2000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // Drop only the empty segment the trailing newline terminator produces, so a
  // normal `"a\n"` file is one line, not two. Real blank lines (e.g. `"a\n\n"`)
  // are preserved because the split yields a non-terminator empty line too.
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Longest-common-subsequence backtrace over two line arrays, producing the
 * classic add/del/ctx row sequence.
 */
function lcsDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = LCS length of oldLines[i:] and newLines[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "ctx", text: oldLines[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: oldLines[i], oldNo: i + 1 });
      i++;
    } else {
      rows.push({ type: "add", text: newLines[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < m) {
    rows.push({ type: "del", text: oldLines[i], oldNo: i + 1 });
    i++;
  }
  while (j < n) {
    rows.push({ type: "add", text: newLines[j], newNo: j + 1 });
    j++;
  }
  return rows;
}

export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [
      {
        type: "too-large",
        text: `Diff too large to render (over ${MAX_DIFF_LINES.toLocaleString()} lines)`,
      },
    ];
  }

  // New file: nothing on the left, every line is an addition.
  if (oldLines.length === 0) {
    return newLines.map((text, idx) => ({ type: "add", text, newNo: idx + 1 }));
  }
  // Deleted file: nothing on the right, every line is a removal.
  if (newLines.length === 0) {
    return oldLines.map((text, idx) => ({ type: "del", text, oldNo: idx + 1 }));
  }

  return lcsDiff(oldLines, newLines);
}
