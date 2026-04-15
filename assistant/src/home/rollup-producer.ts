/**
 * Activity-log roll-up producer for the home feed.
 *
 * On a tick, reads the recent `action` items that background jobs have
 * deposited in the feed (via `emit-feed-event.ts`) and asks the
 * configured inference provider "consolidate these raw actions into a
 * small set of digests or threads." This is the replacement for the
 * old "reflect from nothing" producer: the roll-up starts from real
 * side effects instead of prompting the model to hallucinate signal
 * from relationship state alone.
 *
 * Mirrors the background-inference pattern established in
 * `approval-generators.ts`: resolve the provider from config, call
 * `provider.sendMessage` with a `tool_use`-shaped structured output
 * schema, validate each returned block, and hand the validated
 * shapes to `writeAssistantFeedItem`.
 *
 * Budget notes:
 *
 *   - Hard cap: {@link MAX_ITEMS_PER_ROLLUP} items per tick so a
 *     single run can never flood the feed.
 *   - Timeout: {@link ROLLUP_TIMEOUT_MS} so a stalled provider can't
 *     stall the tick loop.
 *   - Token budget: {@link ROLLUP_MAX_TOKENS} — tight, because the
 *     output is a list of short feed items, not a long essay.
 *   - Input cap: at most {@link MAX_ACTIONS_IN_PROMPT} recent action
 *     items are serialized into the user prompt. Callers' volume is
 *     already bounded by the writer's per-source action cap, but
 *     this second cap protects against pathological inputs.
 *
 * Failure modes degrade gracefully: an unavailable provider, a
 * malformed tool_use block, a schema-rejected item, or an exception
 * in the inner loop all return a {@link RollupResult} with the
 * appropriate `skippedReason`. The scheduler logs these but never
 * surfaces them to the user.
 */

import { loadConfig } from "../config/loader.js";
import { getProvider, listProviders } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  writeAssistantFeedItem,
  type WriteAssistantFeedItemParams,
} from "./assistant-feed-authoring.js";
import type { FeedItem } from "./feed-types.js";
import { readHomeFeed } from "./feed-writer.js";
import { computeRelationshipState } from "./relationship-state-writer.js";

const log = getLogger("home-feed-rollup");

const ROLLUP_TIMEOUT_MS = 30_000;
const ROLLUP_MAX_TOKENS = 800;
const MAX_ITEMS_PER_ROLLUP = 3;
const MAX_ACTIONS_IN_PROMPT = 30;

const ROLLUP_TOOL_NAME = "write_feed_items";

const ROLLUP_SYSTEM_PROMPT = [
  "You are a roll-up loop for a personal assistant's home activity feed.",
  "Raw `action` items land in the feed as a deterministic side effect of background jobs.",
  "Your job is to CONSOLIDATE those raw actions into higher-signal summary rows — never to invent signal from nothing.",
  "",
  "Rules:",
  "- Emit only `digest` or `thread` items. Do NOT emit `action` items — those come from the background jobs themselves.",
  "- A `digest` collapses several related raw actions into one summary row (e.g. '3 scheduled jobs ran this morning').",
  "- A `thread` tracks an ongoing multi-action situation worth surfacing (e.g. 'Outreach to Alice — 2 emails sent, awaiting reply').",
  "- Each digest/thread must be grounded in specific action items from the list below. Do not invent events.",
  "- Never duplicate a consolidation that already describes the same set of actions — the writer's one-per-source replacement for digests will collapse repeats but you shouldn't rely on it.",
  "- Prefer 0 items over low-signal filler. An empty activity log should always produce 0 items.",
  "- You may emit up to 3 items total.",
  "",
  "Use the `write_feed_items` tool to emit items. If nothing is worth rolling up, call the tool with an empty `items` array.",
].join("\n");

const ROLLUP_TOOL_SCHEMA = {
  name: ROLLUP_TOOL_NAME,
  description:
    "Record the set of roll-up feed items (digests or threads) that consolidate recent activity-log actions. " +
    "Pass an empty `items` array if nothing is worth rolling up right now.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        maxItems: MAX_ITEMS_PER_ROLLUP,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["digest", "thread"],
              description:
                "`digest` collapses multiple related actions into one summary row; `thread` tracks an ongoing multi-action situation.",
            },
            source: {
              type: "string",
              enum: ["gmail", "slack", "calendar", "assistant"],
              description:
                "Origin hint used for the icon. Use `assistant` for cross-source roll-ups of assistant-driven work.",
            },
            title: {
              type: "string",
              description:
                "Short headline, 4–10 words. Lowercase-sentence-case, no period.",
            },
            summary: {
              type: "string",
              description:
                "One-sentence body copy explaining the roll-up. 1–25 words. Must reference specific actions from the activity log.",
            },
            priority: {
              type: "integer",
              minimum: 0,
              maximum: 100,
              description:
                "Relative importance (higher = more prominent). Use 70 for digests, 55 for background threads.",
            },
            minTimeAway: {
              type: "integer",
              minimum: 0,
              description:
                "Seconds the user must be away before this item appears. Use 0 for a roll-up the user should see immediately.",
            },
          },
          required: ["type", "title", "summary"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export interface RollupResult {
  /** Number of items actually written to the feed. */
  wroteCount: number;
  /**
   * When non-null, indicates the producer short-circuited and no LLM
   * call was made (or the call's result was unusable). The scheduler
   * logs this but does not treat it as an error.
   *
   * `no_actions` means there was nothing to roll up — a quiet but
   * normal outcome that does not advance the cooldown gate (no point
   * re-running until new actions land).
   */
  skippedReason:
    | "no_provider"
    | "no_actions"
    | "empty_items"
    | "provider_error"
    | "malformed_output"
    | null;
}

/**
 * Dependency seams exposed for tests. Production callers pass
 * `undefined` so the producer uses the real helpers. Tests pass
 * stubs to avoid `mock.module`, which leaks across files in Bun's
 * test runner and causes cross-file isolation bugs.
 */
export interface RollupProducerDeps {
  writeItem?: (params: WriteAssistantFeedItemParams) => Promise<unknown>;
  loadRelationshipState?: () => Promise<
    Awaited<ReturnType<typeof computeRelationshipState>>
  >;
  loadRecentActions?: () => FeedItem[];
  resolveProvider?: () => Provider | null;
}

/**
 * Run one roll-up pass. Loads recent action items from the feed plus
 * relationship state, builds a user prompt around them, asks the
 * provider for a `write_feed_items` tool call, and invokes
 * {@link writeAssistantFeedItem} for each item in the returned array.
 */
export async function runRollupProducer(
  now: Date = new Date(),
  deps: RollupProducerDeps = {},
): Promise<RollupResult> {
  const writeItem = deps.writeItem ?? writeAssistantFeedItem;
  const loadRelationshipState =
    deps.loadRelationshipState ?? computeRelationshipState;
  const loadRecentActions = deps.loadRecentActions ?? defaultLoadRecentActions;

  const provider = deps.resolveProvider
    ? deps.resolveProvider()
    : resolveDefaultProvider();
  if (!provider) {
    return { wroteCount: 0, skippedReason: "no_provider" };
  }

  const actions = loadRecentActions();
  if (actions.length === 0) {
    return { wroteCount: 0, skippedReason: "no_actions" };
  }

  const state = await loadRelationshipState();
  const userPrompt = buildUserPrompt(actions, state, now);

  let response;
  try {
    response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      [ROLLUP_TOOL_SCHEMA],
      ROLLUP_SYSTEM_PROMPT,
      {
        config: { max_tokens: ROLLUP_MAX_TOKENS },
        signal: AbortSignal.timeout(ROLLUP_TIMEOUT_MS),
      },
    );
  } catch (err) {
    log.warn({ err }, "Rollup provider.sendMessage failed");
    return { wroteCount: 0, skippedReason: "provider_error" };
  }

  const toolUse = response.content.find(
    (block) => block.type === "tool_use" && block.name === ROLLUP_TOOL_NAME,
  );
  if (!toolUse || toolUse.type !== "tool_use") {
    return { wroteCount: 0, skippedReason: "malformed_output" };
  }

  const input = toolUse.input as Record<string, unknown>;
  const rawItems = Array.isArray(input.items) ? input.items : null;
  if (!rawItems || rawItems.length === 0) {
    return { wroteCount: 0, skippedReason: "empty_items" };
  }

  const capped = rawItems.slice(0, MAX_ITEMS_PER_ROLLUP);
  const accepted: WriteAssistantFeedItemParams[] = [];
  for (const raw of capped) {
    const params = coerceRollupItem(raw);
    if (params) accepted.push(params);
  }

  // If the model returned items but every single one failed coercion,
  // that's a schema-drift signal we want loud in production logs — a
  // silent "wroteCount: 0, skippedReason: null" would look like a
  // normal quiet tick and bury the bug. Report it as malformed_output.
  if (accepted.length === 0) {
    return { wroteCount: 0, skippedReason: "malformed_output" };
  }

  let wroteCount = 0;
  for (const params of accepted) {
    try {
      await writeItem(params);
      wroteCount += 1;
    } catch (err) {
      // Schema rejection is a model-output bug, not a regression in the
      // writer — log and keep going so a single malformed item doesn't
      // block the rest of the batch.
      log.warn({ err, params }, "Failed to write rollup item");
    }
  }

  return { wroteCount, skippedReason: null };
}

function resolveDefaultProvider(): ReturnType<typeof getProvider> | null {
  const config = loadConfig();
  if (!listProviders().includes(config.services.inference.provider)) {
    return null;
  }
  return getProvider(config.services.inference.provider);
}

/**
 * Default recent-actions loader. Reads the TTL-filtered home feed,
 * keeps only `action` items, and returns them sorted by `createdAt`
 * descending so the most recent signals land at the top of the
 * prompt. Non-action items (digests, threads, nudges) are excluded
 * — the roll-up's input is the raw activity log, not the existing
 * consolidations.
 */
function defaultLoadRecentActions(): FeedItem[] {
  const feed = readHomeFeed();
  return feed.items
    .filter((i) => i.type === "action")
    .sort((a, b) => {
      const am = Date.parse(a.createdAt);
      const bm = Date.parse(b.createdAt);
      if (Number.isNaN(am) && Number.isNaN(bm)) return 0;
      if (Number.isNaN(am)) return 1;
      if (Number.isNaN(bm)) return -1;
      return bm - am;
    });
}

/**
 * Build the user-prompt context for one roll-up pass. Keeps the
 * relationship-state block small and bounds the action list at
 * {@link MAX_ACTIONS_IN_PROMPT} so a pathological input can't blow
 * the token budget.
 */
function buildUserPrompt(
  actions: FeedItem[],
  state: Awaited<ReturnType<typeof computeRelationshipState>>,
  now: Date,
): string {
  const actionLines = actions
    .slice(0, MAX_ACTIONS_IN_PROMPT)
    .map((a) => {
      const src = a.source ? `[${a.source}]` : "[-]";
      return `  - ${a.createdAt} ${src} ${a.title} — ${a.summary}`;
    })
    .join("\n");

  const factLines = state.facts
    .slice(0, 10)
    .map((f) => `  - ${f.category}: ${f.text}`)
    .join("\n");

  return [
    `Current time: ${now.toISOString()}`,
    `Assistant name: ${state.assistantName}`,
    state.userName ? `User name: ${state.userName}` : "User name: (unknown)",
    `Relationship tier: ${state.tier} / 4`,
    "",
    `Recent activity log entries (most recent first, up to ${MAX_ACTIONS_IN_PROMPT}):`,
    actionLines.length > 0 ? actionLines : "  (none)",
    "",
    "Known facts about the user (for context only — do NOT invent roll-ups from these):",
    factLines.length > 0 ? factLines : "  (none yet)",
    "",
    "Consolidate the activity log above into a small set of `digest` or `thread` roll-up items. Remember: prefer 0 items over filler, and only roll up when several related actions cluster into a coherent story. Use the `write_feed_items` tool.",
  ].join("\n");
}

/**
 * Coerce a raw tool_use item into
 * {@link WriteAssistantFeedItemParams}, returning null if the shape is
 * unrecoverable. The schema on the provider side enforces most of
 * this, but the runtime check guards against model drift — including
 * the `type` narrowing to digest/thread (actions and nudges are
 * rejected here even if the model ignores the tool schema).
 */
function coerceRollupItem(
  raw: unknown,
): WriteAssistantFeedItemParams | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const type = obj.type;
  if (type !== "digest" && type !== "thread") {
    return null;
  }

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!title || !summary) return null;

  const source = obj.source;
  let coercedSource: WriteAssistantFeedItemParams["source"];
  if (
    source === "gmail" ||
    source === "slack" ||
    source === "calendar" ||
    source === "assistant"
  ) {
    coercedSource = source;
  }

  const priority =
    typeof obj.priority === "number" && Number.isInteger(obj.priority)
      ? Math.max(0, Math.min(100, obj.priority))
      : undefined;

  const minTimeAway =
    typeof obj.minTimeAway === "number" && Number.isInteger(obj.minTimeAway)
      ? Math.max(0, obj.minTimeAway)
      : undefined;

  return {
    type,
    source: coercedSource,
    title,
    summary,
    priority,
    minTimeAway,
  };
}
