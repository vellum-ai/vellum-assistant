import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { estimateTextTokens } from "../../context/token-estimator.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import { resolveGuardianPersona } from "../../prompts/persona-resolver.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError, ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../checkpoints.js";
import { getConversationMemoryScopeId } from "../conversation-crud.js";
import { getDb } from "../db.js";
import { computeMemoryFingerprint } from "../fingerprint.js";
import {
  buildExtractionSystemPrompt,
  deduplicateItems,
  type ExtractedItem,
  EXTRACTION_KINDS,
  KIND_MIGRATION_MAP,
  type MemoryItemKind,
  type OverrideConfidence,
  parseScore,
  SUPERSEDE_KINDS,
  VALID_KINDS,
  VALID_OVERRIDE_CONFIDENCES,
} from "../items-extractor.js";
import { asString } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { extractTextFromStoredMessageContent } from "../message-content.js";
import { withQdrantBreaker } from "../qdrant-circuit-breaker.js";
import { getQdrantClient } from "../qdrant-client.js";
import {
  memoryItems,
  memoryItemSources,
  memorySummaries,
  messages,
} from "../schema.js";
import { isConversationFailed } from "../task-memory-cleanup.js";
import { clampUnitInterval } from "../validation.js";

const log = getLogger("memory-batch-extraction");

interface LLMBatchExtractedItem {
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  supersedes: string | null;
  overrideConfidence: string;
}

interface BatchExtractResult {
  items: LLMBatchExtractedItem[];
  extraction_summary: string;
  conversation_summary: string;
}

export async function batchExtractJob(job: MemoryJob): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  const payloadScopeId = asString(job.payload.scopeId);
  if (!conversationId) return;

  // If the conversation has been marked as failed, skip extraction entirely.
  if (isConversationFailed(conversationId)) {
    log.info(
      { conversationId },
      "Skipping batch extraction for failed conversation",
    );
    return;
  }

  const db = getDb();

  // Resolve scopeId: prefer payload, fall back to conversation's stored scope
  const scopeId =
    payloadScopeId ?? getConversationMemoryScopeId(conversationId);

  // ── Load unextracted messages ────────────────────────────────────────
  const lastMessageIdKey = `batch_extract:${conversationId}:last_message_id`;
  const lastExtractedMessageId = getMemoryCheckpoint(lastMessageIdKey);

  let unextractedMessages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
  }>;

  if (lastExtractedMessageId) {
    // Get the createdAt of the last extracted message so we can find messages after it
    const lastMsg = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, lastExtractedMessageId))
      .get();

    if (lastMsg) {
      unextractedMessages = db
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            gt(messages.createdAt, lastMsg.createdAt),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .all();
    } else {
      // Checkpoint references a deleted message — fetch all
      unextractedMessages = db
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt))
        .all();
    }
  } else {
    // No checkpoint — process all messages in the conversation
    unextractedMessages = db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all();
  }

  if (unextractedMessages.length === 0) {
    log.debug({ conversationId }, "No unextracted messages for batch extraction");
    // Reset pending count since there's nothing to extract
    setMemoryCheckpoint(
      `batch_extract:${conversationId}:pending_count`,
      "0",
    );
    return;
  }

  // ── Load running extraction summary ─────────────────────────────────
  const existingExtractionSummary = db
    .select({ summary: memorySummaries.summary })
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "extraction_context"),
        eq(memorySummaries.scopeKey, conversationId),
      ),
    )
    .get();

  // ── Load existing global items for supersession ─────────────────────
  // When fullReextract is set (re-extraction pass), load all active items
  // so the LLM can supersede as many old flat-fact memories as possible.
  const fullReextract = Boolean(job.payload.fullReextract);
  const existingItemsLimit = fullReextract ? 200 : 20;

  const existingItems = db
    .select({
      id: memoryItems.id,
      kind: memoryItems.kind,
      subject: memoryItems.subject,
      statement: memoryItems.statement,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.scopeId, scopeId),
        eq(memoryItems.status, "active"),
      ),
    )
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(existingItemsLimit)
    .all();

  // ── Build the batch extraction prompt ───────────────────────────────
  const userPersona = resolveGuardianPersona();
  const baseSystemPrompt = buildExtractionSystemPrompt(
    existingItems,
    "user", // batch processes both roles
    userPersona,
  );

  let systemPrompt = baseSystemPrompt;
  systemPrompt += `\n\nIMPORTANT: You are processing a batch of messages from a single conversation window, not individual messages. Extract items from the entire batch — look for cross-message patterns, evolving themes, and composite facts that only emerge from reading multiple messages together.`;

  if (existingExtractionSummary?.summary) {
    systemPrompt += `\n\nPreviously extracted from this conversation:\n${existingExtractionSummary.summary}`;
  }

  // ── Build user message from unextracted messages ────────────────────
  const assistantName = getAssistantName() ?? "the assistant";
  const messageParts: string[] = [];
  for (const msg of unextractedMessages) {
    const text = extractTextFromStoredMessageContent(msg.content);
    if (text.length === 0) continue;
    const roleLabel = msg.role === "assistant" ? assistantName : "user";
    const timestamp = new Date(msg.createdAt).toISOString();
    messageParts.push(`[${timestamp}] [${roleLabel}]: ${text}`);
  }

  if (messageParts.length === 0) {
    log.debug(
      { conversationId },
      "All unextracted messages have empty text content",
    );
    setMemoryCheckpoint(
      `batch_extract:${conversationId}:pending_count`,
      "0",
    );
    // Still update the last message ID checkpoint
    const lastMsg = unextractedMessages[unextractedMessages.length - 1];
    setMemoryCheckpoint(lastMessageIdKey, lastMsg.id);
    return;
  }

  const userContent = messageParts.join("\n\n");

  // ── Call LLM ────────────────────────────────────────────────────────
  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for batch memory extraction",
    );
  }

  const response = await provider.sendMessage(
    [userMessage(userContent)],
    [
      {
        name: "batch_extract_results",
        description:
          "Store extracted memory items and summaries from the conversation batch",
        input_schema: {
          type: "object" as const,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: EXTRACTION_KINDS,
                    description: "Category of memory item",
                  },
                  subject: {
                    type: "string",
                    description:
                      "Short label (2-8 words) for what this is about",
                  },
                  statement: {
                    type: "string",
                    description:
                      "Relationship-rich factual statement to remember (1-2 sentences). Include relational context.",
                  },
                  confidence: {
                    type: "number",
                    description: "Confidence that this is accurate (0.0-1.0)",
                  },
                  importance: {
                    type: "number",
                    description: "How valuable this is to remember (0.0-1.0)",
                  },
                  supersedes: {
                    type: ["string", "null"],
                    description:
                      "ID of the existing memory item this replaces, or null if not replacing anything",
                  },
                  overrideConfidence: {
                    type: "string",
                    enum: ["explicit", "tentative", "inferred"],
                    description:
                      "How confident you are that this overrides an existing item",
                  },
                },
                required: [
                  "kind",
                  "subject",
                  "statement",
                  "confidence",
                  "importance",
                  "supersedes",
                  "overrideConfidence",
                ],
              },
            },
            extraction_summary: {
              type: "string",
              description:
                "Updated summary of what has been extracted from this conversation so far",
            },
            conversation_summary: {
              type: "string",
              description: "Updated summary of the conversation so far",
            },
          },
          required: ["items", "extraction_summary", "conversation_summary"],
        },
      },
    ],
    systemPrompt,
    {
      config: {
        modelIntent: "quality-optimized" as const,
        tool_choice: {
          type: "tool" as const,
          name: "batch_extract_results",
        },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    throw new ProviderError(
      "No tool_use block in batch extraction LLM response",
      "unknown",
      502,
    );
  }

  const input = toolBlock.input as unknown as BatchExtractResult;
  if (!Array.isArray(input.items)) {
    throw new ProviderError(
      "Invalid items structure in batch extraction LLM response",
      "unknown",
      502,
    );
  }

  // Guard: re-check after the async LLM call
  if (isConversationFailed(conversationId)) {
    log.info(
      { conversationId },
      "Skipping upsert — conversation marked failed during batch extraction",
    );
    return;
  }

  // ── Validate and process extracted items ────────────────────────────
  const existingItemIds = new Set(existingItems.map((e) => e.id));

  const validatedItems: ExtractedItem[] = [];
  for (const raw of input.items) {
    const resolvedKind = KIND_MIGRATION_MAP[raw.kind] ?? raw.kind;
    if (resolvedKind === "journal") continue;
    if (!VALID_KINDS.has(resolvedKind)) continue;
    if (!raw.subject || !raw.statement) continue;
    const subject = String(raw.subject).trim();
    const statement = String(raw.statement).trim();
    const confidence = clampUnitInterval(parseScore(raw.confidence, 0.5));
    const importance = clampUnitInterval(parseScore(raw.importance, 0.5));
    const fingerprint = computeMemoryFingerprint(
      scopeId,
      resolvedKind,
      subject,
      statement,
    );

    const rawSupersedes =
      typeof raw.supersedes === "string" && raw.supersedes.length > 0
        ? raw.supersedes
        : null;
    const supersedes =
      rawSupersedes && existingItemIds.has(rawSupersedes)
        ? rawSupersedes
        : null;
    const supersedesRejected = !!rawSupersedes && !supersedes;
    const overrideConfidence = VALID_OVERRIDE_CONFIDENCES.has(
      raw.overrideConfidence,
    )
      ? (raw.overrideConfidence as OverrideConfidence)
      : "inferred";

    validatedItems.push({
      kind: resolvedKind as MemoryItemKind,
      subject,
      statement,
      confidence,
      importance,
      fingerprint,
      supersedes,
      overrideConfidence,
      supersedesRejected,
    });
  }

  const dedupedItems = deduplicateItems(validatedItems);

  // ── Upsert extracted items ──────────────────────────────────────────
  // Use the last message in the batch as the source message for all items
  const lastMessage = unextractedMessages[unextractedMessages.length - 1];
  let upserted = 0;

  for (const item of dedupedItems) {
    const seenAt = lastMessage.createdAt;
    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, item.fingerprint),
          eq(memoryItems.scopeId, scopeId),
        ),
      )
      .get();

    let memoryItemId: string;
    let effectiveStatus: string = "active";
    if (existing) {
      memoryItemId = existing.id;
      effectiveStatus = "active";
      const effectiveSourceType =
        existing.sourceType === "tool"
          ? "tool"
          : existing.sourceType === "journal_carry_forward"
            ? "journal_carry_forward"
            : "extraction";
      const effectiveVerificationState =
        existing.verificationState === "user_reported"
          ? "user_reported"
          : existing.verificationState === "user_confirmed"
            ? "user_confirmed"
            : "assistant_inferred";

      db.update(memoryItems)
        .set({
          status: effectiveStatus,
          confidence: clampUnitInterval(
            Math.max(existing.confidence, item.confidence),
          ),
          importance: clampUnitInterval(
            fullReextract
              ? item.importance
              : Math.max(existing.importance ?? 0, item.importance),
          ),
          lastSeenAt: Math.max(existing.lastSeenAt, seenAt),
          sourceType: effectiveSourceType,
          verificationState: effectiveVerificationState,
        })
        .where(eq(memoryItems.id, existing.id))
        .run();
    } else {
      memoryItemId = uuid();
      db.insert(memoryItems)
        .values({
          id: memoryItemId,
          kind: item.kind,
          subject: item.subject,
          statement: item.statement,
          status: "active",
          confidence: item.confidence,
          importance: item.importance,
          fingerprint: item.fingerprint,
          sourceType: "extraction",
          verificationState: "assistant_inferred",
          scopeId,
          firstSeenAt: lastMessage.createdAt,
          lastSeenAt: seenAt,
          lastUsedAt: null,
          supersedes: item.supersedes,
          overrideConfidence: item.overrideConfidence,
        })
        .run();
      upserted += 1;
    }

    // Handle LLM-directed supersession based on overrideConfidence
    if (
      item.supersedes &&
      item.supersedes !== memoryItemId &&
      item.overrideConfidence === "explicit" &&
      effectiveStatus === "active"
    ) {
      const oldItem = db
        .select({ id: memoryItems.id })
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.id, item.supersedes),
            eq(memoryItems.scopeId, scopeId),
            eq(memoryItems.status, "active"),
          ),
        )
        .get();

      if (oldItem) {
        db.update(memoryItems)
          .set({
            status: "superseded",
            supersededBy: memoryItemId,
          })
          .where(eq(memoryItems.id, oldItem.id))
          .run();

        db.update(memoryItems)
          .set({ supersedes: oldItem.id })
          .where(eq(memoryItems.id, memoryItemId))
          .run();

        try {
          const qdrant = getQdrantClient();
          await withQdrantBreaker(() =>
            qdrant.deleteByTarget("item", oldItem.id),
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: errMsg, oldItemId: oldItem.id },
            "Failed to remove superseded item from Qdrant — will be cleaned up by index maintenance",
          );
        }

        log.debug(
          { newItemId: memoryItemId, oldItemId: oldItem.id },
          "Explicitly superseded memory item (batch)",
        );
      }
    } else if (item.supersedes && item.overrideConfidence === "tentative") {
      log.debug(
        {
          newItemId: memoryItemId,
          supersedes: item.supersedes,
          overrideConfidence: "tentative",
        },
        "Tentative override — both items coexist (batch)",
      );
    } else if (item.supersedes && item.overrideConfidence === "inferred") {
      log.debug(
        {
          newItemId: memoryItemId,
          supersedes: item.supersedes,
          overrideConfidence: "inferred",
        },
        "Inferred override — both items coexist (batch)",
      );
    }

    // Fallback subject-match supersession
    if (
      !item.supersedes &&
      !item.supersedesRejected &&
      SUPERSEDE_KINDS.has(item.kind) &&
      effectiveStatus === "active"
    ) {
      db.update(memoryItems)
        .set({ status: "superseded" })
        .where(
          and(
            eq(memoryItems.kind, item.kind),
            eq(memoryItems.subject, item.subject),
            eq(memoryItems.status, "active"),
            eq(memoryItems.scopeId, scopeId),
            sql`${memoryItems.id} <> ${memoryItemId}`,
          ),
        )
        .run();
    }

    // Record source linkage for the last message in the batch
    db.insert(memoryItemSources)
      .values({
        memoryItemId,
        messageId: lastMessage.id,
        evidence: item.statement,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();

    enqueueMemoryJob("embed_item", { itemId: memoryItemId });
  }

  // ── Update running extraction summary ───────────────────────────────
  if (input.extraction_summary) {
    const now = Date.now();
    const summaryId =
      existingExtractionSummary
        ? db
            .select({ id: memorySummaries.id })
            .from(memorySummaries)
            .where(
              and(
                eq(memorySummaries.scope, "extraction_context"),
                eq(memorySummaries.scopeKey, conversationId),
              ),
            )
            .get()?.id ?? uuid()
        : uuid();

    db.insert(memorySummaries)
      .values({
        id: summaryId,
        scope: "extraction_context",
        scopeKey: conversationId,
        scopeId,
        summary: input.extraction_summary,
        tokenEstimate: estimateTextTokens(input.extraction_summary),
        version: 1,
        startAt: unextractedMessages[0].createdAt,
        endAt: lastMessage.createdAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [memorySummaries.scope, memorySummaries.scopeKey],
        set: {
          summary: input.extraction_summary,
          tokenEstimate: estimateTextTokens(input.extraction_summary),
          version: sql`${memorySummaries.version} + 1`,
          scopeId,
          endAt: lastMessage.createdAt,
          updatedAt: now,
        },
      })
      .run();
  }

  // ── Update conversation summary ─────────────────────────────────────
  if (input.conversation_summary) {
    const now = Date.now();
    const existingConvSummary = db
      .select({ id: memorySummaries.id })
      .from(memorySummaries)
      .where(
        and(
          eq(memorySummaries.scope, "conversation"),
          eq(memorySummaries.scopeKey, conversationId),
        ),
      )
      .get();

    const convSummaryId = existingConvSummary?.id ?? uuid();

    db.insert(memorySummaries)
      .values({
        id: convSummaryId,
        scope: "conversation",
        scopeKey: conversationId,
        scopeId,
        summary: input.conversation_summary,
        tokenEstimate: estimateTextTokens(input.conversation_summary),
        version: 1,
        startAt: unextractedMessages[0].createdAt,
        endAt: lastMessage.createdAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [memorySummaries.scope, memorySummaries.scopeKey],
        set: {
          summary: input.conversation_summary,
          tokenEstimate: estimateTextTokens(input.conversation_summary),
          version: sql`${memorySummaries.version} + 1`,
          scopeId,
          endAt: lastMessage.createdAt,
          updatedAt: now,
        },
      })
      .run();

    // Re-query to get the persisted row ID and enqueue embed job
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

  // ── Update checkpoints ──────────────────────────────────────────────
  setMemoryCheckpoint(lastMessageIdKey, lastMessage.id);
  setMemoryCheckpoint(
    `batch_extract:${conversationId}:pending_count`,
    "0",
  );

  log.info(
    {
      conversationId,
      messagesProcessed: unextractedMessages.length,
      itemsExtracted: dedupedItems.length,
      itemsUpserted: upserted,
    },
    "Batch extraction completed",
  );
}
