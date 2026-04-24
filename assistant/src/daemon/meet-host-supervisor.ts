/**
 * `MeetHostSupervisor` — owns the lifecycle of the lazily-spawned
 * `bun run skills/meet-join/register.ts` child process (the meet-host).
 *
 * The daemon stays skill-agnostic at the process layer: the supervisor
 * is the one place that knows how to find the bun binary, resolve the
 * installed skill path, spawn the child, wait for its handshake, count
 * active sessions, and idle-shut it down. The IPC surface between the
 * two processes lives in `assistant/src/ipc/skill-server.ts` (PR 20)
 * and the `host.registries.*` routes that back it (PR 24).
 *
 * ## Lifecycle
 *
 *   - `ensureRunning()` — idempotent. First caller triggers
 *     `child_process.spawn`, subsequent concurrent callers await the
 *     same in-flight promise. Resolves once the child dials
 *     `assistant-skill.sock` and sends a handshake frame (via
 *     `notifyHandshake`) whose reported source-tree hash matches the
 *     shipped manifest's hash. A mismatch kills the spawn and throws
 *     a clear error pointing the user at regenerating the manifest.
 *
 *   - `reportSessionStarted(id)` / `reportSessionEnded(id)` — mutate
 *     the active-session counter. Called by PR 24's
 *     `host.registries.report_session_*` IPC routes. The counter is
 *     tracked by session id (Set of live ids) so duplicate or
 *     out-of-order `ended` frames can't drop the count below zero.
 *
 *   - Idle timer — when the counter reaches zero the supervisor arms
 *     a 5-minute timer (configurable via
 *     `services.meet.host.idle_timeout_ms`). On expiry it sends a
 *     `skill.shutdown` frame over the IPC socket (best-effort — if no
 *     IPC sink is wired yet the supervisor still falls through to the
 *     signal path), waits briefly for graceful exit, then
 *     SIGTERM/SIGKILLs the child. Any new session before the timer
 *     fires disarms it.
 *
 *   - Crash detection — the supervisor listens for the child's `exit`
 *     event; when it fires unexpectedly the handle is nulled and the
 *     next `ensureRunning()` call respawns.
 *
 *   - `shutdown()` — graceful termination on daemon shutdown.
 *
 * PR 27 adds the supervisor only — it does NOT register any IPC
 * routes or auto-start on daemon boot. PR 28 wires this class into
 * `meet-manifest-loader.ts` so proxy tool invocations call
 * `ensureRunning()` before dispatching.
 */

import {
  type ChildProcess,
  spawn as defaultSpawn,
  type SpawnOptions,
} from "node:child_process";
import { connect as defaultConnect, type Socket } from "node:net";

import { getConfig, getNestedValue } from "../config/loader.js";
import { getSkillSocketPath } from "../ipc/skill-socket-path.js";
import { getLogger } from "../util/logger.js";

/**
 * Shipped manifest payload the supervisor needs for handshake
 * validation. Callers load the JSON manifest (written by
 * `skills/meet-join/scripts/emit-manifest.ts`) and pass just the
 * hash through. Accepting the value rather than reading the file
 * keeps the supervisor free of path assumptions and simplifies
 * tests.
 */
export interface MeetHostManifest {
  /** SHA-256 of the shipped skill source tree. */
  sourceHash: string;
}

/**
 * Payload the external IPC route handler passes to `notifyHandshake`
 * when the meet-host sends its `register_tools` / `ready` frame.
 * Currently just the source hash; additional fields (pid echo,
 * protocol version) can be threaded through later without a
 * signature break.
 */
export interface MeetHostHandshakePayload {
  sourceHash: string;
}

/**
 * Dependencies the supervisor needs to spawn and supervise the
 * child. All are optional on construction — production callers
 * rely on the defaults and tests override one or two at a time.
 */
export interface MeetHostSupervisorDeps {
  /** Absolute path to the shipped `meet-join` skill dir, containing `register.ts`. */
  skillRuntimePath: string;
  /** Absolute path to a standalone bun binary, or `"bun"` for PATH lookup. */
  bunBinaryPath: string;
  /** Path to the skill IPC socket the child should dial. */
  skillSocketPath?: string;
  /** Shipped manifest (source of the hash we check handshake against). */
  manifest: MeetHostManifest;
  /** Child-process spawn function (override for tests). */
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /**
   * Socket-connect function used to open an IPC control channel for
   * sending `skill.shutdown` on idle. Override for tests.
   */
  connectFn?: (path: string) => Socket;
  /** Override for the idle timeout in ms. Falls back to config key then default. */
  idleTimeoutMsOverride?: number;
  /** How long (ms) to wait for graceful exit before SIGTERM on idle/shutdown. */
  gracefulExitGraceMs?: number;
  /** How long (ms) to wait after SIGTERM before SIGKILL. */
  sigkillGraceMs?: number;
}

/** Default idle timeout when no config override is set: 5 minutes. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Config path for overriding the idle timeout. */
const IDLE_TIMEOUT_CONFIG_KEY = "services.meet.host.idle_timeout_ms";
/** Default grace period for a `skill.shutdown` frame to induce clean exit. */
const DEFAULT_GRACEFUL_EXIT_GRACE_MS = 2_000;
/** Default grace period between SIGTERM and SIGKILL. */
const DEFAULT_SIGKILL_GRACE_MS = 1_000;

const log = getLogger("meet-host-supervisor");

/**
 * Read the idle timeout from config, falling back to the default. The
 * config-loader `getNestedValue` helper is nullable; we coerce only
 * finite positive numbers and log + drop any other value so a malformed
 * config entry can't disable the idle shutdown entirely.
 */
function readIdleTimeoutFromConfig(): number {
  try {
    const raw = getNestedValue(
      getConfig() as unknown as Record<string, unknown>,
      IDLE_TIMEOUT_CONFIG_KEY,
    );
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
    if (raw !== undefined) {
      log.warn(
        { configKey: IDLE_TIMEOUT_CONFIG_KEY, value: raw },
        "Ignoring non-numeric idle timeout override from config",
      );
    }
  } catch (err) {
    log.warn({ err }, "Failed to read idle timeout config; using default");
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

export class MeetHostSupervisor {
  private readonly skillRuntimePath: string;
  private readonly bunBinaryPath: string;
  private readonly skillSocketPath: string;
  private readonly manifest: MeetHostManifest;
  private readonly spawnFn: NonNullable<MeetHostSupervisorDeps["spawnFn"]>;
  private readonly connectFn: NonNullable<MeetHostSupervisorDeps["connectFn"]>;
  private readonly idleTimeoutMs: number;
  private readonly gracefulExitGraceMs: number;
  private readonly sigkillGraceMs: number;

  private child: ChildProcess | null = null;
  private spawnPromise: Promise<void> | null = null;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;
  private readonly activeSessions = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(deps: MeetHostSupervisorDeps) {
    this.skillRuntimePath = deps.skillRuntimePath;
    this.bunBinaryPath = deps.bunBinaryPath;
    this.skillSocketPath = deps.skillSocketPath ?? getSkillSocketPath();
    this.manifest = deps.manifest;
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.connectFn = deps.connectFn ?? defaultConnect;
    this.idleTimeoutMs =
      deps.idleTimeoutMsOverride ?? readIdleTimeoutFromConfig();
    this.gracefulExitGraceMs =
      deps.gracefulExitGraceMs ?? DEFAULT_GRACEFUL_EXIT_GRACE_MS;
    this.sigkillGraceMs = deps.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  }

  /**
   * Ensure the meet-host child is spawned, the IPC handshake has been
   * received, and the manifest hash validated. Idempotent: a second
   * call while the child is already running is a no-op; a second call
   * during an in-flight spawn awaits the same promise.
   */
  ensureRunning(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(
        new Error("MeetHostSupervisor is shutting down; cannot spawn"),
      );
    }
    if (this.child && !this.child.killed && this.child.exitCode == null) {
      return this.spawnPromise ?? Promise.resolve();
    }
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = this.spawnAndHandshake().catch((err) => {
      this.spawnPromise = null;
      this.teardownChild();
      throw err;
    });
    return this.spawnPromise;
  }

  /**
   * Called by the IPC route handler when the child sends its
   * `host.registries.register_tools` / `ready` frame. The supervisor
   * validates the reported source hash against the shipped manifest
   * and either resolves or rejects the in-flight `ensureRunning()`
   * promise accordingly.
   *
   * Intentionally public so PR 24's `host.registries.*` route (which
   * owns the IPC socket) can forward the payload without the
   * supervisor owning any socket state itself.
   */
  notifyHandshake(payload: MeetHostHandshakePayload): void {
    if (!this.handshakeResolve || !this.handshakeReject) {
      log.debug("notifyHandshake called with no in-flight spawn; ignoring");
      return;
    }
    if (payload.sourceHash !== this.manifest.sourceHash) {
      const err = new Error(
        `meet-join source hash mismatch: handshake reported ${payload.sourceHash} ` +
          `but manifest expects ${this.manifest.sourceHash}. ` +
          "Regenerate the meet-join manifest or rebuild the assistant to match.",
      );
      this.handshakeReject(err);
      return;
    }
    this.handshakeResolve();
  }

  /**
   * Increment the active-session counter. Called by PR 24's
   * `host.registries.report_session_started` IPC route when a new
   * meet session is joined. Idempotent for the same id.
   */
  reportSessionStarted(sessionId: string): void {
    this.activeSessions.add(sessionId);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      log.debug({ sessionId }, "Idle timer cancelled — new session active");
    }
  }

  /**
   * Decrement the active-session counter. Called by PR 24's
   * `host.registries.report_session_ended` IPC route when a meet
   * session completes. When the counter drops to zero the idle
   * timer is armed.
   */
  reportSessionEnded(sessionId: string): void {
    const had = this.activeSessions.delete(sessionId);
    if (!had) {
      log.debug({ sessionId }, "Ignoring report_session_ended for unknown id");
    }
    if (this.activeSessions.size === 0) {
      this.armIdleTimer();
    }
  }

  /**
   * Read-only view of the active session count — exposed for
   * diagnostics and tests. Not part of the IPC protocol.
   */
  get activeSessionCount(): number {
    return this.activeSessions.size;
  }

  /** Whether the child is currently running. Exposed for tests. */
  get isRunning(): boolean {
    return (
      this.child != null && !this.child.killed && this.child.exitCode == null
    );
  }

  /**
   * Graceful termination. Cancels the idle timer, sends
   * `skill.shutdown` to the child, then SIGTERM → SIGKILL on
   * escalation. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.stopChild("daemon-shutdown");
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async spawnAndHandshake(): Promise<void> {
    const registerPath = `${this.skillRuntimePath}/register.ts`;
    log.info(
      {
        bun: this.bunBinaryPath,
        register: registerPath,
        socket: this.skillSocketPath,
      },
      "Spawning meet-host child process",
    );

    const child = this.spawnFn(
      this.bunBinaryPath,
      [
        "run",
        registerPath,
        `--ipc=${this.skillSocketPath}`,
        "--skill-id=meet-join",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VELLUM_SKILL_IPC_SOCKET: this.skillSocketPath,
          VELLUM_SKILL_ID: "meet-join",
        },
      },
    );
    this.child = child;

    // Forward stdout/stderr to the daemon log so meet-host diagnostics
    // aren't lost. Best-effort — streams may be null in tests.
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.info({ source: "meet-host-stdout" }, text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.warn({ source: "meet-host-stderr" }, text);
    });

    child.on("exit", (code, signal) => {
      log.info({ code, signal }, "meet-host child exited");
      // Reject any in-flight handshake so callers fail fast instead of
      // hanging waiting for a frame that will never arrive.
      if (this.handshakeReject) {
        this.handshakeReject(
          new Error(
            `meet-host exited before handshake (code=${code ?? "null"}, ` +
              `signal=${signal ?? "null"})`,
          ),
        );
      }
      this.teardownChild();
    });
    child.on("error", (err) => {
      log.error({ err }, "meet-host spawn error");
      if (this.handshakeReject) this.handshakeReject(err);
    });

    await new Promise<void>((resolve, reject) => {
      this.handshakeResolve = () => {
        this.handshakeResolve = null;
        this.handshakeReject = null;
        resolve();
      };
      this.handshakeReject = (err) => {
        this.handshakeResolve = null;
        this.handshakeReject = null;
        reject(err);
      };
    });
  }

  /**
   * Drop references to the current child and any handshake waiters.
   * Called on `exit`, on hash-mismatch rejection, and during shutdown.
   * If the child is still live (e.g. hash-mismatch path aborts before
   * stopChild runs), SIGKILL it so we don't leak an orphan process on
   * respawn.
   */
  private teardownChild(): void {
    const child = this.child;
    if (child && !child.killed && child.exitCode == null) {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        log.warn({ err }, "SIGKILL during teardown failed");
      }
    }
    this.child = null;
    this.spawnPromise = null;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    this.activeSessions.clear();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.isRunning) return;
    log.debug(
      { idleTimeoutMs: this.idleTimeoutMs },
      "No active sessions — arming idle-shutdown timer",
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stopChild("idle-timeout").catch((err) => {
        log.warn({ err }, "Idle-timeout shutdown failed");
      });
    }, this.idleTimeoutMs);
  }

  /**
   * Stop the child: send `skill.shutdown` over the control socket,
   * wait briefly, then SIGTERM, then SIGKILL. Safe to call with no
   * child (no-op). Reason is surfaced in logs for diagnostics.
   */
  private async stopChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode != null) {
      this.teardownChild();
      return;
    }
    log.info({ reason, pid: child.pid }, "Stopping meet-host child");

    // Best-effort graceful shutdown over the IPC socket. If no frame
    // can be sent (socket closed, control channel not wired yet) we
    // fall straight through to signals.
    try {
      await this.sendShutdownFrame();
    } catch (err) {
      log.debug(
        { err },
        "skill.shutdown frame could not be delivered; escalating to SIGTERM",
      );
    }

    if (await waitForExit(child, this.gracefulExitGraceMs)) return;

    if (child.exitCode == null) {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        log.warn({ err }, "SIGTERM to meet-host failed");
      }
    }
    if (await waitForExit(child, this.sigkillGraceMs)) return;

    if (child.exitCode == null) {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        log.warn({ err }, "SIGKILL to meet-host failed");
      }
    }
    this.teardownChild();
  }

  /**
   * Open a one-shot socket connection, write a `skill.shutdown`
   * request frame, close. Errors are surfaced to the caller so
   * `stopChild` can log + escalate to signals.
   */
  private sendShutdownFrame(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let sock: Socket;
      try {
        sock = this.connectFn(this.skillSocketPath);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const frame =
        JSON.stringify({ id: "meet-host-shutdown", method: "skill.shutdown" }) +
        "\n";
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch {
          // Ignore — destroy is best-effort.
        }
        if (err) reject(err);
        else resolve();
      };
      sock.once("connect", () => {
        sock.write(frame, (writeErr) => {
          if (writeErr) finish(writeErr);
          else finish();
        });
      });
      sock.once("error", (err) => finish(err));
    });
  }
}

/**
 * Resolve when the child exits or the given grace period elapses.
 * Returns `true` if the child exited within the grace window, `false`
 * if the timeout fired first.
 */
function waitForExit(child: ChildProcess, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode != null) {
      resolve(true);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, graceMs);
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}
