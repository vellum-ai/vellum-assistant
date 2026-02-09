import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMacOS, isLinux } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('sandbox');

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
  const hash = createHash('sha256').update(workingDir).digest('hex').slice(0, 12);
  const path = join(dir, `sandbox-profile-${hash}.sb`);

  const profile = SANDBOX_PROFILE.replace(/__WORKING_DIR__/g, workingDir);
  writeFileSync(path, profile + '\n');
  return path;
}

/** Cache bwrap availability check so we only shell out once. */
let bwrapAvailable: boolean | null = null;

function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    execSync('bwrap --version', { stdio: 'ignore' });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
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

export interface SandboxResult {
  /** The command/args to use for spawning. */
  command: string;
  args: string[];
  /** Whether sandboxing was applied. */
  sandboxed: boolean;
}

/**
 * Wrap a shell command for sandboxed execution.
 *
 * On macOS, wraps with sandbox-exec using an SBPL profile.
 * On Linux, wraps with bwrap (bubblewrap) if available.
 * On unsupported platforms or when bwrap is missing, returns the
 * command unchanged with a warning.
 */
export function wrapCommand(
  command: string,
  workingDir: string,
  enabled: boolean,
): SandboxResult {
  if (!enabled) {
    return {
      command: 'bash',
      args: ['-c', '--', command],
      sandboxed: false,
    };
  }

  if (isMacOS()) {
    if (!isSafeForSBPL(workingDir)) {
      log.warn('Working directory contains characters unsafe for sandbox profile. Running unsandboxed.');
      return {
        command: 'bash',
        args: ['-c', '--', command],
        sandboxed: false,
      };
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
      log.warn('Sandbox is enabled but bwrap is not installed. Running unsandboxed. Install bubblewrap: apt install bubblewrap');
      return {
        command: 'bash',
        args: ['-c', '--', command],
        sandboxed: false,
      };
    }
    return {
      command: 'bwrap',
      args: buildBwrapArgs(workingDir, command),
      sandboxed: true,
    };
  }

  log.warn('Sandbox is enabled but not supported on this platform. Running unsandboxed.');
  return {
    command: 'bash',
    args: ['-c', '--', command],
    sandboxed: false,
  };
}
