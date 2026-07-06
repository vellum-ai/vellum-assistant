import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  getDaemonPidPath,
  resolveTargetAssistant,
  saveAssistantEntry,
} from "../lib/assistant-config.js";
import { dockerResourceNames, wakeContainers } from "../lib/docker.js";
import {
  leaseGuardianToken,
  resetGuardianBootstrap,
  seedGuardianTokenFromSiblingEnv,
} from "../lib/guardian-token.js";
import {
  probeDaemonReadinessWithRetry,
  waitForDaemonMigrationsReady,
} from "../lib/http-client.js";
import {
  isProcessAlive,
  resolveProcessState,
  stopProcessByPidFile,
} from "../lib/process";
import {
  generateLocalSigningKey,
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
  startCes,
  startLocalDaemon,
  startGateway,
} from "../lib/local";
import { maybeStartNgrokTunnel } from "../lib/ngrok";

export async function wake(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum wake [<name>] [options]");
    console.log("");
    console.log("Start the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to start (default: active or only local)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
    );
    console.log(
      "  --foreground   Run assistant in foreground with logs printed to terminal",
    );
    console.log(
      "  --repair-guardian  Force-re-provision the guardian token (resets the\n" +
        "                     gateway bootstrap and re-leases — REVOKES other device-bound\n" +
        "                     tokens, so only use deliberately, never from auto-repair)",
    );
    process.exit(0);
  }

  const watch = args.includes("--watch");
  const foreground = args.includes("--foreground");
  // Re-leasing the guardian token calls guardian/init, which revokes every
  // other device-bound token (other tabs, other local clients on this machine).
  // Gate it behind an explicit flag so the automatic connect-repair path
  // (`runWake` spawns `wake <id>` with no flags) can never revoke a live session
  // — it only ever restarts + sibling-seeds. A genuine spent-bootstrap brick is
  // recovered deliberately via `vellum wake <id> --repair-guardian`.
  const repairGuardian = args.includes("--repair-guardian");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    if (watch || foreground) {
      const ignored = [watch && "--watch", foreground && "--foreground"]
        .filter(Boolean)
        .join(" and ");
      console.warn(
        `Warning: ${ignored} ignored for Docker instances (not supported).`,
      );
    }
    const res = dockerResourceNames(entry.assistantId);
    await wakeContainers(res);
    console.log("Docker containers started.");
    console.log("Wake complete.");
    return;
  }

  if (entry.cloud === "apple-container") {
    console.error(
      `Error: '${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to start it.`,
    );
    process.exit(1);
  }

  if (entry.cloud === "paired") {
    console.error(
      `Error: '${entry.assistantId}' is a remote assistant paired from another machine — its lifecycle is managed on its host machine, not here. Use \`vellum client ${entry.assistantId}\` to chat with it.`,
    );
    process.exit(1);
  }

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum wake' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  if (!entry.resources) {
    console.error(
      `Error: Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
    process.exit(1);
  }
  const resources = entry.resources;

  const pidFile = getDaemonPidPath(resources);

  // Budget anchor for the migration-coordination wait below: the host
  // wrapper (packages/local-mode/src/wake.ts WAKE_TIMEOUT_MS) SIGTERMs wake
  // after 180s, and the hung-daemon health wait + post-spawn wait + gateway
  // start can already consume most of that.
  const wakeStartedAt = Date.now();

  let daemonRunning = false;
  let daemonUnready = false;
  let daemonMigrationsFailed = false;
  const daemonState = await resolveProcessState(
    pidFile,
    resources.daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    if (watch && isAssistantWatchModeAvailable()) {
      console.log(
        `Assistant running (pid ${daemonState.pid}) — restarting in watch mode...`,
      );
      await stopProcessByPidFile(pidFile, "assistant");
    } else {
      daemonRunning = true;
      daemonUnready = daemonState.status !== "healthy";
      daemonMigrationsFailed = daemonState.status === "migration_failed";
      if (watch) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — watch mode not available (no source files). Keeping existing process.`,
        );
      } else if (daemonMigrationsFailed) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) but its database migrations failed.`,
        );
      } else if (daemonUnready) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — database migrations still running.`,
        );
      } else {
        console.log(`Assistant already running (pid ${daemonState.pid}).`);
      }
    }
  }

  // Resolve the signing key. The gateway persists its own copy to disk at
  // <instanceDir>/.vellum/protected/actor-token-signing-key. That on-disk key
  // is the source of truth because it is what the gateway actually used to sign
  // existing actor tokens. Prefer it over the lockfile value so that tokens
  // survive upgrades and any scenario where the two diverge.
  //
  // NOTE: Removal of this legacy key path read is blocked on removing all use
  // of the signing key from the assistant daemon. Until then, the on-disk key
  // must remain the authoritative source.
  const legacyKeyPath = join(
    resources.instanceDir,
    ".vellum",
    "protected",
    "actor-token-signing-key",
  );
  let signingKey: string | undefined;
  if (existsSync(legacyKeyPath)) {
    try {
      const raw = readFileSync(legacyKeyPath);
      if (raw.length === 32) {
        signingKey = raw.toString("hex");
      }
    } catch {
      // Ignore — fall through to lockfile or generate.
    }
  }
  if (!signingKey) {
    signingKey = resources.signingKey ?? generateLocalSigningKey();
  }
  if (signingKey !== resources.signingKey) {
    entry.resources = { ...resources, signingKey };
    saveAssistantEntry(entry);
  }

  let bootstrapSecret = entry.guardianBootstrapSecret;
  let bootstrapSecretBackfilled = false;
  if (!bootstrapSecret) {
    bootstrapSecret = generateLocalSigningKey();
    entry.guardianBootstrapSecret = bootstrapSecret;
    saveAssistantEntry(entry);
    bootstrapSecretBackfilled = true;
  }

  if (!daemonRunning) {
    // Spin up CES and the daemon in parallel, the way the Docker topology
    // brings its sibling containers up together — the assistant polls for the
    // CES socket during startup (discoverCesWithRetry), so it tolerates CES
    // still binding. CES's lifecycle tracks the daemon (its only consumer):
    // restarting it under a live daemon would sever the daemon's open
    // connection, so it is only (re)started alongside the daemon. startCes is a
    // no-op unless CES_STANDALONE is set, in which case the assistant spawns
    // CES itself as today.
    await Promise.all([
      startCes(watch, resources),
      startLocalDaemon(watch, resources, { foreground, signingKey }),
    ]);
    // startLocalDaemon's post-spawn wait is bounded (60s) — a longer
    // migration outlives it. Classify the fresh spawn the same way the
    // attach path does, so the gateway-coordination wait below applies to
    // both paths and wake's closing summary stays honest.
    const readiness = await probeDaemonReadinessWithRetry(resources.daemonPort);
    daemonUnready = readiness === "migrating";
    daemonMigrationsFailed = readiness === "failed";
  } else {
    // Self-heal: the daemon is already healthy, but the CES sibling may have
    // died independently (crash, OOM kill). A dead ces.pid under a live daemon
    // means credential operations will fail until the next wake. Relaunch the
    // sibling so the daemon's lazy reconnect (secure-keys.ts) picks it up on
    // the next credential read. startCes is a no-op unless CES_STANDALONE.
    const vellumDir = join(resources.instanceDir, ".vellum");
    const cesPidFile = join(vellumDir, "ces.pid");
    const cesAlive = isProcessAlive(cesPidFile).alive;
    if (!cesAlive) {
      console.log("CES sibling not running — relaunching...");
      await startCes(watch, resources);
    }
  }

  // Start gateway
  let gatewayStarted = false;
  {
    const vellumDir = join(resources.instanceDir, ".vellum");
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const gatewayState = await resolveProcessState(
      gatewayPidFile,
      resources.gatewayPort,
      "Gateway",
    );
    const gatewayAlive = gatewayState.status === "healthy";
    const needsRestart = bootstrapSecretBackfilled && gatewayAlive;
    if (needsRestart) {
      const restartWithWatch = watch && isGatewayWatchModeAvailable();
      if (restartWithWatch) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting to apply bootstrap secret...`,
        );
      } else {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting without watch mode to apply bootstrap secret...`,
        );
      }
      await stopProcessByPidFile(gatewayPidFile, "gateway");
      await startGateway(restartWithWatch, resources, {
        signingKey,
        bootstrapSecret,
      });
      gatewayStarted = true;
    } else if (gatewayAlive) {
      if (watch && isGatewayWatchModeAvailable()) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting in watch mode...`,
        );
        await stopProcessByPidFile(gatewayPidFile, "gateway");
        await startGateway(watch, resources, { signingKey, bootstrapSecret });
        gatewayStarted = true;
      } else {
        if (watch) {
          console.log(
            `Gateway running (pid ${gatewayState.pid}) — watch mode not available (no source files). Keeping existing process.`,
          );
        } else {
          console.log(`Gateway already running (pid ${gatewayState.pid}).`);
        }
      }
    } else {
      await startGateway(watch, resources, { signingKey, bootstrapSecret });
      gatewayStarted = true;
    }
  }

  // A freshly-(re)started gateway refuses all non-probe traffic until the
  // daemon reports migration readiness, so consumers that act right after
  // wake (the web connect-repair retry, the guardian re-provision below)
  // would hit its closed gate. When the daemon is migrating AND the gateway
  // was just started (or a guardian repair was requested), wait out the
  // migration — capped at 60s and at whatever budget remains before the
  // 180s host-wrapper SIGTERM (30s headroom kept), since earlier bounded
  // waits may already have consumed most of it. Fast path (gateway already
  // serving, no repair) stays ~1s.
  if (
    daemonUnready &&
    !daemonMigrationsFailed &&
    (gatewayStarted || repairGuardian)
  ) {
    const waitBudgetMs = Math.min(60_000, wakeStartedAt + 150_000 - Date.now());
    if (waitBudgetMs > 0) {
      const readiness = await waitForDaemonMigrationsReady(
        resources.daemonPort,
        Date.now() + waitBudgetMs,
      );
      daemonUnready = readiness !== "ready";
      daemonMigrationsFailed = readiness === "failed";
    }
  }

  // Self-heal the guardian token when the current environment's config dir
  // is missing it. Hatch cross-writes the lockfile across env dirs but the
  // guardian token is only persisted under the hatch-time env, so a desktop
  // app built under a different VELLUM_ENVIRONMENT can't find a bearer and
  // cascades into 401 → auth-rate-limit → 429. A sibling env copy is cheap
  // and strictly additive.
  if (seedGuardianTokenFromSiblingEnv(entry.assistantId)) {
    console.log("   Seeded guardian token from sibling environment.");
  }

  // Last-resort recovery (explicit `--repair-guardian` only): force a
  // re-provision. Token health can't be judged locally — a connect can 401
  // off a token whose local expiry looks fine (revoked, mis-seeded, wrong
  // principal) — and the user explicitly confirmed the destructive repair,
  // so guessing "looks healthy, skip" just recreates the no-op loop. The
  // single-use bootstrap secret may already be spent — a prior connect can
  // lease a token that's then lost, or the gateway marks the secret consumed
  // before the client persists it — which otherwise bricks connect into a
  // 401 → auth-rate-limit → 429 cascade with no path back short of retire+hatch.
  // Reset the gateway's bootstrap lock+consumed state (loopback-only, authorized
  // by the lockfile secret — mirrors the macOS client's forceReBootstrap), then
  // re-lease. Gated behind the flag because the re-lease revokes other
  // device-bound tokens; it must never run from the automatic repair path.
  if (repairGuardian) {
    const loopbackUrl = `http://127.0.0.1:${resources.gatewayPort}`;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await resetGuardianBootstrap(loopbackUrl, bootstrapSecret);
        await leaseGuardianToken(
          loopbackUrl,
          entry.assistantId,
          bootstrapSecret,
        );
        console.log("   Re-provisioned guardian token.");
        break;
      } catch (err) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
        } else {
          console.warn(
            `   Guardian token re-provision failed after ${maxAttempts} attempts: ${err}`,
          );
          // The user explicitly confirmed this destructive repair — a
          // success exit here would make callers (the web recovery flow)
          // treat a repair that never ran as done and drop their cached
          // gateway token. Surface the failure through the exit code.
          process.exitCode = 1;
        }
      }
    }
  }

  // Auto-start ngrok if webhook integrations (e.g. Telegram) are configured.
  const workspaceDir = join(resources.instanceDir, ".vellum", "workspace");
  const ngrokChild = await maybeStartNgrokTunnel(
    resources.gatewayPort,
    workspaceDir,
  );
  if (ngrokChild?.pid) {
    const ngrokPidFile = join(resources.instanceDir, ".vellum", "ngrok.pid");
    writeFileSync(ngrokPidFile, String(ngrokChild.pid));
  }

  if (daemonMigrationsFailed) {
    console.log(
      "Assistant database migrations FAILED — DB-backed routes will return 503 until the assistant is restarted. Check the daemon logs.",
    );
  } else if (daemonUnready) {
    console.log(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
  }
  console.log("Wake complete.");

  if (foreground) {
    console.log("Running in foreground (Ctrl+C to stop)...\n");
    // Block forever — the daemon is running with inherited stdio so its
    // output streams to this terminal. When the user hits Ctrl+C, SIGINT
    // propagates to the daemon child and both exit.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        resolve();
      });
      process.on("SIGTERM", () => resolve());
    });
  }
}
