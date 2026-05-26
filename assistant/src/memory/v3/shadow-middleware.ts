/**
 * Memory v3 — live-shadow `memoryRetrieval` middleware.
 *
 * Registered unconditionally into the `memoryRetrieval` pipeline, but inert
 * unless BOTH `config.memory.v3.enabled` and `config.memory.v3.shadow` are on.
 * When inert it is a byte-for-byte pass-through: it returns `next(args)`
 * verbatim and performs zero extra work (no v3 call, no DB read, no log write).
 *
 * When active, it:
 *   1. Returns the real (v2/default) `MemoryResult` from `next(args)` promptly —
 *      the injected context is ALWAYS the v2 result, never v3.
 *   2. Kicks off the v3 retrieval loop DETACHED (not awaited on the path that
 *      returns the result), so the shadow run can never block or slow the turn.
 *   3. Logs v3's selection set to `memory_v2_activation_logs` with
 *      `mode = "v3_shadow"`. The harness oracle filters `mode='router'`, so
 *      shadow rows never pollute it; the inspector can still surface them.
 *
 * The shadow build mirrors the inputs the v2 router receives (recent turn
 * pairs, NOW context, prior-ever-injected slugs, config) so its recall is
 * measured against the same situational context the live path saw. Failures
 * are swallowed with a warn — the shadow is observational only and must never
 * affect the live turn.
 */

import { desc, eq } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import { registerPlugin } from "../../plugins/registry.js";
import {
  type MemoryArgs,
  type MemoryResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../../plugins/types.js";
import type { ContentBlock } from "../../providers/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { DrizzleDb } from "../db-connection.js";
import { getDb } from "../db-connection.js";
import {
  type MemoryV2ConceptRowRecord,
  type MemoryV2ConfigSnapshot,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { messages } from "../schema.js";
import { hydrate } from "../v2/activation-store.js";
import type { RetrievalInput } from "../v2/harness/retriever.js";
import { loadNowText } from "../v2/now-text.js";
import type { RouterTurnPair } from "../v2/router.js";
import type { EverInjectedEntry } from "../v2/types.js";
import { runRetrievalLoop } from "./loop.js";

const log = getLogger("memory-v3-shadow");

/**
 * Extract the recent (assistant, user) turn pairs from a conversation's
 * message list, newest-pair-last, capped at `k`. Mirrors production
 * `extractRecentTurnPairs` in `conversation-graph-memory.ts` (and its harness
 * twin in `replay-input.ts`) so the shadow's `recentTurnPairs` matches what the
 * live router was fed.
 */
function extractRecentTurnPairs(
  msgs: ReadonlyArray<{ role: string; content: ContentBlock[] }>,
  k: number,
): RouterTurnPair[] {
  const messageText = (content: ContentBlock[]): string =>
    content
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
      pendingUser = messageText(msg.content);
    } else if (msg.role === "assistant" && pendingUser !== null) {
      pairs.unshift({
        assistantMessage: messageText(msg.content),
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

/** Parse a persisted JSON content-block string; tolerate malformed rows. */
function parseContent(raw: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : [];
  } catch {
    return [];
  }
}

/**
 * Load the most recent messages for a conversation, oldest-first, bounded to a
 * small generous multiple of `historicalPairs`. Pair extraction only needs the
 * tail, so a bounded `LIMIT` query avoids loading an entire (potentially
 * multi-GB) conversation on every shadow turn — mirrors the harness's bounded
 * fetch in `replay-input.ts`.
 */
function loadRecentMessages(
  db: DrizzleDb,
  conversationId: string,
  historicalPairs: number,
): Array<{ role: string; content: ContentBlock[] }> {
  const fetchWindow = Math.max(20, historicalPairs * 12);
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(fetchWindow)
    .all();
  return rows
    .reverse()
    .map((r) => ({ role: r.role, content: parseContent(r.content) }));
}

/**
 * Empty config snapshot for shadow log rows. The activation-state values are
 * meaningless for a v3 selection (it computes no spreading-activation scores),
 * so they are zeroed — exactly as the v2 router-mode rows do.
 */
const SHADOW_CONFIG_SNAPSHOT: MemoryV2ConfigSnapshot = {
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
};

/**
 * Build the concept rows logged for a v3 shadow selection. Each selected slug
 * becomes a zeroed concept row tagged `source: "router"` and
 * `status: "injected"` — the shadow has no activation scores to record, and the
 * `mode='v3_shadow'` row tag (not the concept source) is what distinguishes
 * shadow telemetry from live router selections. Each row also carries the
 * `lane` that surfaced the slug (from `sourceBySlug`) so a shadow run can be
 * analyzed by provenance.
 */
function buildShadowConceptRows(
  selectedSlugs: readonly string[],
  sourceBySlug: ReadonlyMap<string, string>,
): MemoryV2ConceptRowRecord[] {
  return selectedSlugs.map((slug) => ({
    slug,
    finalActivation: 0,
    ownActivation: 0,
    priorActivation: 0,
    simUser: 0,
    simAssistant: 0,
    simNow: 0,
    simUserRerankBoost: 0,
    simAssistantRerankBoost: 0,
    inRerankPool: false,
    spreadContribution: 0,
    source: "router",
    status: "injected",
    ...(sourceBySlug.get(slug) ? { lane: sourceBySlug.get(slug) } : {}),
  }));
}

/**
 * Run the v3 retrieval loop for the shadow and log its selection. Best-effort:
 * any failure is logged and swallowed. Honors `signal` so a cancelled turn
 * stops the shadow's lane work.
 */
async function runShadowAndLog(
  args: MemoryArgs,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted) return;

    const config = getConfig();
    const workspaceDir = getWorkspaceDir();
    const db = getDb();

    const historicalPairs = config.memory.v2.router.historical_pairs;
    const recentMessages = loadRecentMessages(
      db,
      args.conversationId,
      historicalPairs,
    );
    const recentTurnPairs = extractRecentTurnPairs(
      recentMessages,
      historicalPairs,
    );

    const nowText = await loadNowText(workspaceDir);

    let priorEverInjected: readonly EverInjectedEntry[] = [];
    try {
      const state = await hydrate(db, args.conversationId);
      priorEverInjected = state?.everInjected ?? [];
    } catch (err) {
      log.warn(
        { err, conversationId: args.conversationId },
        "v3 shadow: failed to hydrate prior-ever-injected; continuing with empty set",
      );
    }

    if (signal.aborted) return;

    const input: RetrievalInput = {
      workspaceDir,
      recentTurnPairs,
      nowText,
      priorEverInjected,
      config,
      signal,
    };

    const output = await runRetrievalLoop(input, {
      db,
      conversationId: args.conversationId,
      turn: args.turnIndex,
    });

    if (signal.aborted) return;

    // Per-turn summary so a shadow run is analyzable from the logs — the pool
    // shape, how many passes ran, and the gate's verdict + rationale. The
    // selection set + per-slug lane land in the activation log below.
    const passes = output.trace?.passes ?? [];
    const lastGate = passes[passes.length - 1]?.gate;
    const laneTally: Record<string, number> = {};
    for (const lane of output.sourceBySlug.values()) {
      laneTally[lane] = (laneTally[lane] ?? 0) + 1;
    }
    log.info(
      {
        conversationId: args.conversationId,
        turn: args.turnIndex,
        selected: output.selectedSlugs.length,
        poolSize: output.sourceBySlug.size,
        laneTally,
        passes: passes.length,
        gateDecision: lastGate?.decision,
        gateReasoning: lastGate?.reasoning,
      },
      "v3 shadow selection",
    );

    recordMemoryV2ActivationLog({
      conversationId: args.conversationId,
      turn: args.turnIndex,
      mode: "v3_shadow",
      concepts: buildShadowConceptRows(
        output.selectedSlugs,
        output.sourceBySlug,
      ),
      config: SHADOW_CONFIG_SNAPSHOT,
    });
  } catch (err) {
    log.warn(
      { err, conversationId: args.conversationId, turn: args.turnIndex },
      "v3 shadow retrieval failed; live turn unaffected",
    );
  }
}

/**
 * Live-shadow `memoryRetrieval` middleware.
 *
 * Flag-gated INSIDE the middleware (per-turn, live-toggle): when v3 shadow is
 * off it is a pure pass-through. When on, it fires the v3 loop detached and
 * returns the unchanged downstream (v2) result immediately.
 *
 * The shadow loop spends filter + gate LLM calls, so — like the other
 * guardian-trust background memory loops (`enqueueAutoAnalysisOnCompaction`,
 * `enqueueMemoryRetrospectiveOnCompaction`) — it is gated on actor trust: an
 * untrusted turn passes through without kicking off the v3 loop.
 */
export const memoryV3ShadowMiddleware: Middleware<MemoryArgs, MemoryResult> =
  async function memoryV3Shadow(args, next) {
    const v3 = getConfig().memory.v3;
    if (!v3?.enabled || !v3?.shadow) {
      // Inert: byte-for-byte pass-through, zero extra work.
      return next(args);
    }

    if (isUntrustedTrustClass(args.trustContext?.trustClass)) {
      // Untrusted actor: don't spend shadow retrieval LLM calls — mirrors the
      // live path's trust gate. Pure pass-through, no detached work.
      return next(args);
    }

    // Detached — never awaited on the path that returns the result, so the
    // shadow can neither block nor slow the live turn. Errors are swallowed
    // inside `runShadowAndLog`.
    void runShadowAndLog(args, args.signal);

    return next(args);
  };

/**
 * First-party plugin contributing the live-shadow `memoryRetrieval`
 * middleware. Registered unconditionally by the plugin bootstrap (it is inert
 * unless both v3 flags are on), so the registration is always present but does
 * zero work in the default (flags-off) configuration.
 */
export const memoryV3ShadowPlugin: Plugin = {
  manifest: {
    name: "memory-v3-shadow",
    version: "0.0.1",
  },
  middleware: {
    memoryRetrieval: memoryV3ShadowMiddleware,
  },
};

// Module-load side effect: register the shadow plugin at import time so the
// registry is populated even in tests that skip `bootstrapPlugins()`, matching
// the first-party `default-*` plugins. Idempotent via the swallowed
// duplicate-name check (the defaults aggregator also lists this plugin).
try {
  registerPlugin(memoryV3ShadowPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both the defaults aggregator and the
    // direct module import run in the same process.
  } else {
    throw err;
  }
}
