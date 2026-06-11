import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const SHELL_PATH_TIMEOUT_MS = 5_000;

// Successful results are cached briefly so bursts within one flow share a
// spawn, while menu-driven re-checks after the user edits their shell
// profile still see fresh state. Failures (null) are never cached.
const SHELL_PATH_CACHE_TTL_MS = 30_000;

// Wraps the printf'd PATH so it can be isolated from any startup-file
// output (banners, warnings) the interactive login shell writes first.
const PATH_SENTINEL = "__VELLUM_PATH_7f3a__";

// Shells where the POSIX `printf ... "$PATH"` query is valid syntax.
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

interface CacheEntry {
  promise: Promise<string | null>;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Whether the user's login shell is fish (PATH help needs fish syntax). */
export function isFishShell(): boolean {
  return path.basename(process.env.SHELL ?? "") === "fish";
}

/** Reset the shell PATH cache. Exposed for testing only. */
export function _resetShellPathCache(): void {
  cache = null;
}

/**
 * Resolve the user's interactive login shell PATH, or null when it can't be
 * reliably determined (unknown shell, spawn failure, timeout, non-zero
 * exit, missing sentinel, implausible output).
 *
 * GUI apps launched from Finder inherit a minimal PATH that excludes
 * ~/.local/bin and package-manager bin dirs, so PATH checks (shadow
 * detection, "is ~/.local/bin in PATH") must use the shell's PATH rather
 * than `process.env.PATH`. Never rejects.
 */
export function resolveShellPath(
  timeoutMs: number = SHELL_PATH_TIMEOUT_MS,
): Promise<string | null> {
  if (cache && Date.now() < cache.expiresAt) return cache.promise;

  const entry: CacheEntry = {
    promise: queryShellPath(timeoutMs),
    // Valid while in flight so concurrent callers share one spawn; the
    // real TTL starts once the result arrives.
    expiresAt: Infinity,
  };
  cache = entry;

  void entry.promise.then((result) => {
    if (cache !== entry) return;
    if (result === null) cache = null;
    else entry.expiresAt = Date.now() + SHELL_PATH_CACHE_TTL_MS;
  });

  return entry.promise;
}

// Argv for printing a sentinel-wrapped PATH in the given shell, or null for
// shells whose syntax we don't know how to drive (tcsh, csh, nu, ...).
function shellPathArgs(shell: string): string[] | null {
  const name = path.basename(shell);
  if (name === "fish") {
    // fish's $PATH is a list that expands space-joined; join it explicitly.
    return [
      "-ilc",
      `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" (string join : $PATH)`,
    ];
  }
  if (POSIX_SHELLS.has(name)) {
    return ["-ilc", `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" "$PATH"`];
  }
  return null;
}

// A plausible PATH has at least one separator, or is a single absolute
// directory. Space-joined garbage (e.g. a misquoted list) has neither.
function isPlausiblePath(value: string): boolean {
  if (value.includes(":")) return true;
  return value.startsWith("/") && !value.includes(" ");
}

function queryShellPath(timeoutMs: number): Promise<string | null> {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const args = shellPathArgs(shell);
  if (args === null) return Promise.resolve(null);

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args);
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(null);
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("error", () => settle(null));

    child.on("close", (code: number | null) => {
      const value = code === 0 ? extractSentinelValue(stdout) : null;
      settle(value !== null && isPlausiblePath(value) ? value : null);
    });
  });
}

// Extracts the last sentinel-wrapped value; null when no complete pair.
function extractSentinelValue(stdout: string): string | null {
  const end = stdout.lastIndexOf(PATH_SENTINEL);
  if (end <= 0) return null;
  const start = stdout.lastIndexOf(PATH_SENTINEL, end - 1);
  if (start === -1) return null;
  return stdout.slice(start + PATH_SENTINEL.length, end);
}

/**
 * Split a PATH value into normalized directory entries: trailing slashes
 * stripped, empty entries skipped, duplicates removed (first wins).
 */
export function splitPathEntries(pathValue: string): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const raw of pathValue.split(":")) {
    const dir = raw.replace(/\/+$/, "");
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    entries.push(dir);
  }

  return entries;
}

/**
 * Return absolute paths of every executable named `name` on `pathValue`,
 * preserving PATH precedence order. Empty and duplicate entries are
 * skipped; non-existent or non-executable candidates are ignored.
 */
export function findExecutablesInPath(
  name: string,
  pathValue: string,
): string[] {
  const results: string[] = [];

  for (const dir of splitPathEntries(pathValue)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      // X_OK passes for directories (search bit); require a regular file.
      // statSync follows symlinks, so a link to an executable file counts.
      if (statSync(candidate).isFile()) results.push(candidate);
    } catch {
      // Missing, not executable, or unstattable.
    }
  }

  return results;
}
