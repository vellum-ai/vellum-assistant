/**
 * Post-assistant-ready lifecycle.
 *
 * The gateway and assistant containers start concurrently. Several gateway
 * startup tasks depend on the assistant's SQLite database existing (e.g.
 * guardian binding backfill, data migrations that read/write assistant
 * tables). When the gateway starts first, these tasks fail because the
 * assistant DB doesn't exist yet.
 *
 * This module polls the assistant IPC health route and, once the assistant
 * is ready, runs data migrations and other deferred tasks. The gateway keeps
 * readiness and regular traffic closed until this completes, preventing auth
 * traffic from racing with data migrations.
 *
 * The assistant runs its own DB migrations asynchronously during startup, so
 * "reachable" is not "ready": the `health` route answers (it is exempt from
 * the assistant's migration-readiness gate) while the schema is still being
 * built. The deferred tasks therefore wait until `health` reports migrations
 * ready — they all write to assistant tables over IPC and would otherwise hit
 * a "no such table" error on a warm-pool claim.
 *
 * The initial wait is bounded ({@link MAX_WAIT_MS}) so the gateway never holds
 * its traffic gate closed indefinitely — but timing out must not skip the
 * deferred tasks for the process lifetime. A successful migration can
 * legitimately outlast the wait (large DBs are exactly the case async
 * migrations exist for), and a failed-migration assistant can be repaired by
 * a container restart. On timeout the gateway opens traffic and keeps polling
 * in the background, running the deferred tasks once — whenever the assistant
 * finally reports migrations ready.
 */

import type { Database } from "bun:sqlite";

import { ensureVellumGuardianBinding } from "./auth/guardian-bootstrap.js";
import { getGatewayDb, type GatewayDb } from "./db/connection.js";
import { runDataMigrations } from "./db/data-migrations/index.js";
import { IpcTransportError, ipcCallAssistant } from "./ipc/assistant-client.js";
import { getLogger } from "./logger.js";
import { startOutboundVoiceVerificationSync } from "./verification/outbound-voice-verification-sync.js";

const log = getLogger("post-assistant-ready");

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes
/** Background poll cadence after the bounded startup wait has timed out. */
const DEFERRED_RETRY_INTERVAL_MS = 30_000;

function getRawDb(drizzleDb: GatewayDb): Database {
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/**
 * Shape of the assistant `health` response we care about. `dbMigrations` is
 * present only while migrations are NOT ready (running/not_started/failed); a
 * healthy response omits it. See assistant `getDetailedHealth`.
 */
export interface AssistantHealth {
  status?: string;
  dbMigrations?: { ready?: boolean; state?: string };
}

/**
 * Whether a `health` response indicates DB migrations have finished. A
 * successful call only means the assistant is reachable — the `health` method
 * is exempt from the assistant's migration-readiness gate, so it answers while
 * the schema is still being built. `dbMigrations` is absent on a healthy
 * response and carries `ready: false` while still migrating/failed.
 */
export function assistantReportsMigrationsReady(
  health: AssistantHealth | null | undefined,
): boolean {
  return (
    health?.dbMigrations === undefined || health.dbMigrations.ready === true
  );
}

export async function waitForAssistant(): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const health = (await ipcCallAssistant("health")) as AssistantHealth;
      if (assistantReportsMigrationsReady(health)) {
        log.info("Assistant is ready");
        return true;
      }
      log.info(
        { state: health.dbMigrations?.state },
        "Assistant reachable but DB migrations not ready — waiting",
      );
    } catch (err) {
      if (!(err instanceof IpcTransportError)) throw err;
      // Transport error during startup is expected — keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  log.error(
    { maxWaitMs: MAX_WAIT_MS },
    "Timed out waiting for assistant to become ready",
  );
  return false;
}

/**
 * Whether {@link runDeferredTasks} has run. The tasks are one-shot per
 * process: the happy path and the background retry path must never both
 * execute them.
 */
let deferredTasksRan = false;

/** Test-only: allow re-running the one-shot deferred tasks. */
export function resetPostAssistantReadyForTest(): void {
  deferredTasksRan = false;
}

/**
 * The deferred startup tasks that require a migration-ready assistant.
 * One-shot per process; repeat calls are no-ops.
 */
async function runDeferredTasks(): Promise<void> {
  if (deferredTasksRan) return;
  deferredTasksRan = true;

  // 1. Data migrations (some read/write the assistant DB)
  try {
    await runDataMigrations(getRawDb(getGatewayDb()));
  } catch (err) {
    log.error({ err }, "Post-ready data migrations failed");
  }

  // 2. Guardian binding backfill
  try {
    await ensureVellumGuardianBinding();
  } catch (err) {
    log.warn({ err }, "Post-ready guardian binding backfill failed");
  }

  // 3. Outbound voice verification sync — polls the assistant DB via IPC,
  // so it must start after the assistant is confirmed ready.
  startOutboundVoiceVerificationSync();
}

/**
 * Poll the assistant until it reports migrations ready, then run the deferred
 * tasks. Unbounded by design: it backs the post-timeout background path, where
 * giving up permanently is exactly the failure mode being fixed — a slow but
 * successful migration, or a failed one repaired by a later assistant
 * restart, must still get its data migrations, guardian backfill, and
 * outbound voice verification sync. All errors (including transport) are
 * swallowed so the loop survives an assistant that is down entirely.
 *
 * Exported for tests; production reaches it only via
 * {@link runPostAssistantReady}'s timeout path.
 */
export async function runDeferredTasksWhenAssistantReady(
  retryIntervalMs = DEFERRED_RETRY_INTERVAL_MS,
): Promise<void> {
  let loggedHandlerError = false;
  for (;;) {
    // Another path (or a concurrent poller) already ran the tasks — stop
    // polling instead of spinning until the assistant reports ready.
    if (deferredTasksRan) return;
    try {
      const health = (await ipcCallAssistant("health")) as AssistantHealth;
      if (assistantReportsMigrationsReady(health)) break;
    } catch (err) {
      // Transport errors are expected while the assistant is down — keep
      // polling silently. A handler-level error is a bug and must be
      // observable (the foreground wait crashes the gateway on the same
      // class); log the first occurrence, then keep polling.
      if (!(err instanceof IpcTransportError) && !loggedHandlerError) {
        loggedHandlerError = true;
        log.warn(
          { err },
          "Assistant health call failed with a handler error while polling for deferred post-ready tasks — continuing to poll",
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }

  if (deferredTasksRan) return;
  log.info(
    "Assistant became ready after gateway startup — running deferred post-ready tasks",
  );
  await runDeferredTasks();
}

/**
 * Wait for the assistant runtime to become migration-ready, then run the
 * deferred startup tasks. Returns after {@link MAX_WAIT_MS} even if the
 * assistant is not ready — the caller opens gateway traffic either way — but
 * in that case the deferred tasks keep retrying in the background instead of
 * being skipped for the process lifetime.
 */
export async function runPostAssistantReady(): Promise<void> {
  const ready = await waitForAssistant();
  if (!ready) {
    log.warn(
      { retryIntervalMs: DEFERRED_RETRY_INTERVAL_MS },
      "Opening gateway traffic without the assistant ready — deferred tasks (data migrations, guardian backfill, outbound voice verification sync) will run in the background once it reports ready",
    );
    void runDeferredTasksWhenAssistantReady().catch((err) => {
      log.error({ err }, "Background deferred post-ready tasks failed");
    });
    return;
  }

  await runDeferredTasks();
}
