/**
 * One-time migration: backfill guardian requests + deliveries from the
 * assistant DB into the gateway-owned tables.
 *
 * Plain INSERT OR IGNORE: request ids are unique and immutable; gateway rows
 * win. Requests insert before deliveries so the request_id FK is satisfied.
 * Column mapping: assistant `conversation_id` → gateway
 * `source_conversation_id`; assistant `source_type` has no gateway column
 * (derived from source_channel at read time); everything else copies 1:1.
 *
 * Copy, not move: never writes to the assistant DB (the drop migration is
 * gated on this migration's checkpoint). Returns "done" when the assistant
 * source table is already gone; any failure returns "skip" to retry on the
 * next startup.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0015-guardian-requests-backfill");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

interface AssistantRequestRow {
  id: string;
  kind: string;
  source_channel: string | null;
  conversation_id: string | null;
  requester_external_user_id: string | null;
  requester_chat_id: string | null;
  guardian_external_user_id: string | null;
  guardian_principal_id: string | null;
  call_session_id: string | null;
  pending_question_id: string | null;
  question_text: string | null;
  request_code: string | null;
  tool_name: string | null;
  input_digest: string | null;
  command_preview: string | null;
  risk_level: string | null;
  activity_text: string | null;
  execution_target: string | null;
  requester_signals: string | null;
  request_trigger: string | null;
  status: string;
  answer_text: string | null;
  decided_by_external_user_id: string | null;
  decided_by_principal_id: string | null;
  followup_state: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AssistantDeliveryRow {
  id: string;
  request_id: string;
  destination_channel: string;
  destination_conversation_id: string | null;
  destination_chat_id: string | null;
  destination_message_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

async function assistantTableExists(name: string): Promise<boolean> {
  const rows = await assistantDbQuery<{ "1": number }>(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return rows.length > 0;
}

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  try {
    // ── 1. Bail if the assistant table is already gone (dropped/fresh) ─────
    if (!(await assistantTableExists("canonical_guardian_requests"))) {
      log.info(
        "Assistant DB has no canonical_guardian_requests table — nothing to backfill",
      );
      return "done";
    }

    // ── 2. Read the assistant rows ──────────────────────────────────────────
    const requestRows = await assistantDbQuery<AssistantRequestRow>(
      `SELECT id, kind, source_channel, conversation_id,
              requester_external_user_id, requester_chat_id,
              guardian_external_user_id, guardian_principal_id,
              call_session_id, pending_question_id, question_text,
              request_code, tool_name, input_digest, command_preview,
              risk_level, activity_text, execution_target, requester_signals,
              request_trigger, status, answer_text,
              decided_by_external_user_id, decided_by_principal_id,
              followup_state, expires_at, created_at, updated_at
         FROM canonical_guardian_requests`,
    );

    const deliveryRows = (await assistantTableExists(
      "canonical_guardian_deliveries",
    ))
      ? await assistantDbQuery<AssistantDeliveryRow>(
          `SELECT id, request_id, destination_channel,
                  destination_conversation_id, destination_chat_id,
                  destination_message_id, status, created_at, updated_at
             FROM canonical_guardian_deliveries`,
        )
      : [];

    // ── 3. Copy into the gateway (OR IGNORE: gateway rows always win) ──────
    const insertRequest = gwDb.prepare(
      `INSERT OR IGNORE INTO guardian_requests
         (id, kind, source_channel, source_conversation_id,
          requester_external_user_id, requester_chat_id,
          guardian_external_user_id, guardian_principal_id, call_session_id,
          pending_question_id, question_text, request_code, tool_name,
          input_digest, command_preview, risk_level, activity_text,
          execution_target, requester_signals, request_trigger, status,
          answer_text, decided_by_external_user_id, decided_by_principal_id,
          followup_state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertDelivery = gwDb.prepare(
      `INSERT OR IGNORE INTO guardian_request_deliveries
         (id, request_id, destination_channel, destination_conversation_id,
          destination_chat_id, destination_message_id, status, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let requestsInserted = 0;
    let deliveriesInserted = 0;

    const txn = gwDb.transaction(() => {
      for (const row of requestRows) {
        requestsInserted += insertRequest.run(
          row.id,
          row.kind,
          row.source_channel,
          row.conversation_id,
          row.requester_external_user_id,
          row.requester_chat_id,
          row.guardian_external_user_id,
          row.guardian_principal_id,
          row.call_session_id,
          row.pending_question_id,
          row.question_text,
          row.request_code,
          row.tool_name,
          row.input_digest,
          row.command_preview,
          row.risk_level,
          row.activity_text,
          row.execution_target,
          row.requester_signals,
          row.request_trigger,
          row.status,
          row.answer_text,
          row.decided_by_external_user_id,
          row.decided_by_principal_id,
          row.followup_state,
          row.expires_at,
          row.created_at,
          row.updated_at,
        ).changes;
      }

      for (const row of deliveryRows) {
        deliveriesInserted += insertDelivery.run(
          row.id,
          row.request_id,
          row.destination_channel,
          row.destination_conversation_id,
          row.destination_chat_id,
          row.destination_message_id,
          row.status,
          row.created_at,
          row.updated_at,
        ).changes;
      }
    });
    txn();

    log.info(
      {
        requests: requestRows.length,
        requestsInserted,
        deliveries: deliveryRows.length,
        deliveriesInserted,
      },
      "m0015: backfilled guardian requests + deliveries into gateway",
    );

    return "done";
  } catch (err) {
    log.error(
      { err },
      "m0015: guardian requests backfill failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  // No-op: backfilled rows are legitimate gateway data; never delete on rollback.
  return "done";
}
