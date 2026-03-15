import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { getRuntimeHttpHost, getRuntimeHttpPort } from "../config/env.js";
import { DaemonError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  getPidPath,
  getRootDir,
  getWorkspaceConfigPath,
} from "../util/platform.js";

const log = getLogger("lifecycle");

const DAEMON_TIMEOUT_DEFAULTS = {
  startupSocketWaitMs: 5000,
  stopTimeoutMs: 5000,
  sigkillGracePeriodMs: 2000,
};

const HEALTH_CHECK_TIMEOUT_MS = 1500;
const STARTUP_LOCK_STALE_MS = 30_000;

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Read daemon timeout values directly from the config JSON file, bypassing
 * loadConfig() and its ensureMigratedDataDir()/ensureDataDir() side effects.
 * Falls back to hardcoded defaults on any error (missing file, malformed JSON,
 * unexpected shape) so daemon stop/start never fails due to config issues.
 */
function readDaemonTimeouts(): typeof DAEMON_TIMEOUT_DEFAULTS {
  try {
    const raw = JSON.parse(readFileSync(getWorkspaceConfigPath(), "utf-8"));
    if (raw.daemon && typeof raw.daemon === "object") {
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

  // Guard against stale PID reuse: if the PID has been recycled by the OS
  // and now belongs to an unrelated process, we must not signal it.
  if (!isVellumDaemonProcess(pid)) {
    log.info(
      { pid },
      "PID file references a non-vellum process (stale PID reuse) — cleaning up PID file only",
    );
    cleanupPidFile();
    return;
  }

  // The PID file references a live vellum daemon process, but getDaemonStatus()
  // (called earlier in startDaemon) already returns early when the daemon is
  // healthy. If we reach here, the recorded process is alive but non-responsive.
  try {
    log.info({ pid }, "Killing stale daemon process from PID file");
    process.kill(pid, "SIGKILL");
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

/**
 * Check whether a PID belongs to a vellum daemon process (a bun process
 * running the daemon's main.ts). Prevents signaling an unrelated process
 * that reused a stale PID.
 */
function isVellumDaemonProcess(pid: number): boolean {
  try {
    const cmd = execSync(`ps -ww -p ${pid} -o command=`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // The daemon is spawned as `bun run <path>/main.ts` — look for bun
    // running our daemon entry point.
    return cmd.includes("bun") && cmd.includes("daemon/main.ts");
  } catch {
    // Process exited or ps failed — treat as not ours.
    return false;
  }
}

/** Normalize a bind address to a connectable host for health checks.
 *  Wildcard addresses (0.0.0.0, ::) bind all interfaces but aren't
 *  connectable on all platforms — substitute loopback. IPv6 literals
 *  need brackets in URLs. */
function healthCheckHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (host.includes(":")) return `[${host}]`;
  return host;
}

/** Hit the daemon's HTTP /healthz endpoint. Returns true if it responds
 *  with HTTP 200 within the timeout — false on connection refused, timeout,
 *  or any other error. */
export async function isHttpHealthy(): Promise<boolean> {
  const host = healthCheckHost(getRuntimeHttpHost());
  const port = getRuntimeHttpPort();
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
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

export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
}> {
  const pid = readPid();
  if (pid == null) return { running: false };
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return { running: false };
  }
  // Guard against stale PID reuse: if the OS recycled the PID and it now
  // belongs to an unrelated process, discard the stale PID file.
  if (!isVellumDaemonProcess(pid)) {
    log.info(
      { pid },
      "PID file references a non-vellum process (stale PID reuse) — cleaning up",
    );
    cleanupPidFile();
    return { running: false };
  }
  // Process is alive and is ours — verify HTTP /healthz is responsive. A
  // deadlocked or wedged daemon will pass the PID liveness check but fail
  // to accept connections, and should be treated as not running so
  // killStaleDaemon() can clean it up.
  const responsive = await isHttpHealthy();
  if (!responsive) {
    log.warn(
      { pid },
      "Daemon process alive but HTTP health check unresponsive",
    );
    return { running: false, pid };
  }
  return { running: true, pid };
}

function getStartupLockPath(): string {
  return join(getRootDir(), "daemon-startup.lock");
}

/** Attempt to acquire a startup lock. Returns true on success. Stale locks
 *  (older than STARTUP_LOCK_STALE_MS) are forcibly removed to prevent
 *  permanent deadlocks from a crashed caller. */
function acquireStartupLock(): boolean {
  const lockPath = getStartupLockPath();
  try {
    // Ensure the root directory exists before attempting the lock file write.
    // On a first-time run, getRootDir() may not exist yet, and writeFileSync
    // with 'wx' would throw ENOENT — which the catch block misinterprets as
    // "lock already held."
    mkdirSync(getRootDir(), { recursive: true });
    // O_CREAT | O_EXCL — fails atomically if the file already exists.
    writeFileSync(lockPath, String(Date.now()), { flag: "wx" });
    return true;
  } catch {
    // Lock file exists — check for staleness.
    try {
      const ts = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(ts) && Date.now() - ts > STARTUP_LOCK_STALE_MS) {
        unlinkSync(lockPath);
        return acquireStartupLock();
      }
    } catch {
      // Can't read the lock — another process may be manipulating it.
    }
    return false;
  }
}

function releaseStartupLock(): void {
  try {
    unlinkSync(getStartupLockPath());
  } catch {
    /* already removed */
  }
}

// NOTE: startDaemon() is the assistant-side daemon lifecycle manager.
// It should eventually converge with cli/src/lib/local.ts::startLocalDaemon
// which is the CLI-side equivalent.
export async function startDaemon(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const status = await getDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, alreadyRunning: true };
  }

  // Serialize concurrent startup attempts. If another caller already holds
  // the lock, wait for it to finish and then re-check daemon status.
  if (!acquireStartupLock()) {
    log.info("Another startup in progress, waiting for lock");
    const lockWaitMs = 10_000;
    const lockInterval = 200;
    let lockWaited = 0;
    let lockAcquired = false;
    while (lockWaited < lockWaitMs) {
      await new Promise((r) => setTimeout(r, lockInterval));
      lockWaited += lockInterval;
      if (acquireStartupLock()) {
        lockAcquired = true;
        break;
      }
    }
    if (!lockAcquired) {
      // Timed out waiting for the lock — re-check status in case the
      // other caller succeeded.
      const recheck = await getDaemonStatus();
      if (recheck.running && recheck.pid) {
        return { pid: recheck.pid, alreadyRunning: true };
      }
      throw new DaemonError(
        "Timed out waiting for concurrent daemon startup to finish",
      );
    }
    // Acquired the lock after waiting — re-check in case the other caller
    // already started the daemon successfully.
    const recheck = await getDaemonStatus();
    if (recheck.running && recheck.pid) {
      releaseStartupLock();
      return { pid: recheck.pid, alreadyRunning: true };
    }
  }

  try {
    return await startDaemonLocked();
  } finally {
    releaseStartupLock();
  }
}

async function startDaemonLocked(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  // Kill a stale daemon recorded in this workspace's PID file (e.g., after
  // a crash where the process is alive but non-responsive).
  killStaleDaemon();

  // Only create the root dir for PID files — the daemon process itself
  // handles migration + full ensureDataDir() in runDaemon(). Calling
  // ensureDataDir() here would pre-create workspace destination dirs
  // and cause migration moves to no-op.
  const rootDir = getRootDir();
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }

  // Spawn the daemon as a detached child process
  const mainPath = resolve(import.meta.dirname ?? __dirname, "main.ts");

  // Redirect the child's stderr to a file instead of piping it back to the
  // parent. A pipe's read end is destroyed when the parent exits, leaving
  // fd 2 broken in the child. Bun (unlike Node.js) does not ignore SIGPIPE,
  // so any later stderr write would silently kill the daemon.
  const stderrPath = join(rootDir, "daemon-stderr.log");
  const stderrFd = openSync(stderrPath, "w");

  const child = spawn("bun", ["run", mainPath], {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: { ...process.env },
  });

  // The child inherited the fd; close the parent's copy.
  closeSync(stderrFd);

  let childExited = false;
  let childExitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new DaemonError("Failed to start daemon: no PID returned");
  }

  // Wait for HTTP /healthz to respond before writing the PID file. Writing
  // it earlier would leave an orphaned PID file if the daemon crashes during
  // initialization — callers would think the daemon is still running.
  const timeouts = readDaemonTimeouts();
  const maxWait = timeouts.startupSocketWaitMs;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    if (childExited) {
      const stderr = readFileSync(stderrPath, "utf-8").trim();
      const detail = stderr
        ? `\n${stderr}`
        : `\nCheck logs at ~/.vellum/workspace/data/logs/ for details.`;
      throw new DaemonError(
        `Daemon exited immediately (code ${
          childExitCode ?? "unknown"
        }).${detail}`,
      );
    }
    if (await isHttpHealthy()) {
      writePid(pid);
      return { pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  // The child process is still running but the HTTP health check hasn't
  // passed yet. Write the PID file so isDaemonRunning()/stopDaemon() can
  // still track and manage the orphaned process.
  writePid(pid);
  throw new DaemonError(
    `Daemon started but health check not responding after ${maxWait}ms`,
  );
}

export type StopResult =
  | { stopped: true }
  | { stopped: false; reason: "not_running" | "stop_failed" };

export async function stopDaemon(): Promise<StopResult> {
  const pid = readPid();
  if (pid == null || !isProcessRunning(pid)) {
    cleanupPidFile();
    return { stopped: false, reason: "not_running" };
  }

  // Guard against stale PID reuse: if the PID has been recycled by the OS
  // and now belongs to an unrelated process, clean up the PID file but
  // never signal it.
  if (!isVellumDaemonProcess(pid)) {
    log.info(
      { pid },
      "PID file references a non-vellum process (stale PID reuse) — cleaning up PID file only",
    );
    cleanupPidFile();
    return { stopped: false, reason: "not_running" };
  }

  process.kill(pid, "SIGTERM");

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
    process.kill(pid, "SIGKILL");
  } catch (err) {
    log.debug({ err, pid }, "SIGKILL failed, process already exited");
  }

  // Wait for the process to actually die after SIGKILL. Without this,
  // startDaemon() can race with the dying process's shutdown handler.
  const killMaxWait = timeouts.sigkillGracePeriodMs;
  let killWaited = 0;
  while (killWaited < killMaxWait && isProcessRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
    killWaited += 100;
  }

  // Only clean up if the process has actually exited.
  // If it's still alive after SIGKILL + timeout, preserve the PID file
  // so isDaemonRunning() still reports true and prevents a duplicate
  // daemon from being spawned.
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return { stopped: true };
  }

  log.warn(
    { pid },
    "Daemon process still running after SIGKILL + timeout, leaving PID file intact",
  );
  return { stopped: false, reason: "stop_failed" };
}

export async function ensureDaemonRunning(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) return;
  await startDaemon();
}
