/**
 * Standalone entry point for the schedule worker as its own OS process.
 *
 * Spawned by the daemon at startup. Loads config, writes a PID file, and
 * claims + executes due schedules (all modes) on a fixed tick until
 * SIGTERM/SIGINT. This process is the sole runner of schedule execution; the
 * daemon's own scheduler tick runs only watchers and sequences.
 *
 * Running as a separate process — off the assistant's main event loop — is
 * the point: expensive scheduled jobs execute here without competing with
 * user-facing traffic, and keep running during a main-thread freeze in the
 * daemon.
 */
import { watch, writeFileSync } from "node:fs";

import {
  initFeatureFlagOverrides,
  refreshOverridesFromGateway,
} from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { rehydratePlatformCredentials } from "../config/platform-rehydration.js";
import { startConversationEvictor } from "../daemon/conversation-evictor.js";
import { stopMcpServerManager } from "../mcp/manager.js";
import { MCP_RELOAD_SIGNAL_FILE } from "../mcp/reload-signal.js";
import {
  restartConfiguredMcpServers,
  startConfiguredMcpServers,
} from "../mcp/startup.js";
import { resetDb } from "../persistence/db-connection.js";
import { registerWorkerPluginSurface } from "../plugins/worker-plugin-surface.js";
import { disableStreamSeqStamping } from "../runtime/assistant-stream-state.js";
import { initializeTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { getScheduleWorkerPidPath, getSignalsDir } from "../util/platform.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../util/worker-process.js";
import { runDueSchedulesOnce } from "./scheduler.js";

const log = getLogger("schedule-worker-process");

/** Same cadence as the daemon scheduler's tick. */
const TICK_INTERVAL_MS = 15_000;

/** How often this process re-reads flag overrides from the gateway. */
const FLAG_REFRESH_INTERVAL_MS = 60_000;

/**
 * How long startup waits for MCP servers before arming the tick.
 *
 * Connecting is worth waiting for: a schedule that fires first would fail its
 * `mcp__*` calls as unknown tools. It is not worth waiting for without limit.
 * `McpServerManager.start()` walks servers one at a time and allows each 30s to
 * connect and 30s more to list its tools, so a handful of unreachable ones can
 * hold the first tick for minutes, including the notify and script schedules
 * that never touch MCP. Past this deadline the connect continues in the
 * background and the tick starts without it.
 */
const MCP_STARTUP_GRACE_MS = 20_000;

/**
 * Rebuild this process's MCP connections whenever the daemon reports a reload.
 *
 * Watches the signals directory rather than config.json: a reload also follows
 * an OAuth reauthentication and a plugin install, neither of which edits that
 * file, and the daemon already funnels all of them through one reload that
 * writes this signal. Restarts are serialized and coalesced, so a burst of
 * writes (an editor saving config.json, several servers reauthenticating)
 * rebuilds once rather than once per event.
 *
 * Never throws: a signals directory that cannot be watched leaves this process
 * on the servers it connected at startup, which is where it already was.
 */
function watchForMcpReload(): void {
  const signalsDir = getSignalsDir();
  let restarting: Promise<unknown> | null = null;
  let restartQueued = false;

  const restart = (): void => {
    if (restarting) {
      // A reload landed mid-rebuild, so the rebuild in flight may have read
      // the config as it stood before. Run once more after it, not once per
      // event that arrived while it ran.
      restartQueued = true;
      return;
    }
    restarting = restartConfiguredMcpServers()
      .then((toolCount) => {
        log.info({ toolCount }, "MCP servers reloaded in schedule worker");
      })
      .catch((err: unknown) => {
        log.warn({ err }, "MCP reload failed in schedule worker");
      })
      .finally(() => {
        restarting = null;
        if (restartQueued) {
          restartQueued = false;
          restart();
        }
      });
  };

  try {
    const watcher = watch(signalsDir, (_eventType, filename) => {
      if (String(filename ?? "") === MCP_RELOAD_SIGNAL_FILE) {
        restart();
      }
    });
    watcher.on("error", (err) => {
      log.warn({ err, signalsDir }, "MCP reload watcher failed");
    });
    watcher.unref();
    log.info({ dir: signalsDir }, "Watching for MCP reload signals");
  } catch (err) {
    log.warn(
      { err, signalsDir },
      "Failed to watch for MCP reload signals; MCP servers stay as connected at startup",
    );
  }
}

async function main(): Promise<void> {
  // Only the daemon stamps SSE seqs and writes the shared reservation file.
  disableStreamSeqStamping();
  // Load config up front so a broken config fails the spawn (before the PID
  // file is written) instead of surfacing on the first tick.
  getConfig();
  const pidPath = getScheduleWorkerPidPath();

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info({ pid: process.pid, pidPath }, "Schedule worker process started");

  // The override cache is per-process, so this worker has to populate its own
  // even though the daemon already populated the daemon's. Without it every
  // flag check here resolves to its registry default and ignores both remote
  // values and local overrides, which decides at fire time whether a schedule
  // runs at all. Awaited so the first tick reads real values, and best-effort:
  // a gateway that never answers leaves the cache unset and the worker falls
  // back to registry defaults rather than failing to start.
  // Bounded to one short attempt: a gateway that accepts the socket but never
  // answers would otherwise hold the first tick for the full production retry
  // schedule. A miss here leaves the cache unset (registry defaults) and the
  // periodic refresh below converges to real values within a minute.
  try {
    await initFeatureFlagOverrides({
      retryBackoffsMs: [],
      callTimeoutMs: 2_000,
    });
  } catch (err) {
    log.warn(
      { err },
      "Failed to load feature flag overrides in schedule worker; continuing on registry defaults",
    );
  }

  // Rehydrate the platform base URL and IDs from the credential store before
  // the first tick. The daemon does this in initializeProvidersAndTools(); this
  // standalone process must do it itself so getPlatformBaseUrl() resolves to
  // the persisted platform environment instead of the VELLUM_ENVIRONMENT
  // default — otherwise valid credentials are sent to the wrong platform and
  // rejected for both inference and background-wake requests.
  await rehydratePlatformCredentials();

  // This process is the sole runner of schedule execution and hosts real agent
  // conversations (wake, execute, and workflow modes), so it needs the default
  // plugins' hooks and injectors just like the daemon.
  registerWorkerPluginSurface();

  // Populate the tool registry (core built-ins + workspace tools). The daemon
  // does this at startup; this standalone process has to do it itself so
  // workflow schedules pass the core-tools readiness gate and agent-executed
  // schedules run with their tools. Best-effort — a tool-registry failure
  // must not take the worker down with it.
  try {
    await initializeTools();
  } catch (err) {
    log.warn(
      { err },
      "Failed to initialize tools in schedule worker; continuing degraded",
    );
  }

  // Connect this process's own MCP servers. The tool registry is per-process
  // and MCP tools reach it only by connecting to each server and listing what
  // it offers, so `initializeTools()` above leaves them out: it loads core
  // built-ins and workspace tools from disk and nothing else. Without this an
  // execute-mode schedule fails every `mcp__*` call as "Unknown tool" while the
  // daemon, which does connect at boot, lists the same tool as registered.
  //
  // Connecting here rather than borrowing the daemon's connections is what
  // keeps this process independent of the daemon's event loop, which is the
  // reason it is a separate process at all.
  //
  // Bounded by MCP_STARTUP_GRACE_MS: unreachable servers must not hold the
  // schedules that do not use them. The connect runs on past the deadline.
  const mcpStartup = startConfiguredMcpServers(getConfig().mcp);
  await Promise.race([
    mcpStartup,
    // Unref'd so a connect that beats the deadline leaves nothing pending.
    new Promise((resolve) => {
      setTimeout(resolve, MCP_STARTUP_GRACE_MS).unref();
    }),
  ]);

  // React to an MCP reload in the daemon. The server set belongs to the config
  // and the daemon owns the watcher that notices it change; this process holds
  // its own connections to the same servers, so without this it keeps serving
  // whatever was configured when it started, including servers since disabled
  // or removed. Best-effort: a signals directory that cannot be watched leaves
  // this process on its startup connections until it restarts.
  watchForMcpReload();

  // Sweep idle conversations out of the in-memory pool. The daemon starts
  // this at startup; this process hosts conversations too, so without it
  // every scheduled run's conversation is retained for the process lifetime.
  startConversationEvictor();

  let stopped = false;
  let tickRunning = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flagRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let disposePidGuard: (() => void) | null = null;
  const shutdown = (signal: string) => {
    log.info({ signal }, "Schedule worker process shutting down");
    stopped = true;
    if (timer != null) {
      clearInterval(timer);
    }
    if (flagRefreshTimer != null) {
      clearInterval(flagRefreshTimer);
    }
    disposePidGuard?.();
    // Best-effort, deliberately not awaited: this process exits immediately on
    // a signal by design, and the exit is what everything else here relies on.
    // Starting the close still lets a stdio server see its stdin shut rather
    // than only noticing when the pipe breaks.
    void stopMcpServerManager().catch((err) => {
      log.warn({ err }, "MCP server shutdown failed (non-fatal)");
    });
    cleanupWorkerPidFile(pidPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Arm the identity guard before the first tick. Its on-arm check runs
  // synchronously, so a worker superseded during startup runs shutdown() —
  // which calls process.exit — here, before it can execute any schedule work.
  disposePidGuard = startWorkerPidFileGuard(pidPath, {
    onEvicted: (reason) => {
      log.warn(
        { reason },
        "Evicted — the PID file no longer names this worker",
      );
      shutdown("pid-file-eviction");
    },
  });

  const tick = async () => {
    if (stopped || tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      const result = await runDueSchedulesOnce();
      const processed = result.completed + result.failed + result.skipped;
      if (processed > 0) {
        log.info({ processed }, "Schedule worker tick complete");
      }
    } catch (err) {
      log.error({ err }, "Schedule worker tick failed");
    } finally {
      tickRunning = false;
    }
  };

  // Deliberately ref'd (unlike the daemon scheduler's timer): this interval
  // is what keeps the standalone process alive between ticks.
  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  void tick();

  // This process outlives any single flag value, so poll the gateway instead of
  // holding whatever was cached at startup. The daemon's gateway flag listener
  // is not reusable here: it also reconciles managed profiles and broadcasts
  // sync events, both of which belong to the daemon alone. The refresh swaps the
  // cache atomically, so a tick reading a flag mid-refresh still sees the last
  // known values. Unref'd so the tick interval above stays the one thing
  // keeping this process alive.
  flagRefreshTimer = setInterval(() => {
    void refreshOverridesFromGateway().catch((err) => {
      log.warn({ err }, "Failed to refresh feature flag overrides");
    });
  }, FLAG_REFRESH_INTERVAL_MS);
  flagRefreshTimer.unref();

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

  // Catch stray exceptions that escape the tick loop so they produce a clean
  // pino-formatted log entry (and PID-file cleanup) instead of a raw stack
  // trace on stderr. The stderr fd is already piped to the log file by the
  // spawner, so even without these handlers the trace would be captured —
  // but this gives us structured logging and graceful shutdown.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in schedule worker process");
    cleanupWorkerPidFile(getScheduleWorkerPidPath());
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in schedule worker process");
    cleanupWorkerPidFile(getScheduleWorkerPidPath());
    process.exit(1);
  });

  // Clean up if the process exits unexpectedly through any other path.
  process.on("exit", () => {
    stopped = true;
    if (timer != null) {
      clearInterval(timer);
    }
    if (flagRefreshTimer != null) {
      clearInterval(flagRefreshTimer);
    }
    cleanupWorkerPidFile(getScheduleWorkerPidPath());
  });
}

void main().catch((err) => {
  log.error({ err }, "Schedule worker process failed to start");
  cleanupWorkerPidFile(getScheduleWorkerPidPath());
  process.exit(1);
});
