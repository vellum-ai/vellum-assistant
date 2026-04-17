import { and, asc, eq, gt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { AssistantConfig } from "../../config/types.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import {
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";
import { getConversationMemoryScopeId } from "../conversation-crud.js";
import { getDb } from "../db.js";
import { asString, truncate } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { memorySegments, memorySummaries } from "../schema.js";

const log = getLogger("memory-jobs-worker");

const SUMMARY_LLM_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_TOKENS = 1000;

const CONVERSATION_SUMMARY_SYSTEM_PROMPT = [
  "You compress conversation transcripts into compact summaries for semantic search and memory retrieval.",
  "Focus on durable facts, not transient discussion.",
  "Preserve: goals, decisions, constraints, preferences, names, technical details, actions taken.",
  "Remove: filler, pleasantries, tool invocation details, transient status updates.",
  "",
  "Return concise markdown:",
  "## Topic",
  "One-line description of what the conversation is about.",
  "## Key Facts",
  "Bullet points of concrete facts, names, decisions, preferences.",
  "## Outcomes",
  "What was decided, resolved, or accomplished.",
  "## Open Items",
  "Unresolved questions, pending tasks, or follow-ups (omit section if none).",
  "",
  "Target 400-800 tokens. Be thorough — capture nuance, tone, and relationship dynamics, not just facts.",
].join("\n");

export async function buildConversationSummaryJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;
  const db = getDb();

  const existing = db
    .select()
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "conversation"),
        eq(memorySummaries.scopeKey, conversationId),
      ),
    )
    .get();

  // Fetch only segments newer than what the existing summary already covers.
  // For first-time summaries, fetch all segments.
  const lastCoveredAt = existing
    ? Math.max(existing.startAt, existing.endAt)
    : 0;

  const conditions = [eq(memorySegments.conversationId, conversationId)];
  if (lastCoveredAt > 0) {
    conditions.push(gt(memorySegments.createdAt, lastCoveredAt));
  }

  const rows = db
    .select()
    .from(memorySegments)
    .where(and(...conditions))
    .orderBy(asc(memorySegments.createdAt))
    .all();
  if (rows.length === 0) return;

  // Build segment text for LLM input (already in chronological order)
  const segmentTexts = rows
    .map((row) => `[${row.role}] ${truncate(row.text, 600)}`)
    .join("\n\n");

  const summaryText = await summarizeWithLLM(
    config,
    CONVERSATION_SUMMARY_SYSTEM_PROMPT,
    existing?.summary ?? null,
    segmentTexts,
    "conversation",
  );

  // Inherit the conversation's memory scope so private conversation
  // summaries stay isolated from default-scope retrieval.
  const scopeId = getConversationMemoryScopeId(conversationId);

  const now = Date.now();
  const summaryId = existing?.id ?? uuid();
  const nextVersion = (existing?.version ?? 0) + 1;
  const earliestCovered = existing
    ? Math.min(existing.startAt, existing.endAt, rows[0].createdAt)
    : rows[0].createdAt;
  const latestCovered = rows[rows.length - 1].createdAt;

  db.insert(memorySummaries)
    .values({
      id: summaryId,
      scope: "conversation",
      scopeKey: conversationId,
      scopeId,
      summary: summaryText,
      tokenEstimate: estimateTextTokens(summaryText),
      version: nextVersion,
      startAt: earliestCovered,
      endAt: latestCovered,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [memorySummaries.scope, memorySummaries.scopeKey],
      set: {
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        version: sql`${memorySummaries.version} + 1`,
        scopeId,
        startAt: earliestCovered,
        endAt: latestCovered,
        updatedAt: now,
      },
    })
    .run();

  // Re-query to get the actual persisted row ID — during a race the ON CONFLICT
  // path keeps the winner's ID, not the pre-generated UUID from the loser.
  const actualRow = db
    .select({ id: memorySummaries.id })
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "conversation"),
        eq(memorySummaries.scopeKey, conversationId),
      ),
    )
    .get();
  if (actualRow) {
    enqueueMemoryJob("embed_summary", { summaryId: actualRow.id });
  }
}

async function summarizeWithLLM(
  config: AssistantConfig,
  systemPrompt: string,
  existingSummary: string | null,
  newContent: string,
  label: string,
): Promise<string> {
  const summarizationConfig = config.memory.summarization;
  if (!summarizationConfig.useLLM) {
    log.debug({ label }, "LLM summarization disabled, using fallback");
    return buildFallbackSummary(existingSummary, newContent, label);
  }

  const provider = await getConfiguredProvider("conversationSummarization");
  if (!provider) {
    log.debug(
      { label },
      "Configured provider unavailable for summarization, using fallback",
    );
    return buildFallbackSummary(existingSummary, newContent, label);
  }

  const userParts: string[] = [];
  if (existingSummary) {
    userParts.push(
      "### Existing Summary (update with new data, keep what is still relevant, remove superseded info)",
      existingSummary,
      "",
    );
  }
  userParts.push("### New Data", newContent);

  try {
    const { signal, cleanup } = createTimeout(SUMMARY_LLM_TIMEOUT_MS);
    try {
      const response = await provider.sendMessage(
        [userMessage(userParts.join("\n"))],
        undefined,
        systemPrompt,
        {
          config: {
            callSite: "conversationSummarization" as const,
            max_tokens: SUMMARY_MAX_TOKENS,
          },
          signal,
        },
      );
      cleanup();

      const text = extractText(response);
      if (text.length > 0) {
        log.debug(
          {
            label,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
          "LLM summarization completed",
        );
        return text;
      }

      log.warn(
        { label },
        "LLM summarization returned empty text, using fallback",
      );
      return buildFallbackSummary(existingSummary, newContent, label);
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message, label },
      "LLM summarization failed, using fallback",
    );
    return buildFallbackSummary(existingSummary, newContent, label);
  }
}

function buildFallbackSummary(
  existingSummary: string | null,
  newContent: string,
  label: string,
): string {
  const lines = newContent.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return existingSummary ?? `${label} (no content)`;
  const head = lines.slice(0, 3).map((l) => `- ${truncate(l.trim(), 200)}`);
  const tail =
    lines.length > 6
      ? lines.slice(-3).map((l) => `- ${truncate(l.trim(), 200)}`)
      : [];
  const parts = [`${label} summary`, "", ...head];
  if (tail.length > 0) parts.push("", "...", "", ...tail);
  return parts.join("\n");
}
