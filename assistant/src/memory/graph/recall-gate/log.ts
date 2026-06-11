/**
 * Async log writer for recall-gate decisions.
 *
 * Fires the SQLite INSERT via queueMicrotask so it never sits on the
 * request path. Shadow-mode latency-saved metrics depend on the gate
 * decision completing before the write lands.
 */

import { v4 as uuid } from "uuid";

import { getLogger } from "../../../util/logger.js";
import { getSqlite } from "../../db-connection.js";

const log = getLogger("recall-gate-log");

export interface RecallGateLogEntry {
  conversationId: string;
  turn: number;
  decision: "retrieve" | "skip";
  ruleFired: string | null;
  safetyFloorHit: boolean;
  safetyFloorTokens: string[];
  redactedUserText: string;
  promptCharCount: number;
  promptTokenEstimate: number;
  hasEntities: boolean;
  hasQuestionMark: boolean;
  decisionLatencyUs: number;
  mode: "shadow" | "live";
  retrievalLatencyMs?: number;
  v3SelectorResult?: string;
}

/**
 * Enqueue a log row write via microtask. Returns synchronously to the
 * caller so the gate decision is never blocked by I/O.
 */
export function logRecallGateDecision(entry: RecallGateLogEntry): void {
  queueMicrotask(() => {
    try {
      const db = getSqlite();
      db.run(
        /*sql*/ `
        INSERT INTO memory_recall_gate_decisions (
          id, conversation_id, turn, timestamp, decision, rule_fired,
          safety_floor_hit, safety_floor_tokens, redacted_user_text,
          prompt_char_count, prompt_token_estimate, has_entities,
          has_question_mark, decision_latency_us, mode,
          retrieval_latency_ms, v3_selector_result
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
        )
      `,
        [
          uuid(),
          entry.conversationId,
          entry.turn,
          Date.now(),
          entry.decision,
          entry.ruleFired,
          entry.safetyFloorHit ? 1 : 0,
          entry.safetyFloorTokens.length > 0
            ? JSON.stringify(entry.safetyFloorTokens)
            : null,
          entry.redactedUserText,
          entry.promptCharCount,
          entry.promptTokenEstimate,
          entry.hasEntities ? 1 : 0,
          entry.hasQuestionMark ? 1 : 0,
          entry.decisionLatencyUs,
          entry.mode,
          entry.retrievalLatencyMs ?? null,
          entry.v3SelectorResult ?? null,
        ],
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to write recall-gate decision log (non-fatal)",
      );
    }
  });
}

/**
 * Backfill the retrieval latency on an already-written log row.
 * Called after shadow-mode retrieval completes so the log captures the
 * counterfactual cost. Also deferred via microtask.
 */
export function backfillRetrievalLatency(
  conversationId: string,
  turn: number,
  retrievalLatencyMs: number,
): void {
  queueMicrotask(() => {
    try {
      const db = getSqlite();
      db.run(
        /*sql*/ `
        UPDATE memory_recall_gate_decisions
        SET retrieval_latency_ms = ?1
        WHERE conversation_id = ?2 AND turn = ?3
      `,
        [retrievalLatencyMs, conversationId, turn],
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to backfill retrieval latency on recall-gate log (non-fatal)",
      );
    }
  });
}
