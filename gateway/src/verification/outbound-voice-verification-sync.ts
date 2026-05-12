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
 * will be removed.
 *
 * Replay protection (two layers):
 *
 *   1. Durable cursor (`outbound_voice_verify_sync_cursor` table) — the
 *      poller's high-water `updated_at` survives restarts. Without it,
 *      every restart fell back to `now - 24h` and re-processed sessions
 *      that had been superseded since.
 *
 *   2. Recency check vs `contact_channels` — even when a session falls
 *      inside the lookback window, `createPhoneGuardianBinding` skips it
 *      if any guardian binding (active OR revoked) for the channel has a
 *      newer `updated_at`. This blocks reactivating a revoked binding and
 *      blocks displacing an active binding established via the inbound
 *      path. The cursor alone is insufficient — a backup restore, manual
 *      cursor delete, or first-ever start would re-expose the window.
 */

import { existsSync } from "node:fs";

import { eq } from "drizzle-orm";

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../db/connection.js";
import { outboundVoiceVerifySyncCursor } from "../db/schema.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import {
  getExistingGuardianBinding,
  getMostRecentChannelGuardianTimestamp,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";

const log = getLogger("outbound-voice-verification-sync");

const POLL_INTERVAL_MS = 5_000;

// On startup, catch up any sessions consumed within the last 24 hours so
// nothing is missed across gateway restarts. Acts only as a fallback when
// the durable cursor is missing (first-ever start or DB reset).
const STARTUP_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

const CURSOR_KEY = "global";

interface DbProxyResult {
  rows?: Array<Record<string, unknown>>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastSyncAt = 0;

export function startOutboundVoiceVerificationSync(): void {
  if (timer) return;
  lastSyncAt = loadCursor() ?? Date.now() - STARTUP_LOOKBACK_MS;
  timer = setInterval(() => {
    void syncOutboundVoiceVerifications().catch((err: unknown) => {
      log.warn({ err }, "Outbound voice verification sync error");
    });
  }, POLL_INTERVAL_MS);
  log.info({ lastSyncAt }, "Outbound voice verification sync started");
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
  // (e.g. from the startup lookback when the cursor is missing) are
  // obsolete — processing them would just churn through superseded rebinds
  // before landing on the same final state.
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

  const row = result.rows?.[0];
  if (!row) {
    advanceCursor(now);
    return;
  }

  const phoneNumber = row.consumed_by_external_user_id as string | null;
  const sessionUpdatedAt = row.updated_at as number | null;
  if (!phoneNumber || sessionUpdatedAt == null) {
    log.warn(
      "Outbound voice verification sync: newest row missing phone or updated_at; advancing cursor",
    );
    advanceCursor(now);
    return;
  }

  const chatId = (row.consumed_by_chat_id as string | null) ?? phoneNumber;

  try {
    await createPhoneGuardianBinding(phoneNumber, chatId, sessionUpdatedAt);
    advanceCursor(now);
  } catch (err) {
    log.warn(
      { err, phoneNumber },
      "Outbound voice verification sync: binding creation failed; will retry next poll",
    );
    // Leave the cursor at `since` so the row is re-queried next pass.
    // createPhoneGuardianBinding is idempotent on retry.
  }
}

export async function createPhoneGuardianBinding(
  phoneNumber: string,
  chatId: string,
  sessionUpdatedAt: number,
): Promise<void> {
  // Recency check (security backstop). The poller's lookback window can
  // include sessions that were consumed legitimately at the time but have
  // since been superseded — by manual revocation, or by a sibling binding
  // path (e.g. inbound verification). `getExistingGuardianBinding` only
  // checks active bindings, so without this guard we would reactivate a
  // revoked binding or revoke an active one in favor of a stale session.
  const lastBindingTs =
    await getMostRecentChannelGuardianTimestamp("phone");
  if (lastBindingTs != null && sessionUpdatedAt <= lastBindingTs) {
    log.warn(
      { phoneNumber, sessionUpdatedAt, lastBindingTs },
      "Outbound voice verification sync: session older than most recent binding event; skipping (replay-protection)",
    );
    return;
  }

  const canonicalPrincipal = await resolveCanonicalPrincipal(phoneNumber);
  const existingBinding = await getExistingGuardianBinding("phone");

  if (existingBinding) {
    if (existingBinding.externalUserId === phoneNumber) {
      // Idempotent — binding already exists for this number. With the
      // durable cursor in place this is rare, but can still happen when
      // the poller fires twice before the cursor advances.
      log.info(
        { phoneNumber },
        "Outbound voice verification sync: binding already exists, skipping",
      );
      return;
    }

    // A different number holds the phone guardian binding — revoke it first.
    //
    // This is an intentional behavioral difference from the inbound path
    // (twilio-voice-verify-callback.ts), which logs and skips on conflict.
    // Outbound calls are guardian-initiated by definition: only the trusted
    // guardian can command the assistant to dial a specific number with
    // expected_phone_e164 set. So an outbound code-redemption is always a
    // deliberate rebind. Inbound's conservative skip exists because anyone
    // could call in with a stolen code; outbound has no such attack surface.
    //
    // The recency check above ensures we only rebind when the consumed
    // session is newer than the current binding's last-touched timestamp.
    log.warn(
      { phoneNumber, existingGuardian: existingBinding.externalUserId },
      "Outbound voice verification sync: revoking conflicting phone guardian binding",
    );
    await revokeExistingChannelGuardian("phone");
  }

  await createGuardianBinding({
    channel: "phone",
    externalUserId: phoneNumber,
    deliveryChatId: chatId,
    guardianPrincipalId: canonicalPrincipal,
    verifiedVia: "challenge",
  });

  log.info(
    { phoneNumber, canonicalPrincipal },
    "Outbound voice verification sync: guardian phone binding created",
  );
}

// ---------------------------------------------------------------------------
// Durable cursor
// ---------------------------------------------------------------------------

export function loadCursor(): number | null {
  try {
    const row = getGatewayDb()
      .select({ lastProcessedAt: outboundVoiceVerifySyncCursor.lastProcessedAt })
      .from(outboundVoiceVerifySyncCursor)
      .where(eq(outboundVoiceVerifySyncCursor.key, CURSOR_KEY))
      .get();
    return row?.lastProcessedAt ?? null;
  } catch (err) {
    log.warn(
      { err },
      "Outbound voice verification sync: failed to load cursor; falling back to lookback window",
    );
    return null;
  }
}

export function persistCursor(value: number): void {
  try {
    const now = Date.now();
    getGatewayDb()
      .insert(outboundVoiceVerifySyncCursor)
      .values({ key: CURSOR_KEY, lastProcessedAt: value, updatedAt: now })
      .onConflictDoUpdate({
        target: outboundVoiceVerifySyncCursor.key,
        set: { lastProcessedAt: value, updatedAt: now },
      })
      .run();
  } catch (err) {
    log.warn(
      { err, value },
      "Outbound voice verification sync: failed to persist cursor; will retry next pass",
    );
  }
}

function advanceCursor(to: number): void {
  lastSyncAt = to;
  persistCursor(to);
}
