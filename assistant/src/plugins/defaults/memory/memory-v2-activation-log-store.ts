import { v4 as uuid } from "uuid";

import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("memory-v2-activation-log-store");

export interface MemoryV2ConceptRowRecord {
  slug: string;
  finalActivation: number;
  ownActivation: number;
  priorActivation: number;
  simUser: number;
  simAssistant: number;
  simNow: number;
  /**
   * Cross-encoder rerank delta in raw rerank space (`alpha · r_norm_u`)
   * for the user channel. Zero when rerank is disabled or the slug fell
   * outside the unified top-K-by-pre-rerank-A_o window. Applied
   * additively to A_o weighted by `c_user` — `simUser` itself is the
   * raw fused score and never carries the boost. Stored as a JSON field,
   * so older log rows pre-date this addition and decode with `undefined`;
   * readers should fall back to 0.
   */
  simUserRerankBoost: number;
  /**
   * Cross-encoder rerank delta for the assistant channel. Same semantics
   * as `simUserRerankBoost`, weighted by `c_assistant` when applied to
   * A_o. The NOW channel intentionally bypasses rerank, so there is no
   * `simNowRerankBoost`.
   */
  simAssistantRerankBoost: number;
  /**
   * True when rerank ran and this slug landed in the unified
   * top-K-by-pre-rerank-A_o pool. Distinguishes "cross-encoder evaluated
   * this and chose 0" from "rerank skipped this slug" so the inspector
   * can keep the rerank rows visible at `+0.000` instead of silently
   * dropping them. Older log rows pre-date this field and decode with
   * `undefined`; readers should fall back to `false`.
   */
  inRerankPool: boolean;
  spreadContribution: number;
  /**
   * Provenance of this concept row.
   *   - `prior_state` — carried over from prior turn's activation state.
   *   - `ann_top50`   — entered via ANN top-K candidate pool.
   *   - `both`        — present in both prior state and ANN pool.
   *   - `router`      — legacy tag for memory-v2 router selections written
   *     before tier-aware provenance landed. New rows never use this; old
   *     activation log rows still carry it and the inspector renders it
   *     as-is for backward compat.
   *   - `tier1`       — router-mode, selected by the tier-1 (recently
   *     modified) batch.
   *   - `tier2`       — router-mode, selected by the tier-2 (highest EMA)
   *     batch.
   *   - `tier3:<N>`   — router-mode, selected by tier-3 batch N (0-indexed).
   *     A single-batch (no-tier carve-out) workspace produces `tier3:0`.
   *     The bucket index lets inspector queries attribute selections to
   *     specific hash-bucketed parallel calls.
   *   - `carry_over`  — router-mode row representing a slug carried over
   *     from `priorEverInjected` that the router did NOT re-pick on this
   *     turn. The cached attachment from a prior turn is still present
   *     on a prior user message; emitting one of the tier tags for these
   *     rows would overcount router selections in inspector queries.
   *
   * All router-mode rows (`tier*`, `router`, `carry_over`) zero out the
   * activation values (`finalActivation`, `ownActivation`, etc.) because
   * the router does not compute spreading-activation scores.
   */
  source:
    | "prior_state"
    | "ann_top50"
    | "both"
    | "router"
    | "carry_over"
    | "tier1"
    | "tier2"
    | `tier3:${number}`;
  /**
   * Per-turn outcome for this slug:
   *   - `in_context`  — already injected on a prior turn; cached attachment
   *     remains visible without re-rendering.
   *   - `injected`    — freshly rendered into this turn's user message.
   *   - `not_injected`— a candidate that didn't make `slugsToRender`.
   *   - `page_missing`— would-have-been-injected, but `readPage` returned
   *     null (file vanished between selection and render — stale Qdrant
   *     or edge-index entry).
   *   - `corrupt`     — would-have-been-injected, but `readPage` threw
   *     (e.g. malformed frontmatter). Other slugs in the same batch
   *     rendered normally.
   */
  status:
    | "in_context"
    | "injected"
    | "not_injected"
    | "page_missing"
    | "corrupt";
  /**
   * v3 shadow only: the retrieval lane that surfaced this slug
   * (`hot` | `sparse` | `dense` | `tree` | `edge`). Lets a shadow run be
   * analyzed by provenance — which lane each v3 pick came from. Undefined on
   * `router`/`per-turn`/etc. v2 rows; stored in the JSON concept blob, so older
   * rows decode with `undefined`.
   */
  lane?: string;
}

export interface MemoryV2ConfigSnapshot {
  d: number;
  c_user: number;
  c_assistant: number;
  c_now: number;
  k: number;
  hops: number;
  top_k: number;
  epsilon: number;
}

export interface RecordMemoryV2ActivationLogParams {
  conversationId: string;
  turn: number;
  /**
   * Call-site mode: `context-load` for fresh / post-compaction loads,
   * `per-turn` for normal append injections, `errored` when `injectMemoryV2Block`
   * threw before completing — telemetry is still written so silent failures
   * are observable in the database, with whatever `concepts` rows had been
   * built so far (possibly empty). `router` indicates the LLM router selected
   * the per-turn page set; router-mode rows carry zeroed activation values and
   * `source: "router"` on every concept row. `v3_shadow` is written by the
   * live-shadow v3 retrieval middleware: it records v3's selection set for
   * comparison without affecting injected context. The harness oracle filters
   * `mode='router'`, so `v3_shadow` rows never pollute it; the inspector can
   * still surface them.
   */
  mode: "context-load" | "per-turn" | "errored" | "router" | "v3_shadow";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function recordMemoryV2ActivationLog(
  params: RecordMemoryV2ActivationLogParams,
): void {
  // Best-effort — telemetry writes must never abort the agent turn, so a
  // degraded memory connection or a failed insert only logs a warning.
  try {
    const raw = memorySqliteOrNull("recordMemoryV2ActivationLog");
    if (!raw) {
      return;
    }
    // Skills live as concept rows under `slug: "skills/<id>"`, so the
    // separate `skills_json` column is always written empty. The column
    // itself remains in the schema for backwards-compat with prior log rows;
    // the reader drops it.
    raw
      .prepare(
        `INSERT INTO memory_v2_activation_logs (
           id, conversation_id, message_id, turn, mode,
           concepts_json, skills_json, config_json, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        params.conversationId,
        params.turn,
        params.mode,
        JSON.stringify(params.concepts),
        "[]",
        JSON.stringify(params.config),
        Date.now(),
      );
  } catch (err) {
    log.warn({ err }, "failed to record memory v2 activation log; continuing");
  }
}

export function backfillMemoryV2ActivationMessageId(
  conversationId: string,
  messageId: string,
): void {
  // `v3_shadow` rows are detached telemetry written outside the live turn with
  // a null messageId; they are not tied to any specific message. Excluding them
  // keeps their messageId null instead of stamping them with a later turn's id.
  try {
    const raw = memorySqliteOrNull("backfillMemoryV2ActivationMessageId");
    if (!raw) {
      return;
    }
    raw
      .prepare(
        `UPDATE memory_v2_activation_logs
           SET message_id = ?
         WHERE conversation_id = ?
           AND message_id IS NULL
           AND mode != 'v3_shadow'`,
      )
      .run(messageId, conversationId);
  } catch (err) {
    log.warn(
      { err },
      "failed to backfill memory v2 activation messageId; continuing",
    );
  }
}

export interface MemoryV2ActivationLog {
  conversationId: string;
  turn: number;
  mode: "context-load" | "per-turn" | "errored" | "router" | "v3_shadow";
  concepts: MemoryV2ConceptRowRecord[];
  config: MemoryV2ConfigSnapshot;
}

export function getMemoryV2ActivationLogByMessageIds(
  messageIds: string[],
): MemoryV2ActivationLog | null {
  if (messageIds.length === 0) {
    return null;
  }
  const raw = memorySqliteOrNull("getMemoryV2ActivationLogByMessageIds");
  if (!raw) {
    return null;
  }
  const placeholders = messageIds.map(() => "?").join(",");
  const row = raw
    .query(
      `SELECT conversation_id, turn, mode, concepts_json, config_json
         FROM memory_v2_activation_logs
        WHERE message_id IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(...messageIds) as {
    conversation_id: string;
    turn: number;
    mode: string;
    concepts_json: string;
    config_json: string;
  } | null;
  if (!row) {
    return null;
  }
  return {
    conversationId: row.conversation_id,
    turn: row.turn,
    mode: row.mode as
      | "context-load"
      | "per-turn"
      | "errored"
      | "router"
      | "v3_shadow",
    concepts: JSON.parse(row.concepts_json) as MemoryV2ConceptRowRecord[],
    config: JSON.parse(row.config_json) as MemoryV2ConfigSnapshot,
  };
}
