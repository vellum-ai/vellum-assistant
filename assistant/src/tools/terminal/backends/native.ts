import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMacOS, isLinux } from '../../../util/platform.js';
import { ToolError } from '../../../util/errors.js';
import { getLogger } from '../../../util/logger.js';
import type { SandboxBackend, SandboxResult } from './types.js';

const log = getLogger('sandbox');

const HASH_DISPLAY_LENGTH = 12;

/**
 * macOS sandbox-exec profile that restricts shell commands:
 * - Denies all by default
 * - Allows read access to most of the filesystem (needed for toolchains)
 * - Allows write access only to the working directory and temp dirs
 * - Blocks outbound network access
 * - Blocks process debugging (ptrace)
 *
 * The WORKING_DIR placeholder is replaced at runtime with the actual
 * working directory path.
 */
const SANDBOX_PROFILE = `
(version 1)
(deny default)

;; Allow read access to the filesystem (tools, libraries, etc.)
(allow file-read*)

;; Allow write access to the working directory and its children
(allow file-write*
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

;; Block network access
(deny network*)

;; Block process debugging
(deny process-info-pidinfo (target others))
`.trim();

/** Characters that are meaningful in SBPL syntax and must not appear in paths. */
const SBPL_UNSAFE = /["()\\;\n\r]/;

/**
 * Validate that a path is safe to embed in an SBPL profile string.
 * Returns true if the path contains no SBPL metacharacters.
 */
function isSafeForSBPL(path: string): boolean {
  return !SBPL_UNSAFE.test(path);
}

/**
 * Get the path to the sandbox profile file, creating it if needed.
 *
 * Each distinct working directory gets its own profile file (keyed by
 * a hash of the path) to avoid race conditions when concurrent commands
 * use different working directories.
 */
function getProfilePath(workingDir: string): string {
  const dir = join(process.env.HOME ?? '/tmp', '.vellum');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const hash = createHash('sha256').update(workingDir).digest('hex').slice(0, HASH_DISPLAY_LENGTH);
  const path = join(dir, `sandbox-profile-${hash}.sb`);

  const profile = SANDBOX_PROFILE.replace(/__WORKING_DIR__/g, workingDir);
  writeFileSync(path, profile + '\n');
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
 * Just testing `bwrap --version` is not enough — the binary may exist but
 * namespace creation can be blocked by the kernel (e.g. inside containers
 * or when user namespaces are disabled). We run a minimal sandbox that
 * exercises all namespace types used by buildBwrapArgs() (mount, network,
 * PID) to verify end-to-end functionality.
 *
 * Only positive results are cached — if bwrap is unavailable, we re-check
 * on every call so that a mid-session install is picked up immediately.
 */
function isBwrapAvailable(): boolean {
  if (bwrapAvailable) return true;
  try {
    execSync('bwrap --ro-bind / / --unshare-net --unshare-pid true', { stdio: 'ignore', timeout: 5000 });
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
 */
function buildBwrapArgs(workingDir: string, command: string): string[] {
  return [
    // Filesystem: read-only root, writable working dir and temp
    '--ro-bind', '/', '/',
    '--bind', workingDir, workingDir,
    '--bind', '/tmp', '/tmp',
    '--dev', '/dev',
    '--proc', '/proc',
    // Isolation
    '--unshare-net',
    '--unshare-pid',
    // Run bash inside the sandbox
    'bash', '-c', '--', command,
  ];
}

/**
 * Native sandbox backend using OS-level sandboxing:
 * macOS sandbox-exec (SBPL profiles) and Linux bwrap (bubblewrap).
 */
export class NativeBackend implements SandboxBackend {
  wrap(command: string, workingDir: string, _options?: import('./types.js').WrapOptions): SandboxResult {
    if (isMacOS()) {
      if (!isSafeForSBPL(workingDir)) {
        throw new ToolError(
          `Sandbox is enabled but the working directory contains characters unsafe for the sandbox profile (SBPL metacharacters). ` +
          `Refusing to execute unsandboxed. Change to a directory without special characters in its path, or disable sandboxing.`,
          'bash',
        );
      }
      const profile = getProfilePath(workingDir);
      return {
        command: 'sandbox-exec',
        args: ['-f', profile, 'bash', '-c', '--', command],
        sandboxed: true,
      };
    }

    if (isLinux()) {
      if (!isBwrapAvailable()) {
        const msg = 'Sandbox is enabled but bwrap is not available or cannot create namespaces. Refusing to execute unsandboxed. Install bubblewrap (for example: apt install bubblewrap), or disable sandboxing.';
        log.error(msg);
        throw new ToolError(msg, 'bash');
      }
      return {
        command: 'bwrap',
        args: buildBwrapArgs(workingDir, command),
        sandboxed: true,
      };
    }

    const msg = `Sandbox is enabled but not supported on this platform (${process.platform}). Refusing to execute unsandboxed. Disable sandboxing to run shell commands.`;
    log.error(msg);
    throw new ToolError(msg, 'bash');
  }
}
