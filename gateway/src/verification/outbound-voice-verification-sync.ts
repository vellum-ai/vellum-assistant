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
 */

import { existsSync } from "node:fs";

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import {
  getExistingGuardianBinding,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";

const log = getLogger("outbound-voice-verification-sync");

const POLL_INTERVAL_MS = 5_000;

// On startup, catch up any sessions consumed within the last 24 hours so
// nothing is missed across gateway restarts.
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
  // ORDER BY updated_at ASC matters: when multiple consumed sessions appear
  // in the same poll (e.g. startup lookback or two verifications inside the
  // 5s window), the conflict path below revokes any existing binding. Oldest
  // first guarantees the most recent verification wins.
  const result = (await ipcCallAssistant("db_proxy", {
    sql: `SELECT consumed_by_external_user_id, consumed_by_chat_id, updated_at
          FROM channel_verification_sessions
          WHERE channel = 'phone'
            AND status = 'consumed'
            AND verification_purpose = 'guardian'
            AND expected_phone_e164 IS NOT NULL
            AND updated_at > ?
          ORDER BY updated_at ASC`,
    mode: "query",
    bind: [since],
  })) as DbProxyResult;

  if (!result.rows?.length) {
    lastSyncAt = now;
    return;
  }

  log.info(
    { count: result.rows.length, since },
    "Outbound voice verification sync: found consumed sessions",
  );

  // Track the highest updated_at we successfully processed. On any failure
  // we keep lastSyncAt at the predecessor watermark so the failing row is
  // re-queried next pass. createPhoneGuardianBinding is idempotent — already-
  // bound rows short-circuit, so retried successes are a no-op.
  let highWatermark = since;
  let anyFailed = false;

  for (const row of result.rows) {
    const phoneNumber = row.consumed_by_external_user_id as string | null;
    const rowUpdatedAt = (row.updated_at as number | null) ?? since;

    if (!phoneNumber) {
      // Malformed row — never going to succeed, advance past it.
      highWatermark = Math.max(highWatermark, rowUpdatedAt);
      continue;
    }

    const chatId = (row.consumed_by_chat_id as string | null) ?? phoneNumber;

    try {
      await createPhoneGuardianBinding(phoneNumber, chatId);
      highWatermark = Math.max(highWatermark, rowUpdatedAt);
    } catch (err) {
      anyFailed = true;
      log.warn(
        { err, phoneNumber },
        "Outbound voice verification sync: binding creation failed; will retry",
      );
      // Stop advancing the watermark past this row — we want the next poll
      // to re-select it. Subsequent rows in this batch may still process,
      // but we won't advance lastSyncAt past the failure point.
      break;
    }
  }

  lastSyncAt = anyFailed ? highWatermark : now;
}

async function createPhoneGuardianBinding(
  phoneNumber: string,
  chatId: string,
): Promise<void> {
  const canonicalPrincipal = await resolveCanonicalPrincipal(phoneNumber);
  const existingBinding = await getExistingGuardianBinding("phone");

  if (existingBinding) {
    if (existingBinding.externalUserId === phoneNumber) {
      // Idempotent — binding already exists for this number. This can happen
      // on gateway restart (STARTUP_LOOKBACK_MS catches old sessions) or if
      // the poller fires twice before lastSyncAt advances.
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
