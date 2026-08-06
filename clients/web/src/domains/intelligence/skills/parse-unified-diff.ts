/**
 * Parse the unified diff a skill revision carries into per-file rows the
 * revision history can render.
 *
 * The daemon returns one combined `git show` diff per revision, scoped to the
 * skill's directory, so a single string may describe several files. Rendering
 * needs them split by file (each with its own header) and each line tagged with
 * the old/new line numbers from its hunk header.
 *
 * The sibling diff utilities in the app compute a diff from two texts
 * (`compute-line-diff.ts`, `inspector/cache-diff.ts`); this one reads a diff
 * that already exists, which is why it parses rather than diffs.
 */

/** A single rendered line of a diff. */
export interface DiffRow {
  type: "add" | "del" | "ctx" | "meta";
  text: string;
  /** Line number in the pre-change file, when the row exists there. */
  oldNo?: number;
  /** Line number in the post-change file, when the row exists there. */
  newNo?: number;
}

/** The rows belonging to one file within a revision's combined diff. */
export interface DiffFile {
  /** Path relative to the skill directory, e.g. `references/owners.md`. */
  path: string;
  rows: DiffRow[];
  added: number;
  removed: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  added: number;
  removed: number;
}

/** `@@ -12,7 +12,9 @@`, capturing the two starting line numbers. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * `diff --git a/<path> b/<path>` for the common case where both sides name the
 * same file. The backreference is what makes a path containing spaces
 * recoverable: splitting on whitespace cannot tell `a/my file.md b/my file.md`
 * apart from four separate tokens.
 */
const DIFF_GIT_SAME_PATH = /^diff --git a\/(.+) b\/\1$/;

/**
 * Strip the `a/`/`b/` diff prefix and the `skills/<id>/` directory so a file
 * reads the way the revision's `files` list spells it. A path that doesn't sit
 * under the expected directory is left alone rather than mangled.
 */
function toSkillRelativePath(rawPath: string, skillId: string): string {
  const withoutDiffPrefix = rawPath.replace(/^[ab]\//, "");
  const skillPrefix = `skills/${skillId}/`;
  return withoutDiffPrefix.startsWith(skillPrefix)
    ? withoutDiffPrefix.slice(skillPrefix.length)
    : withoutDiffPrefix;
}

/**
 * Path from a `--- a/<path>` or `+++ b/<path>` header, which runs to the end of
 * the line and so survives spaces. Git appends a tab to these when the path
 * contains one. Returns null for the `/dev/null` side of an add or delete.
 */
function pathFromFileHeader(line: string): string | null {
  const raw = line.slice(4).replace(/\t$/, "");
  return raw === "/dev/null" ? null : raw;
}

/**
 * Split a revision's combined unified diff into per-file row lists.
 *
 * Returns no files for an empty or unrecognisable diff. Callers render that
 * as "no preview" rather than treating it as an error, since the diff is
 * presentational and a revision row still stands on its date and file list.
 */
export function parseUnifiedDiff(diff: string, skillId: string): ParsedDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  // File metadata only ever appears BEFORE the first hunk header. Inside a
  // hunk every line is content prefixed with a marker, so a deleted line whose
  // own text begins with `--` arrives as `--- ...` and a added one beginning
  // with `++` as `+++ ...`. Matching those against the header prefixes would
  // drop real content rows and, because a dropped row never advances its side's
  // counter, desynchronise every line number after it.
  let inHunk = false;
  // Whether the b-side path has been taken for the current file, so a later
  // a-side header cannot overwrite it.
  let seenNewPath = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Provisional: a rename has two different paths and no backreference
      // match, so fall back to the last whitespace token. The `+++`/`---`
      // headers below correct both cases before any row is rendered.
      const samePath = DIFF_GIT_SAME_PATH.exec(line);
      const rawPath =
        samePath?.[1] ?? (line.split(" ").slice(3).join(" ") || "");
      current = {
        path: toSkillRelativePath(rawPath, skillId),
        rows: [],
        added: 0,
        removed: 0,
      };
      files.push(current);
      oldNo = 0;
      newNo = 0;
      inHunk = false;
      seenNewPath = false;
      continue;
    }

    if (!current) {
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      // Hunk boundaries matter visually once a file has more than one; the
      // gap between them is not contiguous text.
      if (current.rows.length > 0) {
        current.rows.push({ type: "meta", text: line });
      }
      continue;
    }

    // A "no newline at end of file" marker can appear inside a hunk, but it is
    // notation rather than content, so it is dropped wherever it occurs.
    if (line.startsWith("\\ No newline")) {
      continue;
    }

    // The `---`/`+++` headers carry the authoritative path: it runs to the end
    // of the line, so unlike the `diff --git` line it is unambiguous when the
    // path contains spaces. Prefer the b-side, falling back to the a-side for
    // a deletion, where the b-side is `/dev/null`.
    if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) {
      const headerPath = pathFromFileHeader(line);
      if (headerPath !== null && (line.startsWith("+++ ") || !seenNewPath)) {
        current.path = toSkillRelativePath(headerPath, skillId);
        seenNewPath = line.startsWith("+++ ");
      }
      continue;
    }

    // Everything between the `diff --git` line and the first hunk is file
    // metadata (index, mode) that the header already conveys.
    if (
      !inHunk &&
      (line.startsWith("index ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("Binary files "))
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      current.rows.push({ type: "add", text: line.slice(1), newNo });
      current.added += 1;
      newNo += 1;
    } else if (line.startsWith("-")) {
      current.rows.push({ type: "del", text: line.slice(1), oldNo });
      current.removed += 1;
      oldNo += 1;
    } else if (line.startsWith(" ")) {
      current.rows.push({ type: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
    // A trailing empty string from the final newline falls through here.
  }

  return {
    files,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
  };
}
