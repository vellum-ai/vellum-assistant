import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
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
import {
  asString,
  currentMonthWindow,
  currentWeekWindow,
  truncate,
} from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { memoryItems, memorySegments, memorySummaries } from "../schema.js";

const log = getLogger("memory-jobs-worker");

const SUMMARY_LLM_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_TOKENS = 800;

const CONVERSATION_SUMMARY_SYSTEM_PROMPT = [
  "You are a memory summarization system. Your job is to produce a compact, information-dense summary of a conversation.",
  "",
  "Guidelines:",
  "- Focus on key facts, decisions, user preferences, and actionable information.",
  "- Preserve concrete details: names, file paths, tool choices, technical decisions, constraints.",
  "- Remove filler, pleasantries, and transient discussion that has no lasting value.",
  "- Use concise bullet points grouped by topic.",
  "- Target 400-600 tokens. Be dense but readable.",
  "- If updating an existing summary with new data, merge new information and remove anything that was superseded.",
].join("\n");

const GLOBAL_SUMMARY_SYSTEM_PROMPT = [
  "You are a memory summarization system. Your job is to synthesize a higher-level summary from multiple conversation summaries and memory items.",
  "",
  "Guidelines:",
  "- Identify recurring themes, cross-cutting decisions, and persistent user preferences.",
  "- Highlight the most important facts, active projects, and ongoing concerns.",
  "- De-duplicate information that appears across multiple conversations.",
  "- Use concise sections with bullet points.",
  "- Target 400-600 tokens. Be dense but readable.",
  "- If updating an existing summary with new data, merge new information and remove anything that was superseded.",
].join("\n");

export async function buildConversationSummaryJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;
  const db = getDb();
  const rows = db
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.conversationId, conversationId))
    .orderBy(desc(memorySegments.createdAt))
    .limit(40)
    .all();
  if (rows.length === 0) return;

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

  // Build segment text for LLM input (chronological order)
  const segmentTexts = rows
    .slice(0, 30)
    .reverse()
    .map((row) => `[${row.role}] ${truncate(row.text, 400)}`)
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
  db.insert(memorySummaries)
    .values({
      id: summaryId,
      scope: "conversation",
      scopeKey: conversationId,
      scopeId,
      summary: summaryText,
      tokenEstimate: estimateTextTokens(summaryText),
      version: nextVersion,
      startAt: rows[rows.length - 1].createdAt,
      endAt: rows[0].createdAt,
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
        startAt: rows[rows.length - 1].createdAt,
        endAt: rows[0].createdAt,
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

export async function buildGlobalSummaryJob(
  scope: "weekly_global" | "monthly_global",
  config: AssistantConfig,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const { startMs, endMs, scopeKey } =
    scope === "weekly_global"
      ? currentWeekWindow(now)
      : currentMonthWindow(now);

  const items = db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.status, "active"),
        isNull(memoryItems.invalidAt),
        eq(memoryItems.scopeId, "default"),
        gte(memoryItems.lastSeenAt, startMs),
        lt(memoryItems.lastSeenAt, endMs),
      ),
    )
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(80)
    .all();

  // Gather conversation summaries from this period for higher-level synthesis
  const convSummaries = db
    .select()
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "conversation"),
        eq(memorySummaries.scopeId, "default"),
        gte(memorySummaries.endAt, startMs),
        lt(memorySummaries.startAt, endMs),
      ),
    )
    .orderBy(desc(memorySummaries.endAt))
    .limit(20)
    .all();

  if (items.length === 0 && convSummaries.length === 0) return;

  // Build input for LLM: conversation summaries + active items
  const parts: string[] = [];
  if (convSummaries.length > 0) {
    parts.push("## Conversation Summaries");
    for (const cs of convSummaries) {
      parts.push(`### ${cs.scopeKey}\n${truncate(cs.summary, 600)}`);
    }
  }
  if (items.length > 0) {
    parts.push("## Active Memory Items");
    for (const item of items.slice(0, 40)) {
      parts.push(
        `- [${item.kind}] ${item.subject}: ${truncate(item.statement, 180)}`,
      );
    }
  }
  const inputText = parts.join("\n\n");

  const existing = db
    .select()
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, scope),
        eq(memorySummaries.scopeKey, scopeKey),
      ),
    )
    .get();

  const label = scope === "weekly_global" ? "weekly" : "monthly";
  const summaryText = await summarizeWithLLM(
    config,
    GLOBAL_SUMMARY_SYSTEM_PROMPT,
    existing?.summary ?? null,
    inputText,
    label,
  );

  const ts = Date.now();
  const summaryId = existing?.id ?? uuid();
  db.insert(memorySummaries)
    .values({
      id: summaryId,
      scope,
      scopeKey,
      summary: summaryText,
      tokenEstimate: estimateTextTokens(summaryText),
      version: (existing?.version ?? 0) + 1,
      startAt: startMs,
      endAt: endMs,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [memorySummaries.scope, memorySummaries.scopeKey],
      set: {
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        version: sql`${memorySummaries.version} + 1`,
        startAt: startMs,
        endAt: endMs,
        updatedAt: ts,
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
        eq(memorySummaries.scope, scope),
        eq(memorySummaries.scopeKey, scopeKey),
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

  const provider = getConfiguredProvider();
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
            modelIntent: summarizationConfig.modelIntent,
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
  _existingSummary: string | null,
  newContent: string,
  label: string,
): string {
  const lines = newContent.split("\n").filter((l) => l.trim().length > 0);
  const snippets = lines
    .slice(0, 20)
    .map((l) => `- ${truncate(l.trim(), 180)}`);
  const parts: string[] = [`${label} summary`, "", ...snippets];
  return parts.join("\n");
}
