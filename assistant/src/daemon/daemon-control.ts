import { spawn } from 'node:child_process';
import { closeSync,existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DaemonError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import {
  getPidPath,
  getRootDir,
  getSocketPath,
  getWorkspaceConfigPath,
  removeSocketFile,
} from '../util/platform.js';

const log = getLogger('lifecycle');

const DAEMON_TIMEOUT_DEFAULTS = {
  startupSocketWaitMs: 5000,
  stopTimeoutMs: 5000,
  sigkillGracePeriodMs: 2000,
};

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Read daemon timeout values directly from the config JSON file, bypassing
 * loadConfig() and its ensureMigratedDataDir()/ensureDataDir() side effects.
 * Falls back to hardcoded defaults on any error (missing file, malformed JSON,
 * unexpected shape) so daemon stop/start never fails due to config issues.
 */
function readDaemonTimeouts(): typeof DAEMON_TIMEOUT_DEFAULTS {
  try {
    const raw = JSON.parse(readFileSync(getWorkspaceConfigPath(), 'utf-8'));
    if (raw.daemon && typeof raw.daemon === 'object') {
      return {
        startupSocketWaitMs: isPositiveInteger(raw.daemon.startupSocketWaitMs)
          ? raw.daemon.startupSocketWaitMs
          : DAEMON_TIMEOUT_DEFAULTS.startupSocketWaitMs,
        stopTimeoutMs: isPositiveInteger(raw.daemon.stopTimeoutMs)
          ? raw.daemon.stopTimeoutMs
          : DAEMON_TIMEOUT_DEFAULTS.stopTimeoutMs,
        sigkillGracePeriodMs: isPositiveInteger(raw.daemon.sigkillGracePeriodMs)
          ? raw.daemon.sigkillGracePeriodMs
          : DAEMON_TIMEOUT_DEFAULTS.sigkillGracePeriodMs,
      };
    }
  } catch {
    // Missing file, malformed JSON, etc. — use defaults.
  }
  return { ...DAEMON_TIMEOUT_DEFAULTS };
}

/**
 * Kill the stale daemon recorded in this workspace's PID file, if any.
 * Only targets the exact PID from our PID file — never scans globally —
 * so isolated daemons (e.g., dev instances with a different BASE_DATA_DIR)
 * are never affected.
 */
function killStaleDaemon(): void {
  const pid = readPid();
  if (pid == null) return;
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return;
  }

  // The PID file references a live process, but getDaemonStatus() (called
  // earlier in startDaemon) already returns early when the daemon is healthy.
  // If we reach here, the recorded process is alive but non-responsive.
  try {
    log.info({ pid }, 'Killing stale daemon process from PID file');
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have exited between the check and the kill.
  }
  cleanupPidFile();
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writePid(pid: number): void {
  writeFileSync(getPidPath(), String(pid));
}

export function cleanupPidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

/** Only remove the PID file if it belongs to the given process. Prevents a
 *  failing second startup from deleting the PID of an already-running daemon. */
export function cleanupPidFileIfOwner(ownerPid: number): void {
  const currentPid = readPid();
  if (currentPid === ownerPid) {
    cleanupPidFile();
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid == null) return false;
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return false;
  }
  return true;
}

export function getDaemonStatus(): { running: boolean; pid?: number } {
  const pid = readPid();
  if (pid == null) return { running: false };
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return { running: false };
  }
  return { running: true, pid };
}

export async function startDaemon(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const status = getDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, alreadyRunning: true };
  }

  // Kill a stale daemon recorded in this workspace's PID file (e.g., after
  // a crash where the process is alive but non-responsive).
  killStaleDaemon();

  // Only create the root dir for socket/PID — the daemon process itself
  // handles migration + full ensureDataDir() in runDaemon(). Calling
  // ensureDataDir() here would pre-create workspace destination dirs
  // and cause migration moves to no-op.
  const rootDir = getRootDir();
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }

  // Clean up stale socket (only if it's actually a Unix socket)
  const socketPath = getSocketPath();
  removeSocketFile(socketPath);

  // Spawn the daemon as a detached child process
  const mainPath = resolve(
    import.meta.dirname ?? __dirname,
    'main.ts',
  );

  // Redirect the child's stderr to a file instead of piping it back to the
  // parent. A pipe's read end is destroyed when the parent exits, leaving
  // fd 2 broken in the child. Bun (unlike Node.js) does not ignore SIGPIPE,
  // so any later stderr write would silently kill the daemon.
  const stderrPath = join(rootDir, 'daemon-stderr.log');
  const stderrFd = openSync(stderrPath, 'w');

  const child = spawn('bun', ['run', mainPath], {
    detached: true,
    stdio: ['ignore', 'ignore', stderrFd],
    env: { ...process.env },
  });

  // The child inherited the fd; close the parent's copy.
  closeSync(stderrFd);

  let childExited = false;
  let childExitCode: number | null = null;
  child.on('exit', (code) => {
    childExited = true;
    childExitCode = code;
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new DaemonError('Failed to start daemon: no PID returned');
  }

  // Wait for socket to appear before writing the PID file. Writing it
  // earlier would leave an orphaned PID file if the daemon crashes during
  // initialization — callers would think the daemon is still running.
  const timeouts = readDaemonTimeouts();
  const maxWait = timeouts.startupSocketWaitMs;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    if (existsSync(socketPath)) {
      writePid(pid);
      return { pid, alreadyRunning: false };
    }
    if (childExited) {
      const stderr = readFileSync(stderrPath, 'utf-8').trim();
      const detail = stderr
        ? `\n${stderr}`
        : `\nCheck logs at ~/.vellum/workspace/data/logs/ for details.`;
      throw new DaemonError(
        `Daemon exited immediately (code ${childExitCode ?? 'unknown'}).${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  // The child process is still running but the socket hasn't appeared yet.
  // Write the PID file so isDaemonRunning()/stopDaemon() can still track
  // and manage the orphaned process.
  writePid(pid);
  throw new DaemonError(
    `Daemon started but socket not available after ${maxWait}ms`,
  );
}

export type StopResult =
  | { stopped: true }
  | { stopped: false; reason: 'not_running' | 'stop_failed' };

export async function stopDaemon(): Promise<StopResult> {
  const pid = readPid();
  if (pid == null || !isProcessRunning(pid)) {
    cleanupPidFile();
    return { stopped: false, reason: 'not_running' };
  }

  process.kill(pid, 'SIGTERM');

  const timeouts = readDaemonTimeouts();

  // Wait for process to exit
  const maxWait = timeouts.stopTimeoutMs;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    if (!isProcessRunning(pid)) {
      cleanupPidFile();
      return { stopped: true };
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    log.debug({ err, pid }, 'SIGKILL failed, process already exited');
  }

  // Wait for the process to actually die after SIGKILL. Without this,
  // startDaemon() can race with the dying process's shutdown handler,
  // which removes the socket file and bricks the new daemon.
  const killMaxWait = timeouts.sigkillGracePeriodMs;
  let killWaited = 0;
  while (killWaited < killMaxWait && isProcessRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
    killWaited += 100;
  }

  // Only clean up if the process has actually exited.
  // If it's still alive after SIGKILL + timeout, preserve both socket
  // and PID file so isDaemonRunning() still reports true and prevents
  // a duplicate daemon from being spawned.
  if (!isProcessRunning(pid)) {
    removeSocketFile(getSocketPath());
    cleanupPidFile();
    return { stopped: true };
  }

  log.warn({ pid }, 'Daemon process still running after SIGKILL + timeout, leaving socket and PID file intact');
  return { stopped: false, reason: 'stop_failed' };
}

export async function ensureDaemonRunning(): Promise<void> {
  if (isDaemonRunning()) return;
  await startDaemon();
}
