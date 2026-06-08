import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type SidecarState =
  | { status: "idle" }
  | { status: "starting"; attempt: number }
  | { status: "running"; pid?: number }
  | {
      status: "backing-off";
      attempt: number;
      retryAt: number;
      reason: string;
    }
  | { status: "circuit-open"; reason: string }
  | { status: "stopped"; reason?: string };

export interface SidecarSupervisorOptions {
  name: string;
  spawn: () => ChildProcessWithoutNullStreams;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  onStart?: (child: ChildProcessWithoutNullStreams) => void;
  onExit?: (reason: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  stableResetMs?: number;
  circuitCrashCount?: number;
  circuitWindowMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_STABLE_RESET_MS = 60_000;
const DEFAULT_CIRCUIT_CRASH_COUNT = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export class SidecarSupervisor {
  private readonly name: string;
  private readonly spawnChild: () => ChildProcessWithoutNullStreams;
  private readonly logger: SidecarSupervisorOptions["logger"];
  private readonly onStart?: (child: ChildProcessWithoutNullStreams) => void;
  private readonly onExit?: (reason: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stableResetMs: number;
  private readonly circuitCrashCount: number;
  private readonly circuitWindowMs: number;
  private readonly listeners = new Set<(state: SidecarState) => void>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimestamps: number[] = [];
  private attempt = 0;
  private stopping = false;
  private state: SidecarState = { status: "idle" };

  constructor(options: SidecarSupervisorOptions) {
    this.name = options.name;
    this.spawnChild = options.spawn;
    this.logger = options.logger;
    this.onStart = options.onStart;
    this.onExit = options.onExit;
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS;
    this.circuitCrashCount =
      options.circuitCrashCount ?? DEFAULT_CIRCUIT_CRASH_COUNT;
    this.circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
  }

  getState(): SidecarState {
    return this.state;
  }

  currentChild(): ChildProcessWithoutNullStreams | null {
    return this.child;
  }

  onState(listener: (state: SidecarState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ensureRunning(): ChildProcessWithoutNullStreams | null {
    if (this.stopping) return null;
    if (this.child) return this.child;
    if (this.state.status === "stopped") return null;
    if (this.state.status === "circuit-open") return null;
    if (this.restartTimer) return null;
    return this.startNow();
  }

  retry(): SidecarState {
    this.clearRestartTimer();
    this.crashTimestamps = [];
    this.attempt = 0;
    this.stopping = false;
    if (this.state.status === "circuit-open") {
      this.setState({ status: "idle" });
    }
    if (this.child) {
      this.replaceChild();
    }
    this.startNow();
    return this.state;
  }

  private replaceChild(): void {
    const child = this.child;
    if (!child) return;

    this.child = null;
    this.clearStableTimer();
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
    }, DEFAULT_SHUTDOWN_GRACE_MS);
    killTimer.unref?.();
  }

  stop(options?: { graceMs?: number; reason?: string }): void {
    this.stopping = true;
    this.clearRestartTimer();
    this.clearStableTimer();

    const child = this.child;
    if (!child) {
      this.setState({ status: "stopped", reason: options?.reason });
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }

    const killTimer = setTimeout(() => {
      if (this.child === child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may already have exited.
        }
      }
    }, options?.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    killTimer.unref?.();
  }

  resetForTesting(): void {
    this.clearRestartTimer();
    this.clearStableTimer();
    this.child = null;
    this.crashTimestamps = [];
    this.attempt = 0;
    this.stopping = false;
    this.setState({ status: "idle" });
    this.listeners.clear();
  }

  private startNow(): ChildProcessWithoutNullStreams | null {
    if (this.state.status === "circuit-open") return null;

    this.stopping = false;
    this.setState({ status: "starting", attempt: this.attempt + 1 });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${this.name}] failed to spawn: ${message}`);
      this.handleUnexpectedExit(`spawn failed: ${message}`);
      return null;
    }

    this.child = child;
    let handledExit = false;
    const handleExit = (reason: string) => {
      if (handledExit) return;
      handledExit = true;
      if (this.child !== child) return;
      this.handleChildExit(reason);
    };

    child.once("error", (err: Error) => {
      this.logger.warn(`[${this.name}] process error: ${err.message}`);
      handleExit(err.message);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const suffix =
        signal !== null
          ? `signal ${signal}`
          : code !== null
            ? `exit ${code}`
            : "closed";
      handleExit(suffix);
    });

    this.onStart?.(child);
    this.setState({
      status: "running",
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });
    this.armStableReset();
    return child;
  }

  private handleChildExit(reason: string): void {
    this.child = null;
    this.clearStableTimer();
    this.onExit?.(reason);

    if (this.stopping) {
      this.setState({ status: "stopped", reason });
      return;
    }

    this.handleUnexpectedExit(reason);
  }

  private handleUnexpectedExit(reason: string): void {
    const now = Date.now();
    const windowStart = now - this.circuitWindowMs;
    this.crashTimestamps = [
      ...this.crashTimestamps.filter((timestamp) => timestamp >= windowStart),
      now,
    ];

    if (this.crashTimestamps.length >= this.circuitCrashCount) {
      const circuitReason = `${this.name} crashed ${this.crashTimestamps.length} times in ${Math.round(
        this.circuitWindowMs / 1_000,
      )}s`;
      this.logger.warn(`[${this.name}] ${circuitReason}; circuit open`);
      this.setState({ status: "circuit-open", reason: circuitReason });
      return;
    }

    const delay = Math.min(
      this.initialBackoffMs * 2 ** this.attempt,
      this.maxBackoffMs,
    );
    this.attempt += 1;
    const retryAt = now + delay;
    this.logger.warn(
      `[${this.name}] exited (${reason}); restarting in ${delay}ms`,
    );
    this.setState({
      status: "backing-off",
      attempt: this.attempt,
      retryAt,
      reason,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startNow();
    }, delay);
    this.restartTimer.unref?.();
  }

  private armStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
      this.crashTimestamps = [];
    }, this.stableResetMs);
    this.stableTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private setState(state: SidecarState): void {
    if (sidecarStatesEqual(this.state, state)) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

const sidecarStatesEqual = (a: SidecarState, b: SidecarState): boolean => {
  if (a.status !== b.status) return false;
  switch (a.status) {
    case "idle":
      return true;
    case "starting":
      return b.status === "starting" && a.attempt === b.attempt;
    case "running":
      return b.status === "running" && a.pid === b.pid;
    case "backing-off":
      return (
        b.status === "backing-off" &&
        a.attempt === b.attempt &&
        a.retryAt === b.retryAt &&
        a.reason === b.reason
      );
    case "circuit-open":
      return b.status === "circuit-open" && a.reason === b.reason;
    case "stopped":
      return b.status === "stopped" && a.reason === b.reason;
  }
};
