import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMacOS } from '../../util/platform.js';
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

/**
 * Get the path to the sandbox profile file, creating it if needed.
 * The profile is written to ~/.vellum/sandbox-profile.sb.
 */
function getProfilePath(workingDir: string): string {
  const dir = join(process.env.HOME ?? '/tmp', '.vellum');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = join(dir, 'sandbox-profile.sb');

  // Always rewrite with the current working directory
  const profile = SANDBOX_PROFILE.replace(/__WORKING_DIR__/g, workingDir);
  writeFileSync(path, profile + '\n');
  return path;
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
 * On macOS with sandbox enabled, wraps the command with sandbox-exec.
 * On unsupported platforms, returns the command unchanged with a warning.
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

  if (!isMacOS()) {
    log.warn('Sandbox is enabled but not supported on this platform. Running unsandboxed.');
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
