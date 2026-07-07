/**
 * Show the unified diff of local edits to an installed plugin, against the
 * exact commit it was installed at.
 *
 * `plugins inspect` already reports *which* files drifted via the install-time
 * per-file fingerprint (see {@link ./plugin-fingerprint}), but that digest is
 * one-way — it cannot reconstruct the original bytes, so it can't show *what*
 * changed. Drift here is classified the same way `inspect` does — against the
 * fingerprint recorded at install — so the two surfaces always agree and a
 * curated adapter overlay that changed since install never misreads as local
 * drift.
 *
 * Showing *what* changed still needs the baseline *bytes*, which the fingerprint
 * cannot reconstruct. Those are re-derived by re-materializing the recorded
 * commit (from `install-meta.json`) through the *same* pipeline install used
 * (see {@link ./install-from-github.materializePluginTree}): a shallow clone at
 * the immutable SHA plus the curated adapter overlay. The adapter overlay is
 * fetched from the canonical repo's current ref, not the install-time ref (which
 * is not recorded), so a re-materialized file can diverge from what install
 * produced. Each baseline file is therefore verified against the recorded
 * fingerprint digest before it is diffed: on a mismatch the install-time bytes
 * cannot be faithfully reconstructed, so the file is flagged rather than diffed
 * against a fabricated baseline.
 *
 * The baseline is always the recorded install commit, not the marketplace's
 * current pin: this answers "what local changes have been made since install",
 * independent of marketplace movement. Comparing against the latest pin is the
 * separate concern `plugins upgrade --dry-run` already covers.
 *
 * Designed for direct programmatic use with injected dependencies, mirroring
 * the sibling plugin libraries. The CLI command `assistant plugins diff <name>`
 * is a thin wrapper that supplies production deps and formats the result.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTwoFilesPatch } from "diff";

import { PRESERVED_ENTRIES } from "../../plugins/plugin-tree-walk.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import type { FetchLike } from "./fetch-like.js";
import {
  DEFAULT_PLUGIN_REF,
  type GitRunner,
  materializePluginTree,
  type PluginFetchSource,
  PluginNotFoundError,
  type PostinstallRunner,
  readInstallMeta,
  sanitizePluginName,
} from "./install-from-github.js";
import { readInstalledPlugin } from "./list-installed-plugins.js";
import {
  compareFingerprint,
  computeFingerprint,
  type Fingerprint,
} from "./plugin-fingerprint.js";
import { PluginNotInstalledError } from "./uninstall-plugin.js";

/** How a file drifted from the install-time baseline. */
export type PluginFileDiffStatus = "modified" | "added" | "removed";

/** Unified diff of a single drifted file. */
export interface PluginFileDiff {
  /** POSIX-relative path within the plugin root. */
  readonly path: string;
  /** Whether the file was edited, newly added, or deleted since install. */
  readonly status: PluginFileDiffStatus;
  /**
   * Unified diff (`--- a/… / +++ b/…`) of the file's bytes. For a binary file
   * this is a short `Binary files differ` marker instead of a line diff, since
   * a line-based patch of non-text content is noise. When {@link
   * PluginFileDiff.reconstructed} is false this is a short explanatory marker
   * rather than a patch, since the install-time bytes are unavailable.
   */
  readonly diff: string;
  /** True when either side was detected as binary (NUL byte present). */
  readonly binary: boolean;
  /**
   * True when the install-time baseline for this file was faithfully recovered
   * (its re-materialized bytes hash-match the digest recorded at install).
   * False when the baseline could not be reconstructed — e.g. the curated
   * adapter overlay the file was built from has changed since install — in
   * which case {@link PluginFileDiff.diff} is a marker, not a real patch.
   * Always true for `added` files, whose baseline is the empty side.
   */
  readonly reconstructed: boolean;
}

/** Resolved diff of an installed plugin against its install-time baseline. */
export interface PluginDiffResult {
  /** Install name. Matches `assistant plugins install <name>`. */
  readonly name: string;
  /** Absolute path to the installed plugin directory. */
  readonly target: string;
  /** Commit the baseline was re-materialized from (the recorded install SHA). */
  readonly commit: string;
  /** ISO-8601 committer timestamp (UTC) of {@link PluginDiffResult.commit}; `null` when unrecorded. */
  readonly committedAt: string | null;
  /** True when the on-disk tree exactly matches the re-materialized baseline. */
  readonly clean: boolean;
  /** One entry per drifted file, sorted by path. Empty when `clean`. */
  readonly files: readonly PluginFileDiff[];
}

/**
 * The installed copy carries no resolvable commit, so there is no immutable
 * baseline to re-materialize and diff against.
 */
export class PluginDiffUnavailableError extends Error {
  constructor(
    readonly pluginName: string,
    reason: string,
  ) {
    super(`Plugin "${pluginName}" cannot be diffed: ${reason}.`);
    this.name = "PluginDiffUnavailableError";
  }
}

/** Options that control which plugin to diff. */
export interface DiffPluginOptions {
  /** Install name (kebab-case directory name). */
  readonly name: string;
}

/** Dependencies injected by the caller. */
export interface DiffPluginDeps {
  /** HTTP client used to fetch any curated adapter stub. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to the live workspace. */
  readonly workspacePluginsDir?: string;
  /** Override the git runner used to clone the baseline. Forwarded to {@link materializePluginTree}. */
  readonly runGit?: GitRunner;
  /** Override the postinstall adapter runner. Forwarded to {@link materializePluginTree}. */
  readonly runPostinstall?: PostinstallRunner;
}

/** A NUL byte in the leading bytes is the heuristic git uses to flag a blob as binary. */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

interface FileContent {
  readonly text: string;
  readonly binary: boolean;
}

function readContent(absPath: string): FileContent {
  const buf = readFileSync(absPath);
  const binary = isBinary(buf);
  return { text: binary ? "" : buf.toString("utf8"), binary };
}

function makeDiff(
  path: string,
  status: PluginFileDiffStatus,
  before: FileContent | null,
  after: FileContent | null,
  reconstructed: boolean,
): PluginFileDiff {
  if (!reconstructed) {
    return {
      path,
      status,
      diff: `Baseline unavailable (${status}): the install-time content of this file could not be reconstructed — the curated adapter overlay it was built from has changed since install. Reinstall with 'plugins install <name> --force' to refresh the baseline.`,
      binary: false,
      reconstructed: false,
    };
  }
  const binary = (before?.binary ?? false) || (after?.binary ?? false);
  if (binary) {
    return {
      path,
      status,
      diff: `Binary files differ (${status})`,
      binary: true,
      reconstructed: true,
    };
  }
  // `/dev/null` on the absent side and `a/`–`b/` prefixes mirror `git diff`, so
  // the output is familiar and consumable by tools that parse unified diffs.
  const oldName = status === "added" ? "/dev/null" : `a/${path}`;
  const newName = status === "removed" ? "/dev/null" : `b/${path}`;
  const diff = createTwoFilesPatch(
    oldName,
    newName,
    before?.text ?? "",
    after?.text ?? "",
    undefined,
    undefined,
    { context: 3 },
  );
  return { path, status, diff, binary: false, reconstructed: true };
}

/**
 * Recover the install-time bytes of `path` from the re-materialized baseline
 * tree, but only when they faithfully match what install produced: the
 * re-materialized digest must equal the digest `recorded` at install. A
 * mismatch (or a file the re-materialization did not produce) means the
 * install-time content cannot be reconstructed — typically because the curated
 * adapter overlay the file was built from changed since install — so `null` is
 * returned and the caller flags the file instead of diffing fabricated bytes.
 */
function baselineContent(
  path: string,
  baselineRoot: string,
  recorded: Fingerprint,
  materialized: Fingerprint,
): FileContent | null {
  if (materialized.files[path] !== recorded.files[path]) {
    return null;
  }
  return readContent(join(baselineRoot, path));
}

/**
 * Build a per-file unified diff for the on-disk install, classifying drift
 * against the fingerprint `recorded` at install — the same baseline `inspect`
 * uses, so the two surfaces always agree on which files changed and an adapter
 * overlay that moved since install never reads as drift. The re-materialized
 * tree supplies the baseline *bytes* for the diff, verified per file against
 * `recorded`. The provenance sidecar is excluded on both sides — it never
 * exists in the baseline and must not read as a local addition.
 */
function buildFileDiffs(
  baselineRoot: string,
  target: string,
  recorded: Fingerprint,
): PluginFileDiff[] {
  const comparison = compareFingerprint(target, recorded, PRESERVED_ENTRIES);
  const materialized = computeFingerprint(baselineRoot, PRESERVED_ENTRIES);

  const files: PluginFileDiff[] = [];
  for (const path of comparison.modified) {
    const before = baselineContent(path, baselineRoot, recorded, materialized);
    files.push(
      makeDiff(
        path,
        "modified",
        before,
        readContent(join(target, path)),
        before !== null,
      ),
    );
  }
  for (const path of comparison.added) {
    files.push(
      makeDiff(path, "added", null, readContent(join(target, path)), true),
    );
  }
  for (const path of comparison.removed) {
    const before = baselineContent(path, baselineRoot, recorded, materialized);
    files.push(makeDiff(path, "removed", before, null, before !== null));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Resolve the unified diff of an installed plugin against its install-time
 * baseline.
 *
 * Throws {@link PluginNotInstalledError} when no copy is installed,
 * {@link PluginDiffUnavailableError} when the install recorded no commit to
 * re-materialize, {@link PluginNotFoundError} when the recorded commit can no
 * longer be fetched (e.g. the source repo or commit was removed), and
 * propagates {@link materializePluginTree}'s errors (e.g. source unavailable)
 * when the baseline clone itself fails.
 */
export async function diffPlugin(
  opts: DiffPluginOptions,
  deps: DiffPluginDeps,
): Promise<PluginDiffResult> {
  const name = sanitizePluginName(opts.name);
  const dir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(dir, name);

  if (!readInstalledPlugin(name, { workspacePluginsDir: dir })) {
    throw new PluginNotInstalledError(name, target);
  }

  const meta = readInstallMeta(target);
  const commit = meta?.commit ?? null;
  if (!meta || !commit) {
    throw new PluginDiffUnavailableError(
      name,
      `no install commit was recorded (an older or manually-copied install); reinstall with 'assistant plugins install ${name} --force' to record provenance`,
    );
  }
  // Drift is classified against the install-time fingerprint (as `inspect`
  // does), so without it there is no trustworthy baseline to diff against.
  const recorded = meta.fingerprint;
  if (!recorded) {
    throw new PluginDiffUnavailableError(
      name,
      `no install-time fingerprint was recorded (an older or manually-copied install); reinstall with 'assistant plugins install ${name} --force' to record provenance`,
    );
  }

  const source: PluginFetchSource = {
    owner: meta.source.owner,
    repo: meta.source.repo,
    rootPath: meta.source.path ?? "",
    ref: commit,
  };

  const baselineRoot = mkdtempSync(join(tmpdir(), `plugin-diff-${name}-`));
  try {
    const materialized = await materializePluginTree(
      { source, name, stubRef: DEFAULT_PLUGIN_REF, destDir: baselineRoot },
      {
        fetch: deps.fetch,
        runGit: deps.runGit,
        runPostinstall: deps.runPostinstall,
      },
    );
    if (materialized.fileCount === 0) {
      throw new PluginNotFoundError(
        name,
        commit,
        `${source.owner}/${source.repo}`,
      );
    }

    const files = buildFileDiffs(baselineRoot, target, recorded);
    return {
      name,
      target,
      commit,
      committedAt: meta.committedAt ?? materialized.committedAt ?? null,
      clean: files.length === 0,
      files,
    };
  } finally {
    rmSync(baselineRoot, { recursive: true, force: true });
  }
}
