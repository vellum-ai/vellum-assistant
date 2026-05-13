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
 * is ready, runs data migrations and other deferred tasks. It is awaited
 * during startup — the HTTP server does not start until this completes,
 * preventing auth traffic from racing with data migrations.
 */

import type { Database } from "bun:sqlite";

import { ensureVellumGuardianBinding } from "./auth/guardian-bootstrap.js";
import { getGatewayDb, type GatewayDb } from "./db/connection.js";
import { runDataMigrations } from "./db/data-migrations/index.js";
import {
  IpcTransportError,
  ipcCallAssistant,
} from "./ipc/assistant-client.js";
import { getLogger } from "./logger.js";

const log = getLogger("post-assistant-ready");

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

function getRawDb(drizzleDb: GatewayDb): Database {
  return (drizzleDb as unknown as { $client: Database }).$client;
}

export async function waitForAssistant(): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      await ipcCallAssistant("health");
      log.info("Assistant is ready");
      return true;
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
 * startup tasks. Awaited at startup — blocks Bun.serve().
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
}
