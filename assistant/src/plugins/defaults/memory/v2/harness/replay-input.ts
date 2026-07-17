/**
 * Input reconstruction — rebuild a retriever's per-turn inputs from telemetry.
 *
 * The activation log stores only outputs, so replaying a historical turn means
 * reconstructing the inputs:
 *  - `recentTurnPairs`: the (assistant, user) pairs ending at the turn's user
 *    message, windowed by `historical_pairs` and extracted exactly as
 *    production does (mirrors `extractRecentTurnPairs` in
 *    `conversation-graph-memory.ts`).
 *  - `nowText`: read from current workspace files (`loadNowText`). NOT stored
 *    in the log, so it may differ from what the live turn saw —
 *    always-approximate; see `ReconstructionMeta.nowReconstructedFromCurrent`.
 *  - `priorEverInjected`: the union of retained slugs from earlier
 *    `mode='router'` logs in the same conversation (turn < target). Retained
 *    statuses mirror production's `everInjected` (injected / in_context, plus
 *    page_missing / corrupt — see `PRIOR_STATUSES`).
 *
 * The anchor is the turn's assistant reply; the messages the router saw are
 * those strictly before it, so we fetch a bounded recent window up to the
 * anchor's timestamp and cut at the anchor row.
 */

import type { ContentBlock } from "@vellumai/plugin-api";
import { and, desc, eq, lte } from "drizzle-orm";

import type { AssistantConfig } from "../../../../../config/types.js";
import type { DrizzleDb } from "../../../../../persistence/db-connection.js";
import { messages } from "../../../../../persistence/schema/index.js";
import { memorySqliteOrNull } from "../../memory-db.js";
import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import { loadNowText } from "../now-text.js";
import type { RouterTurnPair } from "../router.js";
import type { EverInjectedEntry } from "../types.js";
import type { OracleTurn } from "./oracle.js";
import type { RetrievalInput } from "./retriever.js";

export interface ReconstructionMeta {
  /** `historical_pairs` window requested. */
  windowPairs: number;
  /** Pairs actually reconstructed (may be < window near conversation start). */
  pairsReconstructed: number;
  /** `priorEverInjected` entries reconstructed from earlier router logs. */
  priorEverInjectedCount: number;
  /**
   * NOW text is read from current workspace files — it is not stored in the
   * log and may differ from what the live turn saw. Always true; a recall gap
   * is partly attributable to this unmeasured drift.
   */
  nowReconstructedFromCurrent: true;
}

export interface ReconstructedInput {
  input: RetrievalInput;
  meta: ReconstructionMeta;
}

/** Minimal message shape for pair extraction. */
interface PlainMessage {
  role: string;
  content: ContentBlock[];
}

/**
 * Mirror of production `extractRecentTurnPairs`: walk messages newest-first,
 * pair each user message with the preceding assistant reply, keep the last `k`
 * pairs (oldest first). A leading user message with no prior assistant reply is
 * emitted with an empty `assistantMessage`.
 */
function extractRecentTurnPairs(
  msgs: readonly PlainMessage[],
  k: number,
): RouterTurnPair[] {
  const messageText = (msg: PlainMessage): string =>
    msg.content
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");

  const pairs: RouterTurnPair[] = [];
  let pendingUser: string | null = null;
  for (let i = msgs.length - 1; i >= 0 && pairs.length < k; i--) {
    const msg = msgs[i]!;
    if (msg.role === "user" && pendingUser === null) {
      pendingUser = messageText(msg);
    } else if (msg.role === "assistant" && pendingUser !== null) {
      pairs.unshift({
        assistantMessage: messageText(msg),
        userMessage: pendingUser,
      });
      pendingUser = null;
    }
  }
  if (pendingUser !== null && pairs.length < k) {
    pairs.unshift({ assistantMessage: "", userMessage: pendingUser });
  }
  if (pairs.length === 0) {
    pairs.push({ assistantMessage: "", userMessage: "" });
  }
  return pairs;
}

function parseContent(raw: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : [];
  } catch {
    return [];
  }
}

export async function reconstructInput(
  db: DrizzleDb,
  turn: OracleTurn,
  config: AssistantConfig,
  workspaceDir: string,
): Promise<ReconstructedInput | null> {
  const windowPairs = config.memory.v2.router.historical_pairs;

  // Fetch a bounded recent window up to the anchor's timestamp (newest first),
  // then cut everything at/after the anchor reply. We only need the last
  // `windowPairs` (assistant,user) pairs, so a small generous bound suffices
  // even for very long conversations.
  const fetchWindow = Math.max(20, windowPairs * 12);
  const recent = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, turn.conversationId),
        lte(messages.createdAt, turn.anchorCreatedAt),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(fetchWindow)
    .all();

  const anchorPos = recent.findIndex((m) => m.id === turn.anchorMessageId);
  if (anchorPos < 0) {
    return null;
  }
  const beforeAnchor = recent.slice(anchorPos + 1);
  if (beforeAnchor.length === 0) {
    return null;
  }

  const plain: PlainMessage[] = beforeAnchor
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: parseContent(m.content) }));

  const recentTurnPairs = extractRecentTurnPairs(plain, windowPairs);
  const priorEverInjected = reconstructPriorEverInjected(
    turn.conversationId,
    turn.turn,
  );
  const nowText = await loadNowText(workspaceDir);

  return {
    input: {
      workspaceDir,
      recentTurnPairs,
      nowText,
      priorEverInjected,
      config,
    },
    meta: {
      windowPairs,
      pairsReconstructed: recentTurnPairs.length,
      priorEverInjectedCount: priorEverInjected.length,
      nowReconstructedFromCurrent: true,
    },
  };
}

// Production's `everInjected` retains a slug once it is rendered, EXCEPT for
// missing synthetic slugs (skills/CLI commands whose capability cache is empty
// — see `missingSyntheticSlugs` in `injection.ts`). Concept pages that turn out
// `page_missing` or `corrupt` at render time are still retained so they aren't
// re-attempted every turn (see the `page_missing ... DOES land in everInjected`
// case in `injection.test.ts`). The replay must mirror that retention or it
// builds a narrower prior-state than live routing, skewing comparisons. Missing
// synthetic slugs never enter the missing/corrupt buckets — they log as
// `injected` — so widening here introduces no new synthetic-slug discrepancy.
const PRIOR_STATUSES = new Set<string>([
  "injected",
  "in_context",
  "page_missing",
  "corrupt",
]);

/**
 * Union of slugs injected on earlier `mode='router'` turns in this conversation
 * (turn < `currentTurn`), each tagged with the earliest turn it appeared on —
 * the harness analogue of the running `everInjected` list production maintains.
 * The activation log lives in the dedicated memory database; without that
 * connection the prior state degrades to empty.
 */
function reconstructPriorEverInjected(
  conversationId: string,
  currentTurn: number,
): EverInjectedEntry[] {
  const raw = memorySqliteOrNull("reconstructPriorEverInjected");
  if (!raw) {
    return [];
  }
  const rows = raw
    .query(
      `SELECT turn, concepts_json
         FROM memory_v2_activation_logs
        WHERE conversation_id = ? AND mode = 'router' AND turn < ?
        ORDER BY turn ASC`,
    )
    .all(conversationId, currentTurn) as Array<{
    turn: number;
    concepts_json: string;
  }>;

  const firstTurnBySlug = new Map<string, number>();
  for (const row of rows) {
    let concepts: MemoryV2ConceptRowRecord[];
    try {
      concepts = JSON.parse(row.concepts_json) as MemoryV2ConceptRowRecord[];
    } catch {
      continue;
    }
    for (const concept of concepts) {
      if (!PRIOR_STATUSES.has(concept.status)) {
        continue;
      }
      if (!firstTurnBySlug.has(concept.slug)) {
        firstTurnBySlug.set(concept.slug, row.turn);
      }
    }
  }

  const entries: EverInjectedEntry[] = [];
  firstTurnBySlug.forEach((turn, slug) => {
    entries.push({ slug, turn });
  });
  return entries;
}
