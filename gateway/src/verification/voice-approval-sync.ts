/**
 * Gateway-side polling loop for voice access request approval activation.
 *
 * When a guardian approves an inbound phone access request, the relay server
 * detects the approval and continues the call. The gateway needs to independently
 * detect the same event and activate the caller as a trusted contact — without
 * relying on the assistant to signal it (the assistant is potentially
 * prompt-injected and must never trigger contact/trust-graph writes).
 *
 * This poller queries the assistant's canonical_guardian_requests table via the
 * db_proxy IPC route, looking for recently approved phone access requests, and
 * calls upsertVerifiedContactChannel for any that are not yet active in the
 * gateway DB.
 *
 * Long-term: when canonical_guardian_requests migrates to the gateway DB
 * (ATL-463), this poller will query the gateway DB directly and the IPC
 * dependency will be removed.
 */

import { existsSync } from "node:fs";

import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import { upsertVerifiedContactChannel } from "./contact-helpers.js";

const log = getLogger("voice-approval-sync");

const POLL_INTERVAL_MS = 5_000;

// On startup, catch up approvals from the last 24 hours so nothing is missed
// across gateway restarts.
const STARTUP_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

interface DbProxyResult {
  rows?: Array<Record<string, unknown>>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastSyncAt = 0;

export function startVoiceApprovalSync(): void {
  if (timer) return;
  lastSyncAt = Date.now() - STARTUP_LOOKBACK_MS;
  timer = setInterval(() => {
    void syncVoiceApprovals().catch((err: unknown) => {
      log.warn({ err }, "Voice approval sync error");
    });
  }, POLL_INTERVAL_MS);
  log.info("Voice approval sync started");
}

export function stopVoiceApprovalSync(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("Voice approval sync stopped");
}

async function syncVoiceApprovals(): Promise<void> {
  const { path: socketPath } = resolveIpcSocketPath("assistant");
  if (!existsSync(socketPath)) return;

  const since = lastSyncAt;
  const now = Date.now();

  const result = (await ipcCallAssistant("db_proxy", {
    sql: `SELECT requester_external_user_id, requester_chat_id
          FROM canonical_guardian_requests
          WHERE kind = 'access_request'
            AND source_channel = 'phone'
            AND status = 'approved'
            AND updated_at > ?`,
    mode: "query",
    bind: [since],
  })) as DbProxyResult;

  if (!result.rows?.length) {
    lastSyncAt = now;
    return;
  }

  log.info(
    { count: result.rows.length, since },
    "Voice approval sync: found approved access requests",
  );

  for (const row of result.rows) {
    const fromNumber = row.requester_external_user_id as string | null;
    if (!fromNumber) continue;

    const chatId = (row.requester_chat_id as string | null) ?? fromNumber;

    try {
      await upsertVerifiedContactChannel({
        sourceChannel: "phone",
        externalUserId: fromNumber,
        externalChatId: chatId,
      });
      log.info({ fromNumber }, "Voice approval sync: contact activated");
    } catch (err) {
      log.warn({ err, fromNumber }, "Voice approval sync: upsert failed");
    }
  }

  lastSyncAt = now;
}
