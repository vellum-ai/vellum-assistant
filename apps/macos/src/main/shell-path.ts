import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

import { buildInstallEnv } from "./cli-installer";

const SHELL_PATH_TIMEOUT_MS = 5_000;

// Cached for the process lifetime; caching the promise also dedupes
// concurrent first calls into a single shell spawn.
let shellPathPromise: Promise<string> | null = null;

/** Reset the shell PATH cache. Exposed for testing only. */
export function _resetShellPathCache(): void {
  shellPathPromise = null;
}

function fallbackPath(): string {
  return buildInstallEnv().PATH ?? "";
}

/**
 * Resolve the user's interactive login shell PATH.
 *
 * GUI apps launched from Finder inherit a minimal PATH that excludes
 * ~/.local/bin and package-manager bin dirs, so PATH checks (shadow
 * detection, "is ~/.local/bin in PATH") must use the shell's PATH rather
 * than `process.env.PATH`. Never rejects — on failure or timeout it falls
 * back to the PATH produced by `buildInstallEnv()`.
 */
export function resolveShellPath(
  timeoutMs: number = SHELL_PATH_TIMEOUT_MS,
): Promise<string> {
  shellPathPromise ??= queryShellPath(timeoutMs);
  return shellPathPromise;
}

function queryShellPath(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/zsh";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", 'printf "%s" "$PATH"']);
    } catch {
      resolve(fallbackPath());
      return;
    }

    let stdout = "";
    let settled = false;

    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(fallbackPath());
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("error", () => settle(fallbackPath()));

    child.on("close", (code: number | null) => {
      const value = stdout.trim();
      settle(code === 0 && value ? value : fallbackPath());
    });
  });
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
  const seen = new Set<string>();

  for (const dir of pathValue.split(":")) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);

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
