/**
 * Gateway-side polling loop for outbound voice verification session completion.
 *
 * When the assistant places an outbound call for guardian phone verification,
 * the relay server handles DTMF collection and consumes the verification session.
 * However, the assistant process must never write to the contact/trust graph
 * (it is potentially prompt-injected), so no guardian binding is created there.
 *
 * This poller detects consumed outbound phone guardian sessions and creates the
 * binding on behalf of the gateway — the same binding that the inbound path
 * creates via twilio-voice-verify-callback.ts.
 *
 * Long-term: when channel_verification_sessions migrates fully to the gateway DB,
 * this poller will query the gateway DB directly and the IPC dependency
 * will be removed. The cursor is intentionally in-memory because of that
 * migration on the horizon — a persisted table would just be carry-cost.
 *
 * Replay protection (ATL-514). The poller's lookback window can include
 * sessions that were consumed legitimately at the time but have since been
 * superseded by manual revocation or a sibling binding path (e.g. inbound
 * voice verification). `createPhoneGuardianBinding` enforces a recency check
 * vs `contact_channels`: a consumed session whose `updated_at` is older
 * than the most recent guardian binding event (active OR revoked) for the
 * channel is rejected as stale. This is the security-critical guarantee;
 * the in-memory cursor is just a polling optimization.
 */

import { existsSync } from "node:fs";

import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { noteIpcReachable, noteIpcTransportError } from "../ipc/ipc-health.js";
import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import { createPhoneGuardianBinding } from "./session-service.js";

// The binding logic (ATL-514 recency check, deliberate-rebind semantics)
// moved to the session service, which now also applies it synchronously at
// consume time via verification_sessions_validate_consume. Re-exported here
// for this module's tests until the poller is deleted.
export { createPhoneGuardianBinding };

const log = getLogger("outbound-voice-verification-sync");

const POLL_INTERVAL_MS = 5_000;

// On startup, catch up any sessions consumed within the last 24 hours so
// nothing is missed across gateway restarts. The recency check inside
// createPhoneGuardianBinding rejects any session in that window that has
// been superseded since.
const STARTUP_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

interface DbProxyResult {
  rows?: Array<Record<string, unknown>>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastSyncAt = 0;

export function startOutboundVoiceVerificationSync(): void {
  if (timer) return;
  lastSyncAt = Date.now() - STARTUP_LOOKBACK_MS;
  timer = setInterval(() => {
    void syncOutboundVoiceVerifications().catch((err: unknown) => {
      // Assistant-down timeouts are collapsed into a single shared down/up
      // signal by the health tracker; only log errors it does not own.
      if (noteIpcTransportError(err, "outbound-voice-verification-sync"))
        return;
      log.warn({ err }, "Outbound voice verification sync error");
    });
  }, POLL_INTERVAL_MS);
  log.info("Outbound voice verification sync started");
}

export function stopOutboundVoiceVerificationSync(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("Outbound voice verification sync stopped");
}

async function syncOutboundVoiceVerifications(): Promise<void> {
  const { path: socketPath } = resolveIpcSocketPath("assistant");
  if (!existsSync(socketPath)) return;

  const since = lastSyncAt;
  const now = Date.now();

  // Outbound guardian sessions have expected_phone_e164 set (populated by
  // startOutboundVoice). We filter by verification_purpose = 'guardian' to
  // skip trusted-contact sessions, which have their own activation path.
  //
  // ORDER BY updated_at DESC + process-first-and-break: the single-guardian
  // invariant means there is exactly one active phone binding at a time, so
  // only the most recent verification matters. Older rows in the same batch
  // (e.g. from the 24h startup lookback) are obsolete — processing them
  // would just churn through superseded rebinds before landing on the same
  // final state.
  const result = (await ipcCallAssistant("db_proxy", {
    sql: `SELECT consumed_by_external_user_id, consumed_by_chat_id, updated_at
          FROM channel_verification_sessions
          WHERE channel = 'phone'
            AND status = 'consumed'
            AND verification_purpose = 'guardian'
            AND expected_phone_e164 IS NOT NULL
            AND updated_at > ?
          ORDER BY updated_at DESC
          LIMIT 1`,
    mode: "query",
    bind: [since],
  })) as DbProxyResult;

  // The call returned, so the assistant IPC channel is reachable — clears any
  // outstanding "down" state and logs the single recovery line.
  noteIpcReachable();

  const row = result.rows?.[0];
  if (!row) {
    // No rows in [since, now]. Advance cursor to `now` — no race possible
    // when there is nothing to miss.
    lastSyncAt = now;
    return;
  }

  const phoneNumber = row.consumed_by_external_user_id as string | null;
  const sessionUpdatedAt = row.updated_at as number | null;
  if (!phoneNumber || sessionUpdatedAt == null) {
    log.warn(
      "Outbound voice verification sync: newest row missing phone or updated_at; advancing cursor",
    );
    lastSyncAt = now;
    return;
  }

  const chatId = (row.consumed_by_chat_id as string | null) ?? phoneNumber;

  try {
    await createPhoneGuardianBinding(phoneNumber, chatId, sessionUpdatedAt);
    // Advance cursor to the processed row's updated_at — NOT wall-clock now.
    // If another session was consumed concurrently with updated_at <= now
    // (same-ms timestamps are sufficient), advancing to `now` would skip it
    // on the next pass. Advancing to sessionUpdatedAt keeps the strict-`>`
    // filter inclusive of any sibling row at or after this timestamp.
    lastSyncAt = sessionUpdatedAt;
  } catch (err) {
    log.warn(
      { err, phoneNumber },
      "Outbound voice verification sync: binding creation failed; will retry next poll",
    );
    // Leave lastSyncAt at `since` so the row is re-queried next pass.
    // createPhoneGuardianBinding is idempotent on retry.
  }
}

