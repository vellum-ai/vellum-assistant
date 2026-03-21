import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";

const log = getLogger("install-symlink");

/**
 * Resolves the path to the `vellum-assistant` binary that should be symlinked
 * as `assistant`.
 *
 * - **Bundled (desktop app):** The daemon runs from a compiled binary inside
 *   `Vellum.app/Contents/MacOS/`. `process.execPath` is the daemon binary
 *   itself — the `vellum-assistant` CLI binary lives alongside it in the same
 *   directory.
 *
 * - **Dev (bun):** `process.execPath` is the bun runtime. We resolve the
 *   assistant entrypoint relative to this file's location in the source tree
 *   and return a wrapper script path that would need bun to run — so we skip
 *   symlinking in dev mode since developers manage their own PATH.
 */
function resolveAssistantBinary(): string | null {
  // When running as a compiled bun binary, process.execPath is the binary
  // itself (not the bun runtime). We detect this by checking whether
  // process.execPath ends with a known bun path or is inside a node_modules.
  const execPath = process.execPath;
  const isBundled =
    !execPath.includes("node_modules") &&
    !execPath.endsWith("/bun") &&
    !execPath.endsWith("/node");

  if (isBundled) {
    // In the desktop app bundle, the assistant CLI binary is a sibling of the
    // daemon binary in Contents/MacOS/.
    const macosDir = dirname(execPath);
    const assistantBinary = join(macosDir, "vellum-assistant");
    if (existsSync(assistantBinary)) {
      return assistantBinary;
    }
    log.warn(
      { expected: assistantBinary },
      "Bundled vellum-assistant binary not found alongside daemon",
    );
    return null;
  }

  // Dev mode: resolve the assistant entrypoint from the source tree.
  // The daemon entry is at assistant/src/daemon/main.ts and the assistant
  // CLI entry is at assistant/src/index.ts.
  const assistantEntry = join(dirname(__filename), "..", "index.ts");
  if (existsSync(assistantEntry)) {
    return assistantEntry;
  }
  return null;
}

/**
 * Attempts to place a symlink at `symlinkPath` pointing to `target`.
 * Returns true if the symlink was created or already points to the target.
 */
function trySymlink(target: string, symlinkPath: string): boolean {
  try {
    try {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (could be a developer's local install)
        return false;
      }
      const dest = readlinkSync(symlinkPath);
      if (dest === target) return true;
      // Stale or dangling symlink — remove before creating new one
      unlinkSync(symlinkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      // Path doesn't exist — proceed to create symlink
    }

    const dir = dirname(symlinkPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(target, symlinkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * symlinks placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) return;

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    if (contents.includes(localBinDir)) return;
    const line = `\nexport PATH="${localBinDir}:$PATH"\n`;
    appendFileSync(profilePath, line);
    log.info(
      { profilePath, localBinDir },
      "Added ~/.local/bin to shell profile",
    );
  } catch {
    // Not critical — user can add it manually
  }
}

/**
 * Checks whether `assistant` already resolves on PATH to something other than
 * our candidate symlink locations. If so, we skip symlinking to avoid
 * overwriting a developer's local build.
 */
function commandResolvesElsewhere(
  commandName: string,
  candidatePaths: Set<string>,
): boolean {
  try {
    const resolved = execFileSync("/usr/bin/which", [commandName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolved !== "" && !candidatePaths.has(resolved);
  } catch {
    // `which` exited non-zero — command not found, safe to proceed
    return false;
  }
}

/**
 * Idempotent: installs (or verifies) a symlink for the `assistant` command.
 *
 * Called on every daemon startup. Handles two runtime modes:
 * - **Bundled binary** (desktop app): symlinks to the compiled
 *   `vellum-assistant` binary in the app bundle.
 * - **Bun dev mode**: symlinks to a small wrapper script that invokes
 *   `bun run` on the assistant entrypoint.
 *
 * Tries `/usr/local/bin/assistant` first, then falls back to
 * `~/.local/bin/assistant` (and patches the shell profile if needed).
 *
 * Skipped when VELLUM_DEV=1 (developers manage their own PATH).
 */
export function installAssistantSymlink(): void {
  if (process.env.VELLUM_DEV === "1") return;

  const target = resolveAssistantBinary();
  if (!target) return;

  const localBinDir = join(homedir(), ".local", "bin");
  const candidateDirs = ["/usr/local/bin", localBinDir];
  const candidatePaths = new Set(
    candidateDirs.map((dir) => `${dir}/assistant`),
  );

  if (commandResolvesElsewhere("assistant", candidatePaths)) {
    log.info(
      "`assistant` already resolves to a non-managed path — skipping symlink",
    );
    return;
  }

  for (const dir of candidateDirs) {
    const symlinkPath = join(dir, "assistant");
    if (trySymlink(target, symlinkPath)) {
      log.info({ symlinkPath, target }, "Installed assistant symlink");
      if (dir === localBinDir) {
        ensureLocalBinInShellProfile(localBinDir);
      }
      return;
    }
    log.info(
      { symlinkPath },
      "Could not install assistant symlink at candidate — trying next",
    );
  }

  log.warn("Could not install assistant symlink in any candidate directory");
}
