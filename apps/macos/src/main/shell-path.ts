import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

import { buildInstallEnv } from "./cli-installer";

const SHELL_PATH_TIMEOUT_MS = 5_000;

// Wraps the printf'd PATH so it can be isolated from any startup-file
// output (banners, warnings) the interactive login shell writes first.
const PATH_SENTINEL = "__VELLUM_PATH_7f3a__";

export interface ShellPathResult {
  path: string;
  /**
   * False when the login shell couldn't be queried and `path` is the
   * synthesized `buildInstallEnv()` fallback — good enough for spawning
   * processes, but NOT evidence of what's on the user's real PATH.
   */
  reliable: boolean;
}

// Cached for the process lifetime; caching the promise also dedupes
// concurrent first calls into a single shell spawn.
let shellPathPromise: Promise<ShellPathResult> | null = null;

/** Reset the shell PATH cache. Exposed for testing only. */
export function _resetShellPathCache(): void {
  shellPathPromise = null;
}

function fallbackResult(): ShellPathResult {
  return { path: buildInstallEnv().PATH ?? "", reliable: false };
}

/**
 * Resolve the user's interactive login shell PATH.
 *
 * GUI apps launched from Finder inherit a minimal PATH that excludes
 * ~/.local/bin and package-manager bin dirs, so PATH checks (shadow
 * detection, "is ~/.local/bin in PATH") must use the shell's PATH rather
 * than `process.env.PATH`. Never rejects — on failure or timeout it falls
 * back to the PATH produced by `buildInstallEnv()`, marked unreliable.
 */
export function resolveShellPath(
  timeoutMs: number = SHELL_PATH_TIMEOUT_MS,
): Promise<ShellPathResult> {
  shellPathPromise ??= queryShellPath(timeoutMs);
  return shellPathPromise;
}

function queryShellPath(timeoutMs: number): Promise<ShellPathResult> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/zsh";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [
        "-ilc",
        `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" "$PATH"`,
      ]);
    } catch {
      resolve(fallbackResult());
      return;
    }

    let stdout = "";
    let settled = false;

    const settle = (value: ShellPathResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(fallbackResult());
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("error", () => settle(fallbackResult()));

    child.on("close", (code: number | null) => {
      const value = code === 0 ? extractSentinelValue(stdout) : null;
      settle(value ? { path: value, reliable: true } : fallbackResult());
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
      results.push(candidate);
    } catch {
      // Missing or not executable.
    }
  }

  return results;
}
