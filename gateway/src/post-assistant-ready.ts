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
 * The assistant now runs its own DB migrations asynchronously during startup,
 * so "reachable" is not "ready": the `health` route answers (it is exempt from
 * the assistant's migration-readiness gate) while the schema is still being
 * built. We therefore wait until `health` reports migrations ready before
 * running the guardian-binding backfill / data migrations / voice syncs — all
 * of which write to assistant tables over IPC and would otherwise hit a
 * "no such table" error on a warm-pool claim.
 */

import type { Database } from "bun:sqlite";

import { ensureVellumGuardianBinding } from "./auth/guardian-bootstrap.js";
import { getGatewayDb, type GatewayDb } from "./db/connection.js";
import { runDataMigrations } from "./db/data-migrations/index.js";
import { IpcTransportError, ipcCallAssistant } from "./ipc/assistant-client.js";
import { getLogger } from "./logger.js";
import { startOutboundVoiceVerificationSync } from "./verification/outbound-voice-verification-sync.js";
import { startVoiceApprovalSync } from "./verification/voice-approval-sync.js";

const log = getLogger("post-assistant-ready");

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

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
 * Wait for the assistant runtime to become healthy, then run deferred
 * startup tasks.
 */
export async function runPostAssistantReady(): Promise<void> {
  const ready = await waitForAssistant();
  if (!ready) return;

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

  // 3. Voice verification syncs — these poll the assistant DB via IPC,
  // so they must start after the assistant is confirmed ready.
  startVoiceApprovalSync();
  startOutboundVoiceVerificationSync();
}
