/**
 * Installs the `assistant` command onto PATH on every daemon start.
 *
 * Skills and the agent's own bash tool invoke `assistant …` (e.g. `assistant
 * browser navigate`), and the daemon's PATH is inherited from a GUI app launch
 * that carries none of the install's bin directories. Without this the command
 * is simply missing and every such tool call exits 127.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import {
  findAssistantCommand,
  isRepoCheckoutPath,
} from "@vellumai/environments";

import { getLogger } from "../util/logger.js";

const log = getLogger("install-assistant-command");

/** Ownership marker embedded in every wrapper this module writes. */
const WRAPPER_MARKER = "# vellum-assistant-command v1";

/**
 * What to install as `assistant`:
 *   - `binary`: a compiled executable, installed as a symlink.
 *   - `bun-entry`: a script bun must interpret, installed as a wrapper that
 *     pins an absolute bun so the command works from any PATH.
 */
export type AssistantCommandTarget =
  | { kind: "binary"; binary: string }
  | { kind: "bun-entry"; bun: string; entry: string };

/** Whether `execPath` is a bun runtime rather than a compiled product binary. */
function isBunRuntime(execPath: string): boolean {
  const base = basename(execPath);
  return base === "bun" || base === "bunx" || base.startsWith("bun-");
}

/**
 * The entrypoint bun should run for `assistant` in an npm-installed runtime:
 * the command the install ships, or the assistant package's own CLI
 * entrypoint when the dependency graph omits the package declaring that bin.
 * Null for a repo checkout, where developers manage their own PATH.
 */
function resolveInstalledEntry(moduleDir: string): string | null {
  if (isRepoCheckoutPath(moduleDir)) {
    return null;
  }

  const command = findAssistantCommand(moduleDir);
  if (command !== null) {
    return command;
  }

  // `<pkg>/src/daemon` sits one level below `<pkg>/src/index.ts`.
  const packageEntry = join(moduleDir, "..", "index.ts");
  return existsSync(packageEntry) ? packageEntry : null;
}

/**
 * Resolve what `assistant` should point at, or null when this runtime layout
 * has nothing installable.
 *
 * `execPath` and `moduleDir` are overridable so the layouts can be tested
 * without a real install; both default to this process.
 */
export function resolveAssistantCommandTarget(overrides?: {
  execPath?: string;
  moduleDir?: string;
}): AssistantCommandTarget | null {
  const execPath = overrides?.execPath ?? process.execPath;
  const moduleDir = overrides?.moduleDir ?? dirname(__filename);

  // Compiled desktop build: the `assistant` binary sits beside the daemon
  // binary inside the app bundle.
  if (execPath.includes(`${sep}Contents${sep}MacOS${sep}`)) {
    const binary = join(dirname(execPath), "vellum-assistant");
    if (existsSync(binary)) {
      return { kind: "binary", binary };
    }
    log.warn(
      { expected: binary },
      "Bundled vellum-assistant binary not found alongside daemon",
    );
    return null;
  }

  // Installed npm runtime, run under bun. The entry needs an interpreter, so
  // the bun running this daemon is what the wrapper pins.
  if (!isBunRuntime(execPath)) {
    return null;
  }
  const entry = resolveInstalledEntry(moduleDir);
  return entry === null ? null : { kind: "bun-entry", bun: execPath, entry };
}

/** Single-quote a value for safe interpolation into a shell script. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function wrapperScript(bun: string, entry: string): string {
  return [
    "#!/bin/sh",
    WRAPPER_MARKER,
    "# Installed by the Vellum assistant daemon. Safe to delete.",
    `exec ${shQuote(bun)} ${shQuote(entry)} "$@"`,
    "",
  ].join("\n");
}

/** Atomically write `content` via tmp-file + rename, mode 0755. */
function writeExecutableAtomic(path: string, content: string): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content);
  chmodSync(tmpPath, 0o755);
  renameSync(tmpPath, path);
}

/**
 * Whether anything already at `commandPath` may be replaced. A symlink or a
 * wrapper this module wrote is ours; any other real file belongs to someone
 * else (a developer's own build) and is never clobbered.
 */
function claimCommandPath(commandPath: string): boolean {
  let stats;
  try {
    stats = lstatSync(commandPath);
  } catch (err) {
    // Nothing there, so this is free to create.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }

  if (stats.isSymbolicLink()) {
    return true;
  }
  if (!stats.isFile()) {
    return false;
  }
  try {
    return readFileSync(commandPath, "utf-8").includes(WRAPPER_MARKER);
  } catch {
    return false;
  }
}

/**
 * Install `target` at `commandPath`. Returns true when the command is in
 * place (including when it already was), false when the path is unusable or
 * belongs to someone else.
 */
export function installCommandAt(
  commandPath: string,
  target: AssistantCommandTarget,
): boolean {
  try {
    // Already correct? Leave it alone: this runs on every daemon start.
    try {
      const stats = lstatSync(commandPath);
      if (target.kind === "binary" && stats.isSymbolicLink()) {
        if (readlinkSync(commandPath) === target.binary) {
          return true;
        }
      } else if (target.kind === "bun-entry" && stats.isFile()) {
        if (
          readFileSync(commandPath, "utf-8") ===
          wrapperScript(target.bun, target.entry)
        ) {
          return true;
        }
      }
    } catch {
      // Missing or unreadable, so fall through to the write below.
    }

    if (!claimCommandPath(commandPath)) {
      return false;
    }

    const dir = dirname(commandPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (target.kind === "binary") {
      try {
        unlinkSync(commandPath);
      } catch {
        // Nothing to remove.
      }
      symlinkSync(target.binary, commandPath);
      return true;
    }

    writeExecutableAtomic(commandPath, wrapperScript(target.bun, target.entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * commands placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) {
    return;
  }

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    if (contents.includes(localBinDir)) {
      return;
    }
    const line = `\nexport PATH="${localBinDir}:$PATH"\n`;
    appendFileSync(profilePath, line);
    log.info(
      { profilePath, localBinDir },
      "Added ~/.local/bin to shell profile",
    );
  } catch {
    // Not critical: the user can add it manually
  }
}

/**
 * Checks whether `assistant` already resolves on PATH to something other than
 * our candidate locations. If so, we skip installing to avoid shadowing a
 * developer's local build.
 */
function commandResolvesElsewhere(
  commandName: string,
  candidatePaths: Set<string>,
): boolean {
  try {
    const resolved = execFileSync("/usr/bin/which", [commandName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return resolved !== "" && !candidatePaths.has(resolved);
  } catch {
    // `which` exited non-zero: command not found, safe to proceed
    return false;
  }
}

/**
 * Idempotent: installs (or verifies) the `assistant` command. Called on every
 * daemon startup, best-effort and self-contained: every step swallows its own
 * errors, so a failure never affects startup.
 *
 * Tries `/usr/local/bin/assistant` first, then falls back to
 * `~/.local/bin/assistant` (and patches the shell profile if needed).
 *
 * Skipped when VELLUM_DEV=1 (developers manage their own PATH).
 */
export function installAssistantCommand(): void {
  if (process.env.VELLUM_DEV === "1") {
    return;
  }

  const target = resolveAssistantCommandTarget();
  if (!target) {
    return;
  }

  const localBinDir = join(homedir(), ".local", "bin");
  const candidateDirs = ["/usr/local/bin", localBinDir];
  const candidatePaths = new Set(
    candidateDirs.map((dir) => `${dir}/assistant`),
  );

  if (commandResolvesElsewhere("assistant", candidatePaths)) {
    log.info(
      "`assistant` already resolves to a non-managed path, skipping install",
    );
    return;
  }

  for (const dir of candidateDirs) {
    const commandPath = join(dir, "assistant");
    if (installCommandAt(commandPath, target)) {
      log.info({ commandPath, target }, "Installed assistant command");
      if (dir === localBinDir) {
        ensureLocalBinInShellProfile(localBinDir);
      }
      return;
    }
    log.info(
      { commandPath },
      "Could not install assistant command at candidate, trying next",
    );
  }

  log.warn("Could not install assistant command in any candidate directory");
}
