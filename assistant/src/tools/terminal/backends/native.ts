import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ToolError } from "../../../util/errors.js";
import { getLogger } from "../../../util/logger.js";
import { isLinux, isMacOS } from "../../../util/platform.js";
import type { SandboxBackend, SandboxResult, WrapOptions } from "./types.js";

const log = getLogger("sandbox");

const HASH_DISPLAY_LENGTH = 12;

/**
 * macOS TCC-protected directories that trigger permission prompts when accessed.
 * Unconditionally denied in the SBPL sandbox profile to prevent the assistant
 * from triggering Photos, Contacts, Calendar, etc. dialogs during filesystem
 * traversal (e.g. `find ~ -name .git`).
 *
 * Paths are relative to $HOME. Includes both TCC-protected directories that
 * trigger prompts for all apps and directories like ~/Desktop and ~/Documents
 * that are TCC-protected under App Sandbox or Full Disk Access checks.
 */
export const MACOS_TCC_PROTECTED_PATHS = [
  "Desktop",
  "Documents",
  "Pictures/Photos Library.photoslibrary",
  "Library/Photos",
  "Library/Calendars",
  "Library/Reminders",
  "Library/Application Support/AddressBook",
  "Library/Messages",
  "Library/Mail",
  "Library/Safari",
  "Library/Cookies",
  "Library/HomeKit",
  "Library/IdentityServices",
  "Library/Metadata/CoreSpotlight",
  "Library/PersonalizationPortrait",
  "Library/Suggestions",
];

/**
 * Build a macOS sandbox-exec SBPL profile.
 *
 * The profile restricts shell commands:
 * - Denies all by default
 * - Allows read access to most of the filesystem (needed for toolchains)
 * - Allows write access only to the working directory and temp dirs
 * - Blocks outbound network access (unless proxied)
 * - Blocks process debugging (ptrace)
 * - Optionally blocks read access to specific protected paths (CES lockdown)
 *
 * When `allowNetwork` is true the `(deny network*)` rule is replaced with
 * `(allow network*)` so the process can reach the local credential proxy.
 */
function buildSandboxProfile(
  allowNetwork: boolean,
  denyReadPaths?: string[],
): string {
  const networkRule = allowNetwork
    ? ";; Allow network access (proxied mode - needed to reach the credential proxy)\n(allow network*)"
    : ";; Block network access\n(deny network*)";

  // Block macOS TCC-protected directories to prevent permission prompts
  // during filesystem traversal. Placed AFTER (allow file-read*) because
  // SBPL uses last-match-wins semantics.
  const home = process.env.HOME ?? "";
  const tccDenyRules = home
    ? "\n;; Block macOS TCC-protected directories to prevent permission prompts\n" +
      MACOS_TCC_PROTECTED_PATHS.map(
        (rel) =>
          `(deny file-read* (subpath "${escapeSBPL(join(home, rel))}") (with no-log))`,
      ).join("\n")
    : "";

  // Build deny-read rules for protected paths (CES shell lockdown).
  // These are placed AFTER the allow file-read* rule because SBPL uses
  // last-match-wins semantics - the more specific deny overrides the
  // general allow.
  const denyReadRules =
    denyReadPaths && denyReadPaths.length > 0
      ? "\n;; CES shell lockdown: block reads of protected credential/transport paths\n" +
        denyReadPaths
          .map(
            (p) =>
              `(deny file-read* (subpath "${escapeSBPL(p)}") (with no-log))`,
          )
          .join("\n")
      : "";

  return `
(version 1)
(deny default)

;; Allow read access to the filesystem (tools, libraries, etc.)
(allow file-read*)
${tccDenyRules}
${denyReadRules}

;; Allow write access to the working directory and its children
(allow file-write*
  (literal "/dev/null")
  (subpath "__WORKING_DIR__")
  (subpath "/private/tmp")
  (subpath "/tmp")
  (subpath "/var/folders"))

;; Allow process execution (needed to run commands)
(allow process-exec*)
(allow process-fork)

;; Allow signal delivery between parent and child
(allow signal (target others))

;; Allow sysctl reads (needed by many tools)
(allow sysctl-read)

;; Allow mach lookups (IPC, needed for basic process operation)
(allow mach-lookup)
(allow mach-register)

;; Allow IOKit (needed for some system calls)
(allow iokit-open)

${networkRule}

;; Block process debugging
(deny process-info-pidinfo (target others))
`.trim();
}

/**
 * Escape a path for safe embedding inside an SBPL quoted string.
 * Backslash-escapes characters that are meaningful in SBPL syntax.
 * Newlines/carriage returns are rejected since they cannot appear in real paths.
 */
function escapeSBPL(path: string): string {
  if (/[\n\r]/.test(path)) {
    throw new ToolError(
      "Working directory path contains newline characters, which cannot be used in a sandbox profile.",
      "bash",
    );
  }
  return path.replace(/[\\";()]/g, (ch) => `\\${ch}`);
}

/**
 * Get the path to the sandbox profile file, creating it if needed.
 *
 * Each distinct working directory gets its own profile file (keyed by
 * a hash of the path) to avoid race conditions when concurrent commands
 * use different working directories.
 */
function getProfilePath(
  workingDir: string,
  allowNetwork: boolean,
  denyReadPaths?: string[],
): string {
  const dir = join(process.env.HOME ?? "/tmp", ".vellum");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Include the network flag, deny-read paths, and HOME in the hash so
  // profiles with different configurations don't collide.
  let hashInput = allowNetwork ? `${workingDir}:proxied` : workingDir;
  if (denyReadPaths && denyReadPaths.length > 0) {
    hashInput += `:deny-read:${denyReadPaths.sort().join(",")}`;
  }
  hashInput += `:home:${process.env.HOME ?? ""}`;
  const hash = createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .slice(0, HASH_DISPLAY_LENGTH);
  const path = join(dir, `sandbox-profile-${hash}.sb`);

  const profile = buildSandboxProfile(allowNetwork, denyReadPaths).replace(
    /__WORKING_DIR__/g,
    () => escapeSBPL(workingDir),
  );
  writeFileSync(path, profile + "\n");
  return path;
}

/**
 * Cache positive bwrap results only. Negative results are not cached so that
 * installing bwrap after the daemon starts takes effect without a restart.
 */
let bwrapAvailable = false;

/**
 * Check whether bwrap is installed AND functional (can create namespaces).
 *
 * Just testing `bwrap --version` is not enough - the binary may exist but
 * namespace creation can be blocked by the kernel (e.g. inside containers
 * or when user namespaces are disabled). We run a minimal sandbox that
 * exercises all namespace types used by buildBwrapArgs() (mount, network,
 * PID) to verify end-to-end functionality.
 *
 * Only positive results are cached - if bwrap is unavailable, we re-check
 * on every call so that a mid-session install is picked up immediately.
 */
function isBwrapAvailable(): boolean {
  if (bwrapAvailable) return true;
  try {
    execSync("bwrap --ro-bind / / --unshare-net --unshare-pid true", {
      stdio: "ignore",
      timeout: 5000,
    });
    bwrapAvailable = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build bwrap arguments for Linux sandboxing.
 *
 * Strategy mirrors the macOS sandbox-exec profile:
 * - Read-only bind-mount of the root filesystem (toolchains, libs, etc.)
 * - Read-write bind-mount of the working directory
 * - Read-write tmpfs for /tmp
 * - /proc mounted for basic process operation
 * - /dev bind-mounted for device access (needed by many tools)
 * - Network access blocked (--unshare-net)
 * - PID namespace isolated (--unshare-pid)
 * - Optional tmpfs overlays on protected paths (CES lockdown)
 */
function buildBwrapArgs(
  workingDir: string,
  command: string,
  allowNetwork: boolean,
  denyReadPaths?: string[],
): string[] {
  const args = [
    // Filesystem: read-only root, writable working dir and temp
    "--ro-bind",
    "/",
    "/",
    "--bind",
    workingDir,
    workingDir,
    "--bind",
    "/tmp",
    "/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];

  // CES shell lockdown: overlay protected paths with empty tmpfs mounts
  // so the subprocess cannot read credential data, bootstrap sockets, or
  // toolstore contents. The tmpfs mount hides the real directory contents.
  if (denyReadPaths && denyReadPaths.length > 0) {
    for (const p of denyReadPaths) {
      args.push("--tmpfs", p);
    }
  }

  // Only isolate the network namespace when network access is not needed.
  // In proxied mode the process must be able to reach 127.0.0.1:<proxy-port>.
  if (!allowNetwork) {
    args.push("--unshare-net");
  }

  args.push(
    "--unshare-pid",
    // Run bash inside the sandbox
    "bash",
    "-c",
    "--",
    command,
  );

  return args;
}

/**
 * Native sandbox backend using OS-level sandboxing:
 * macOS sandbox-exec (SBPL profiles) and Linux bwrap (bubblewrap).
 */
export class NativeBackend implements SandboxBackend {
  wrap(
    command: string,
    workingDir: string,
    options?: WrapOptions,
  ): SandboxResult {
    const allowNetwork = options?.networkMode === "proxied";
    const denyReadPaths = options?.denyReadPaths;

    if (isMacOS()) {
      const profile = getProfilePath(workingDir, allowNetwork, denyReadPaths);
      return {
        command: "sandbox-exec",
        args: ["-f", profile, "bash", "-c", "--", command],
        sandboxed: true,
      };
    }

    if (isLinux()) {
      if (!isBwrapAvailable()) {
        const msg =
          "Sandbox is enabled but bwrap is not available or cannot create namespaces. Refusing to execute unsandboxed. Install bubblewrap (for example: apt install bubblewrap), or disable sandboxing.";
        log.error(msg);
        throw new ToolError(msg, "bash");
      }
      return {
        command: "bwrap",
        args: buildBwrapArgs(workingDir, command, allowNetwork, denyReadPaths),
        sandboxed: true,
      };
    }

    const msg = `Sandbox is enabled but not supported on this platform (${process.platform}). Refusing to execute unsandboxed. Disable sandboxing to run shell commands.`;
    log.error(msg);
    throw new ToolError(msg, "bash");
  }
}
