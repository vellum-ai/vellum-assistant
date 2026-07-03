import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { minimatch } from "minimatch";
import { RE2JS } from "re2js";

import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import {
  isDeniedBasename,
  sandboxPolicy,
} from "../shared/filesystem/path-policy.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// Directory names that are never worth searching and would otherwise dominate
// the file budget (dependencies, VCS metadata).
const IGNORED_DIRS = new Set(["node_modules", ".git"]);

// Defensive caps so a search over a huge tree cannot read the whole disk into
// memory. These bound the walk regardless of `max_results`.
const MAX_FILES_SCANNED = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB
const MAX_FILE_BYTES = 8 * 1024 * 1024; // skip files larger than 8 MiB

// Hard cap on directory entries visited during the walk, independent of
// wall-clock time. `MAX_FILES_SCANNED`/`MAX_TOTAL_BYTES` only count files that
// are actually READ, so a pathological tree full of oversized, unreadable,
// permission-denied, or glob-filtered files (which never increment those
// counters) could otherwise traverse unbounded. This bounds the readdir/stat
// work even when every individual operation is fast.
const MAX_ENTRIES_TRAVERSED = 200_000;

// Display-only cap on emitted output lines (ripgrep-style long-line bound). The
// pattern is matched against the FULL line, so a token anywhere on a long line
// is found; this cap only bounds the PRINTED line text (matched and context
// lines) so a single pathological line (e.g. a minified bundle on one line)
// can't emit a multi-megabyte output line. Normal code/log lines are well under
// the cap and print verbatim.
const MAX_DISPLAY_LINE_LENGTH = 2000;

// Output-byte budget: when `context_lines` is large and many nearby lines
// match, the surrounding block is appended for every match, so a single large
// file with many matches could allocate hundreds of MB before the post-tool
// truncation hook runs. Stop accumulating once this budget is exceeded and
// report the result as truncated.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB

// Wall-clock deadline for the whole search. The synchronous scan never yields,
// so the promise-based tool timeout / abort signal can't fire mid-scan. Checking
// this deadline (and the abort signal) once per line bounds how long a search
// over a very large tree can block the event loop and lets an external abort
// stop the walk promptly.
const MAX_SEARCH_MS = 10_000; // 10 s

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_CONTEXT_LINES = 0;
// Clamp `context_lines` so a single match cannot request unbounded surrounding
// context (which would blow past the output budget on its own).
const MAX_CONTEXT_LINES = 20;

/** Heuristic binary-file detection: a NUL byte in the leading bytes. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export const codeSearchTool = {
  name: "code_search",
  description:
    "Search file contents for a regular-expression pattern across a directory tree on your own machine, returning matching `path:line: text` lines. Read-only — never modifies files. Skips node_modules, .git, and binary files. Use this to grep across files without a shell.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regular-expression pattern to search for in file contents",
      },
      path: {
        type: "string",
        description:
          "Directory to search under (defaults to the working directory)",
      },
      glob: {
        type: "string",
        description:
          "Only search files whose path (relative to the search root) matches this glob, e.g. '*.ts' or 'src/**'",
      },
      case_insensitive: {
        type: "boolean",
        description: "Match the pattern case-insensitively",
      },
      context_lines: {
        type: "number",
        description:
          "Number of lines of context to include before and after each match (default 0)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matches to return (default 200)",
      },
      activity: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are doing and why, shown as a status update.",
      },
    },
    required: ["pattern", "activity"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const pattern = input.pattern;
    if (!pattern || typeof pattern !== "string") {
      return {
        content: "Error: pattern is required and must be a non-empty string",
        isError: true,
      };
    }

    const rawPath =
      typeof input.path === "string" && input.path.length > 0
        ? input.path
        : context.workingDir;

    const pathCheck = sandboxPolicy(rawPath, context.workingDir);
    if (!pathCheck.ok) {
      return {
        content: `Error: ${pathCheck.error}. To search outside the workspace, use the host_bash tool instead.`,
        isError: true,
      };
    }
    const root = pathCheck.resolved;

    const caseInsensitive = input.case_insensitive === true;
    // Match with the linear-time RE2 engine (via re2js) instead of V8's
    // backtracking RegExp. RE2 guarantees linear-time matching, so a
    // user/subagent-supplied pattern cannot trigger catastrophic backtracking
    // and block the synchronous scan. The trade-off is that RE2 rejects
    // backreferences and lookarounds; compile() throws on those, surfaced as a
    // clean error below.
    let regex: RE2JS;
    try {
      regex = RE2JS.compile(
        pattern,
        caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0,
      );
    } catch (err) {
      return {
        content: `Error: invalid or unsupported pattern "${pattern}": ${
          err instanceof Error ? err.message : String(err)
        }. The RE2 engine does not support backreferences or lookarounds.`,
        isError: true,
      };
    }

    const glob =
      typeof input.glob === "string" && input.glob.length > 0
        ? input.glob
        : undefined;

    const contextLines =
      typeof input.context_lines === "number" && input.context_lines > 0
        ? Math.min(Math.floor(input.context_lines), MAX_CONTEXT_LINES)
        : DEFAULT_CONTEXT_LINES;

    const maxResults =
      typeof input.max_results === "number" && input.max_results > 0
        ? Math.floor(input.max_results)
        : DEFAULT_MAX_RESULTS;

    // Validate the search root before walking so a missing/unreadable/typo'd
    // path surfaces a hard error instead of being swallowed like an unreadable
    // child directory and returning a false "No matches found". Mirrors the
    // NOT_FOUND / NOT_A_DIRECTORY reporting in file_list.
    let rootStat: import("node:fs").Stats;
    try {
      rootStat = statSync(root);
    } catch {
      return {
        content: `Error: path not found: ${rawPath}`,
        isError: true,
      };
    }

    // Start the wall-clock deadline before walking so a pathological regex
    // (or an external abort) can stop the synchronous scan mid-flight instead
    // of blocking the event loop until the whole tree is exhausted.
    const searchStart = Date.now();

    const lines: string[] = [];
    let matchCount = 0;
    let truncated = false;
    // Set when the output-byte budget (not the max-results cap) stopped the
    // accumulation, so the truncation note can explain why.
    let outputBudgetHit = false;
    // Set when the wall-clock deadline (or an abort signal) stopped the scan,
    // so the result can report that the search timed out and is incomplete —
    // distinct from the scan-cap and output-budget truncation notes.
    let timedOut = false;
    // Set when the search stopped because it reached the `max_results` cap (as
    // opposed to a scan/traversal cap). Only this cause is helped by raising
    // `max_results`, so the matched-branch truncation note keys off this flag to
    // avoid suggesting a larger `max_results` when a scan cap stopped the walk.
    let maxResultsHit = false;
    // Set when a file was skipped mid-walk because it exceeds MAX_FILE_BYTES.
    // Unlike the truncation flags this does NOT halt the walk — other files may
    // still match — but it does mark the overall result incomplete, since the
    // skipped file could have contained the pattern. Kept separate from
    // `truncated` so the zero-match invariant ("truncated => scan cap/timeout")
    // stays intact.
    let skippedLargeFile = false;
    let filesScanned = 0;
    let totalBytes = 0;
    // Number of directory entries visited during the walk (files + subdirs),
    // bounded by MAX_ENTRIES_TRAVERSED so a pathological tree can't run the
    // synchronous readdir/stat work unbounded even when no file is ever read.
    let entriesTraversed = 0;
    // Set when an EXPLICIT file root (not a child discovered mid-walk) can't be
    // read — e.g. EACCES/EPERM. A child file's read failure is optional and
    // silently skipped, but an unreadable explicit root means nothing was
    // searched, so we surface it as an error instead of a false "No matches".
    let rootReadError: string | null = null;
    // Running size of the accumulated output (lines joined by "\n") so we can
    // stop before allocating an unbounded result. Each pushed line contributes
    // its UTF-8 byte length plus one byte for the joining newline.
    let outputBytes = 0;

    // Bound a single emitted line's length for display only. Matching always
    // runs against the full line; this just keeps the PRINTED text readable and
    // prevents one pathological line (minified bundle, huge JSON/log line) from
    // emitting a multi-megabyte output line. Normal lines pass through verbatim.
    const truncateForDisplay = (text: string): string =>
      text.length > MAX_DISPLAY_LINE_LENGTH
        ? `${text.slice(0, MAX_DISPLAY_LINE_LENGTH)} …[line truncated]`
        : text;

    // Append an output line, tracking its byte cost. Returns false once the
    // output-byte budget is exhausted so callers can stop accumulating.
    const pushLine = (line: string): boolean => {
      outputBytes += Buffer.byteLength(line, "utf8") + 1;
      lines.push(line);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        outputBudgetHit = true;
        return false;
      }
      return true;
    };

    // Scan a single regular file for matches. Applies the denied-basename guard
    // and per-file size caps. Returns nothing; mutates the shared accumulators.
    const scanFile = (full: string, isExplicitRoot = false): void => {
      if (truncated) return;

      // Honor the wall-clock deadline / abort signal before doing any stat/size
      // work, not just inside the per-line loop. A tree full of oversized or
      // unreadable files (which never reach the per-line loop) could otherwise
      // run far past the advertised deadline.
      if (Date.now() - searchStart > MAX_SEARCH_MS || context.signal?.aborted) {
        truncated = true;
        timedOut = true;
        return;
      }

      // Never read files the assistant is forbidden from touching, even if a
      // broad pattern would otherwise match them. Reuses the same denylist as
      // file_read/file_write so the policies stay in sync.
      if (isDeniedBasename(full)) return;

      const rel = relative(root, full);
      // matchBase lets a slash-free pattern like "*.ts" match files at any
      // depth (against the basename); patterns with slashes match the full
      // relative path. dot so dotfiles aren't silently excluded. When the root
      // is a single file, `rel` is empty, so match against the basename.
      const globTarget = rel.length > 0 ? rel : basename(full);
      if (
        glob &&
        !minimatch(globTarget, glob, { matchBase: true, dot: true })
      ) {
        return;
      }

      if (filesScanned >= MAX_FILES_SCANNED) {
        truncated = true;
        return;
      }

      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        return;
      }
      if (size > MAX_FILE_BYTES) {
        // Skip just this file (others may still match), but record that the
        // search is incomplete so the result doesn't read as a definitive miss.
        skippedLargeFile = true;
        return;
      }
      if (totalBytes + size > MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }

      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch (err) {
        // A child file discovered mid-walk is optional — skip it silently. But
        // an explicit file root that can't be read was never searched, so record
        // the failure for the caller to surface as an error.
        if (isExplicitRoot) {
          const code = (err as NodeJS.ErrnoException)?.code;
          rootReadError = `Error: failed to read file (${code ?? "unreadable"}): ${rawPath}`;
        }
        return;
      }
      filesScanned++;
      totalBytes += buf.length;
      if (looksBinary(buf)) return;

      // Display path: when searching a single file at the root, `rel` is empty;
      // fall back to the basename so output stays readable.
      const display = rel.length > 0 ? rel : basename(full);
      const fileLines = buf.toString("utf8").split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        // Bound the total event-loop block: check the wall-clock deadline and
        // the abort signal before every regex test (the per-line Date.now() and
        // .aborted reads are negligible next to a catastrophic-backtracking
        // test). When either trips, mark the search timed out / aborted and
        // stop the whole walk so partial results are still reported.
        if (
          Date.now() - searchStart > MAX_SEARCH_MS ||
          context.signal?.aborted
        ) {
          truncated = true;
          timedOut = true;
          return;
        }
        // Match against the FULL line so a token that appears past any display
        // cap (e.g. after column 2000 on a long log/JSON/minified line) is still
        // found. RE2's linear-time matching makes this safe — there is no
        // backtracking blowup to bound, so no need to slice before matching.
        const line = fileLines[i];
        // Unanchored partial match anywhere in the line — the RE2 equivalent of
        // RegExp.prototype.test(). The compiled pattern is stateless per call.
        if (!regex.test(line)) continue;
        if (matchCount >= maxResults) {
          truncated = true;
          maxResultsHit = true;
          return;
        }
        // Count the match before emitting its lines: a single match whose output
        // alone exceeds the output-byte budget would otherwise leave matchCount
        // at 0, making the zero-match branch report a false "no matches / scan
        // cap" instead of a truncated result that acknowledges the match.
        matchCount++;
        const lineNo = i + 1;
        if (contextLines > 0) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(fileLines.length - 1, i + contextLines);
          for (let j = start; j <= end; j++) {
            const sep = j === i ? ":" : "-";
            if (
              !pushLine(
                `${display}:${j + 1}${sep} ${truncateForDisplay(fileLines[j])}`,
              )
            )
              return;
          }
          if (!pushLine("--")) return;
        } else {
          if (
            !pushLine(
              `${display}:${lineNo}: ${truncateForDisplay(fileLines[i])}`,
            )
          )
            return;
        }
      }
    };

    const walk = (dir: string, isExplicitRoot = false): void => {
      if (truncated) return;
      // Bound the traversal itself, not just file reads: a deep/wide tree of
      // directories (or many entries that never get read) could otherwise run
      // the synchronous readdir/stat work far past the advertised deadline.
      if (Date.now() - searchStart > MAX_SEARCH_MS || context.signal?.aborted) {
        truncated = true;
        timedOut = true;
        return;
      }
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // A child directory discovered mid-walk is optional — skip it silently.
        // But an explicit directory root that can't be read (e.g. EACCES/EPERM)
        // was never searched, so record the failure for the caller to surface
        // as an error instead of a false "No matches found".
        if (isExplicitRoot) {
          const code = (err as NodeJS.ErrnoException)?.code;
          rootReadError = `Error: failed to read directory (${code ?? "unreadable"}): ${rawPath}`;
        }
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        // Per-entry deadline/abort check (the Date.now()/.aborted reads are
        // negligible) plus a hard entry cap independent of wall-clock time so a
        // pathological tree is bounded even when every operation is fast.
        if (
          Date.now() - searchStart > MAX_SEARCH_MS ||
          context.signal?.aborted
        ) {
          truncated = true;
          timedOut = true;
          return;
        }
        entriesTraversed++;
        if (entriesTraversed > MAX_ENTRIES_TRAVERSED) {
          truncated = true;
          return;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        scanFile(full);
      }
    };

    if (rootStat.isDirectory()) {
      walk(root, true);
      // An explicit directory root that statSync sees but readdirSync can't read
      // (EACCES/EPERM) was never searched — surface a hard error instead of a
      // false "No matches found", mirroring the unreadable explicit-file root.
      if (rootReadError) {
        return { content: rootReadError, isError: true };
      }
    } else if (rootStat.isFile()) {
      // A regular-file root is a valid single-file search. Unlike an oversized
      // file skipped mid-walk (where other files may still match), an oversized
      // explicit root means nothing was searched at all — surface a hard error
      // instead of falling through to a false "No matches found".
      if (rootStat.size > MAX_FILE_BYTES) {
        return {
          content: `Error: file too large to search (${rootStat.size} bytes): ${rawPath}`,
          isError: true,
        };
      }
      scanFile(root, true);
      if (rootReadError) {
        return { content: rootReadError, isError: true };
      }
    } else {
      return {
        content: `Error: path not found: ${rawPath}`,
        isError: true,
      };
    }

    if (matchCount === 0) {
      // With zero matches, `truncated` can only have been set by a scan cap
      // (MAX_FILES_SCANNED / MAX_TOTAL_BYTES / MAX_ENTRIES_TRAVERSED) or the
      // wall-clock deadline, never the max-results path. In either case the tree
      // was only partially scanned, so a definitive "No matches found" would be
      // a false negative.
      if (timedOut) {
        return {
          content: `Search timed out after ${MAX_SEARCH_MS / 1000}s before finding any match for /${pattern}/${caseInsensitive ? "i" : ""} under ${basename(root)}. Results are incomplete — narrow your pattern, glob, or path and search again.`,
          isError: false,
          status: "truncated",
        };
      }
      if (truncated) {
        return {
          content: `Search stopped early after hitting a scan cap before finding any match for /${pattern}/${caseInsensitive ? "i" : ""} under ${basename(root)}. Results are incomplete — narrow your glob or path and search again.`,
          isError: false,
          status: "truncated",
        };
      }
      if (skippedLargeFile) {
        return {
          content: `No matches found for /${pattern}/${caseInsensitive ? "i" : ""} under ${basename(root)}, but one or more files were skipped because they exceed the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB per-file size limit, so results may be incomplete.`,
          isError: false,
          status: "truncated",
        };
      }
      return {
        content: `No matches found for /${pattern}/${caseInsensitive ? "i" : ""} under ${basename(root)}`,
        isError: false,
      };
    }

    let content = lines.join("\n");
    if (truncated) {
      // Distinguish the truncation cause in priority order so the note doesn't
      // mislead. Only `maxResultsHit` is helped by raising `max_results`; a
      // scan/traversal cap (MAX_FILES_SCANNED / MAX_TOTAL_BYTES /
      // MAX_ENTRIES_TRAVERSED) is not, so it gets its own note.
      if (timedOut) {
        content += `\n\n[Search timed out after ${MAX_SEARCH_MS / 1000}s. Results are incomplete. Narrow your pattern, glob, or path to see more.]`;
      } else if (outputBudgetHit) {
        content += `\n\n[Output capped at ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MiB. Narrow your pattern, glob, or path, or reduce context_lines, to see more.]`;
      } else if (maxResultsHit) {
        content += `\n\n[Results truncated at ${maxResults} matches. Narrow your pattern, glob, or path to see more.]`;
      } else {
        content += `\n\n[Search stopped early after hitting a scan/traversal cap — some files weren't searched. Narrow your glob or path (raising max_results won't help).]`;
      }
    }
    if (skippedLargeFile) {
      // Independent of the truncation reasons above: note any files skipped for
      // exceeding the per-file size limit so the result isn't read as complete.
      content += `\n\n[One or more files were skipped because they exceed the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB per-file size limit. Results may be incomplete.]`;
    }

    return {
      content,
      isError: false,
      ...(truncated || skippedLargeFile ? { status: "truncated" } : {}),
    };
  },
} satisfies ToolDefinition;

registerTool(codeSearchTool);
