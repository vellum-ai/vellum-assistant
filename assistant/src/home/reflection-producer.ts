/**
 * Assistant reflection producer for the home activity feed.
 *
 * On a tick, asks the configured inference provider "given this
 * relationship state, is there anything worth nudging the user about
 * right now?" and emits 0–N assistant-authored feed items. Mirrors the
 * background-inference pattern established in `approval-generators.ts`:
 * resolve the provider from config, call `provider.sendMessage` with a
 * `tool_use`-shaped structured output schema, validate each returned
 * block, and hand the validated shapes to `writeAssistantFeedItem`.
 *
 * Budget notes:
 *
 *   - Hard cap: {@link MAX_ITEMS_PER_REFLECTION} items per tick so a
 *     single run can never flood the feed.
 *   - Timeout: {@link REFLECTION_TIMEOUT_MS} so a stalled provider
 *     can't stall the tick loop.
 *   - Token budget: {@link REFLECTION_MAX_TOKENS} — tight, because
 *     the output is a list of short feed items, not a long essay.
 *
 * Failure modes degrade gracefully: an unavailable provider, a
 * malformed tool_use block, a schema-rejected item, or an exception
 * in the inner loop all return a {@link ReflectionResult} with the
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
import { computeRelationshipState } from "./relationship-state-writer.js";

const log = getLogger("home-feed-reflection");

const REFLECTION_TIMEOUT_MS = 30_000;
const REFLECTION_MAX_TOKENS = 800;
const MAX_ITEMS_PER_REFLECTION = 3;

const REFLECTION_TOOL_NAME = "write_feed_items";

const REFLECTION_SYSTEM_PROMPT = [
  "You are a background reflection loop for a personal assistant.",
  "Your job is to decide whether there is anything worth surfacing to the user on their Home page right now.",
  "",
  "Rules:",
  "- Emit nudges only when there is a CLEAR, SPECIFIC, ACTIONABLE reason.",
  "- Never emit generic filler like 'stay productive' or 'here's a suggestion'.",
  "- Never repeat the same nudge on consecutive runs — trust the writer's one-per-source replacement to dedupe.",
  "- Prefer 0 items over low-quality items.",
  "- You may emit up to 3 items total.",
  "",
  "Use the `write_feed_items` tool to emit items. If nothing is worth surfacing, call the tool with an empty `items` array.",
].join("\n");

const REFLECTION_TOOL_SCHEMA = {
  name: REFLECTION_TOOL_NAME,
  description:
    "Record the set of feed items to surface on the user's Home page for this reflection tick. " +
    "Pass an empty `items` array if nothing is worth surfacing right now.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        maxItems: MAX_ITEMS_PER_REFLECTION,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["nudge", "digest", "action", "thread"],
              description:
                "The visual shape: nudge (card with action buttons), digest (summary row), action (already-done announcement), thread (ongoing situation).",
            },
            source: {
              type: "string",
              enum: ["gmail", "slack", "calendar", "assistant"],
              description:
                "Origin hint used for the icon. Use 'assistant' when the nudge is self-initiated.",
            },
            title: {
              type: "string",
              description:
                "Short headline, 4–10 words. Lowercase-sentence-case, no period.",
            },
            summary: {
              type: "string",
              description:
                "One-sentence body copy explaining the nudge. 1–25 words.",
            },
            priority: {
              type: "integer",
              minimum: 0,
              maximum: 100,
              description:
                "Relative importance (higher = more prominent). Use 70 for normal nudges, 85 for time-sensitive, 55 for background threads.",
            },
            minTimeAway: {
              type: "integer",
              minimum: 0,
              description:
                "Seconds the user must be away before this item appears. Use 3600 (1h) for nudges, 0 for threads the user should see immediately.",
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

export interface ReflectionResult {
  /** Number of items actually written to the feed. */
  wroteCount: number;
  /**
   * When non-null, indicates the producer short-circuited and no LLM
   * call was made (or the call's result was unusable). The scheduler
   * logs this but does not treat it as an error.
   */
  skippedReason:
    | "no_provider"
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
export interface ReflectionProducerDeps {
  writeItem?: (params: WriteAssistantFeedItemParams) => Promise<unknown>;
  loadRelationshipState?: () => Promise<
    Awaited<ReturnType<typeof computeRelationshipState>>
  >;
  resolveProvider?: () => Provider | null;
}

/**
 * Run one reflection pass. Loads the current relationship state,
 * builds a user prompt around it, asks the provider for a
 * `write_feed_items` tool call, and invokes
 * {@link writeAssistantFeedItem} for each item in the returned array.
 */
export async function runReflectionProducer(
  now: Date = new Date(),
  deps: ReflectionProducerDeps = {},
): Promise<ReflectionResult> {
  const writeItem = deps.writeItem ?? writeAssistantFeedItem;
  const loadRelationshipState =
    deps.loadRelationshipState ?? computeRelationshipState;

  const provider = deps.resolveProvider
    ? deps.resolveProvider()
    : resolveDefaultProvider();
  if (!provider) {
    return { wroteCount: 0, skippedReason: "no_provider" };
  }

  const state = await loadRelationshipState();
  const userPrompt = buildUserPrompt(state, now);

  let response;
  try {
    response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      [REFLECTION_TOOL_SCHEMA],
      REFLECTION_SYSTEM_PROMPT,
      {
        config: { max_tokens: REFLECTION_MAX_TOKENS },
        signal: AbortSignal.timeout(REFLECTION_TIMEOUT_MS),
      },
    );
  } catch (err) {
    log.warn({ err }, "Reflection provider.sendMessage failed");
    return { wroteCount: 0, skippedReason: "provider_error" };
  }

  const toolUse = response.content.find(
    (block) => block.type === "tool_use" && block.name === REFLECTION_TOOL_NAME,
  );
  if (!toolUse || toolUse.type !== "tool_use") {
    return { wroteCount: 0, skippedReason: "malformed_output" };
  }

  const input = toolUse.input as Record<string, unknown>;
  const rawItems = Array.isArray(input.items) ? input.items : null;
  if (!rawItems || rawItems.length === 0) {
    return { wroteCount: 0, skippedReason: "empty_items" };
  }

  const capped = rawItems.slice(0, MAX_ITEMS_PER_REFLECTION);
  const accepted: WriteAssistantFeedItemParams[] = [];
  for (const raw of capped) {
    const params = coerceReflectionItem(raw);
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
      log.warn({ err, params }, "Failed to write reflection item");
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
 * Build the user-prompt context for one reflection pass. Kept small:
 * the system prompt already enumerates the rules, and extra context
 * mostly encourages hallucination. Only include fields that meaningfully
 * change what's worth surfacing.
 */
function buildUserPrompt(
  state: Awaited<ReturnType<typeof computeRelationshipState>>,
  now: Date,
): string {
  const factLines = state.facts
    .slice(0, 20)
    .map((f) => `  - ${f.category}: ${f.text}`)
    .join("\n");

  return [
    `Current time: ${now.toISOString()}`,
    `Assistant name: ${state.assistantName}`,
    state.userName ? `User name: ${state.userName}` : "User name: (unknown)",
    `Relationship tier: ${state.tier} / 4`,
    `Progress toward next tier: ${state.progressPercent}%`,
    `Conversation count: ${state.conversationCount}`,
    "",
    "Known facts about the user:",
    factLines.length > 0 ? factLines : "  (none yet)",
    "",
    "Based on this, is there anything worth nudging the user about right now? Remember: prefer 0 items over filler. Use the `write_feed_items` tool.",
  ].join("\n");
}

/**
 * Coerce a raw tool_use item into
 * {@link WriteAssistantFeedItemParams}, returning null if the shape is
 * unrecoverable. The schema on the provider side enforces most of
 * this, but the runtime check guards against model drift.
 */
function coerceReflectionItem(
  raw: unknown,
): WriteAssistantFeedItemParams | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const type = obj.type;
  if (
    type !== "nudge" &&
    type !== "digest" &&
    type !== "action" &&
    type !== "thread"
  ) {
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
