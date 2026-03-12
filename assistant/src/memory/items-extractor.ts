import { and, eq, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { MemoryExtractionConfig } from "../config/types.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { getDb } from "./db.js";
import { computeMemoryFingerprint } from "./fingerprint.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { extractTextFromStoredMessageContent } from "./message-content.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { getQdrantClient } from "./qdrant-client.js";
import {
  memoryItems,
  memoryItemSources,
  messages,
} from "./schema.js";
import { isConversationFailed } from "./task-memory-cleanup.js";
import { clampUnitInterval } from "./validation.js";

const log = getLogger("memory-items-extractor");

export type MemoryItemKind =
  | "identity"
  | "preference"
  | "project"
  | "decision"
  | "constraint"
  | "event";

export type OverrideConfidence = "explicit" | "tentative" | "inferred";

interface ExtractedItem {
  kind: MemoryItemKind;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  fingerprint: string;
  supersedes: string | null;
  overrideConfidence: OverrideConfidence;
}

const VALID_KINDS = new Set<string>([
  "identity",
  "preference",
  "project",
  "decision",
  "constraint",
  "event",
]);

/** Maps old kind names to their new equivalents for graceful migration. */
const KIND_MIGRATION_MAP: Record<string, MemoryItemKind> = {
  profile: "identity",
  fact: "identity",
  relationship: "identity",
  opinion: "preference",
  todo: "project",
  instruction: "constraint",
  style: "preference",
};

const SUPERSEDE_KINDS = new Set<MemoryItemKind>([
  "identity",
  "preference",
  "project",
  "decision",
  "constraint",
]);

// ── Semantic density gating ────────────────────────────────────────────
// Skip messages that are too short or consist of low-value filler.

const LOW_VALUE_PATTERNS = new Set([
  "ok",
  "okay",
  "k",
  "sure",
  "yes",
  "no",
  "yep",
  "nope",
  "yeah",
  "nah",
  "thanks",
  "thank you",
  "ty",
  "thx",
  "thanks!",
  "thank you!",
  "got it",
  "understood",
  "makes sense",
  "sounds good",
  "sounds great",
  "cool",
  "nice",
  "great",
  "awesome",
  "perfect",
  "done",
  "lgtm",
  "agreed",
  "right",
  "correct",
  "exactly",
  "yup",
  "ack",
  "hm",
  "hmm",
  "hmmm",
  "ah",
  "oh",
  "i see",
]);

function hasSemanticDensity(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 15) return false;
  const lower = trimmed.toLowerCase().replace(/[.!?,;:\s]+$/, "");
  if (LOW_VALUE_PATTERNS.has(lower)) return false;
  // Very short messages with only 1-2 words are typically not memorable
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 2) return false;
  return true;
}

// ── LLM-powered extraction ────────────────────────────────────────────

function buildExtractionSystemPrompt(
  existingItems: Array<{
    id: string;
    kind: string;
    subject: string;
    statement: string;
  }>,
): string {
  let prompt = `You are a memory extraction system. Given a message from a conversation, extract structured memory items that would be valuable to remember for future interactions.

Extract items in these categories:
- identity: Personal info (name, role, location, timezone, background), notable facts, relationships between people/teams/systems
- preference: User likes, dislikes, preferred approaches/tools/styles, communication style patterns, opinions and evaluations
- project: Project names, repos, tech stacks, architecture details, action items, follow-ups, things to do later
- decision: Choices made, approaches selected, trade-offs resolved
- constraint: Rules, requirements, things that must/must not be done, explicit directives on how the assistant should behave
- event: Deadlines, milestones, meetings, releases, dates

For each item, provide:
- kind: One of the categories above
- subject: A short label (2-8 words) identifying what this is about
- statement: A relationship-rich factual statement to remember (1-2 sentences). Include relational context — who recommended it, why it matters, how it connects to other facts. For example, write "Data processing library that Sarah from Marketing recommended for the Q4 pipeline rewrite" instead of just "Uses pandas".
- confidence: How confident you are this is accurate (0.0-1.0)
- importance: How valuable this is to remember (0.0-1.0)
  - 1.0: Explicit user instructions about assistant behavior
  - 0.8-0.9: Personal facts, strong preferences, key decisions
  - 0.6-0.7: Project details, constraints, opinions
  - 0.3-0.5: Contextual details, minor preferences
- supersedes: If this item replaces an existing memory item, set this to the ID of the item it replaces. Use null if it does not replace anything. Determine supersession by understanding the semantic meaning — do not rely on keyword matching.
- overrideConfidence: How confident you are that this overrides an existing item:
  - "explicit": Clear override signal (e.g., "Actually I now prefer X", "I changed my mind about Y", "We switched from A to B")
  - "tentative": Ambiguous — the new information might override the old, but it's not certain
  - "inferred": Weak signal — possibly related to an existing item but no clear override intent

Rules:
- Only extract genuinely memorable information. Skip pleasantries, filler, and transient discussion.
- Do NOT extract information about what tools the assistant used or what files it read — only extract substantive facts about the user, their projects, and their preferences.
- Do NOT extract claims about actions the assistant performed, outcomes it achieved, or progress it reported (e.g., "I booked an appointment", "I sent the email"). Only extract facts stated by the user or from external sources — the assistant's self-reports are not reliable memory material.
- Prefer fewer high-quality items over many low-quality ones.
- If the message contains no memorable information, return an empty array.`;

  if (existingItems.length > 0) {
    prompt += `\n\nExisting memory items (use these to identify supersession targets — set \`supersedes\` to the item ID if the new information replaces one of these):\n`;
    for (const item of existingItems) {
      prompt += `- [${item.id}] (${item.kind}) ${item.subject}: ${item.statement}\n`;
    }
  }

  return prompt;
}

const VALID_OVERRIDE_CONFIDENCES = new Set<string>([
  "explicit",
  "tentative",
  "inferred",
]);

interface LLMExtractedItem {
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  supersedes: string | null;
  overrideConfidence: string;
}

/**
 * Query top-10 active items by kind + subject similarity to give the
 * extraction LLM awareness of existing items it might supersede.
 * This is a write-path-only heuristic — not used at read time.
 */
function queryExistingItemsForContext(
  scopeId: string,
  text: string,
): Array<{ id: string; kind: string; subject: string; statement: string }> {
  const db = getDb();

  // Extract a rough subject prefix from the first few words of the text
  const words = text.trim().split(/\s+/).slice(0, 3).join(" ");
  const subjectPrefix = words.length > 0 ? `${words}%` : "%";

  // Query active items matching subject prefix, limited to 10
  const rows = db
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
        like(memoryItems.subject, subjectPrefix),
      ),
    )
    .limit(10)
    .all();

  // If prefix match yielded few results, backfill with recent active items
  if (rows.length < 10) {
    const existingIds = new Set(rows.map((r) => r.id));
    const backfill = db
      .select({
        id: memoryItems.id,
        kind: memoryItems.kind,
        subject: memoryItems.subject,
        statement: memoryItems.statement,
      })
      .from(memoryItems)
      .where(
        and(eq(memoryItems.scopeId, scopeId), eq(memoryItems.status, "active")),
      )
      .limit(10 - rows.length)
      .all();

    for (const row of backfill) {
      if (!existingIds.has(row.id)) {
        rows.push(row);
        existingIds.add(row.id);
      }
    }
  }

  return rows;
}

async function extractItemsWithLLM(
  text: string,
  extractionConfig: MemoryExtractionConfig,
  scopeId: string,
): Promise<ExtractedItem[]> {
  const provider = getConfiguredProvider();
  if (!provider) {
    log.debug(
      "Configured provider unavailable for LLM extraction, falling back to pattern-based",
    );
    return extractItemsPatternBased(text, scopeId);
  }

  try {
    const { signal, cleanup } = createTimeout(15000);

    try {
      // Query existing items to give the LLM supersession context
      const existingItems = queryExistingItemsForContext(scopeId, text);
      const systemPrompt = buildExtractionSystemPrompt(existingItems);

      const response = await provider.sendMessage(
        [userMessage(text)],
        [
          {
            name: "store_memory_items",
            description: "Store extracted memory items from the message",
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
                        enum: [...VALID_KINDS],
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
                        description:
                          "Confidence that this is accurate (0.0-1.0)",
                      },
                      importance: {
                        type: "number",
                        description:
                          "How valuable this is to remember (0.0-1.0)",
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
                          "How confident you are that this overrides an existing item: explicit (clear override), tentative (ambiguous), inferred (weak signal)",
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
              },
              required: ["items"],
            },
          },
        ],
        systemPrompt,
        {
          config: {
            modelIntent: extractionConfig.modelIntent,
            max_tokens: 1024,
            tool_choice: { type: "tool" as const, name: "store_memory_items" },
          },
          signal,
        },
      );
      cleanup();

      const toolBlock = extractToolUse(response);
      if (!toolBlock) {
        log.warn(
          "No tool_use block in LLM extraction response, falling back to pattern-based",
        );
        return extractItemsPatternBased(text, scopeId);
      }

      const input = toolBlock.input as { items?: LLMExtractedItem[] };
      if (!Array.isArray(input.items)) {
        log.warn(
          "Invalid items in LLM extraction response, falling back to pattern-based",
        );
        return extractItemsPatternBased(text, scopeId);
      }

      const items: ExtractedItem[] = [];
      for (const raw of input.items) {
        // Apply kind migration map for old kind names, then validate
        const resolvedKind = KIND_MIGRATION_MAP[raw.kind] ?? raw.kind;
        if (!VALID_KINDS.has(resolvedKind)) continue;
        if (!raw.subject || !raw.statement) continue;
        const subject = truncate(String(raw.subject), 80, "");
        const statement = truncate(String(raw.statement), 500, "");
        const confidence = clampUnitInterval(parseScore(raw.confidence, 0.5));
        const importance = clampUnitInterval(parseScore(raw.importance, 0.5));
        const fingerprint = computeMemoryFingerprint(
          scopeId,
          resolvedKind,
          subject,
          statement,
        );

        // Validate supersedes: must reference a known existing item ID
        const supersedes =
          typeof raw.supersedes === "string" && raw.supersedes.length > 0
            ? raw.supersedes
            : null;
        const overrideConfidence = VALID_OVERRIDE_CONFIDENCES.has(
          raw.overrideConfidence,
        )
          ? (raw.overrideConfidence as OverrideConfidence)
          : "inferred";

        items.push({
          kind: resolvedKind as MemoryItemKind,
          subject,
          statement,
          confidence,
          importance,
          fingerprint,
          supersedes,
          overrideConfidence,
        });
      }

      return deduplicateItems(items);
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "LLM extraction failed, falling back to pattern-based",
    );
    return extractItemsPatternBased(text, scopeId);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export async function extractAndUpsertMemoryItemsForMessage(
  messageId: string,
  scopeId?: string,
  conversationId?: string,
): Promise<number> {
  const db = getDb();
  const message = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  if (!message) return 0;

  const text = extractTextFromStoredMessageContent(message.content);
  if (!hasSemanticDensity(text)) {
    log.debug(
      { messageId },
      "Skipping extraction — message lacks semantic density",
    );
    return 0;
  }

  const config = getConfig();
  const extractionConfig = config.memory.extraction;
  const effectiveScopeId = scopeId ?? "default";
  const extracted = extractionConfig.useLLM
    ? await extractItemsWithLLM(text, extractionConfig, effectiveScopeId)
    : extractItemsPatternBased(text, effectiveScopeId);

  if (extracted.length === 0) return 0;

  // Guard: re-check after the async LLM call. The event loop yields during
  // extractItemsWithLLM, so another task could have marked the conversation
  // as failed in the meantime. Bail before writing to the DB.
  if (conversationId && isConversationFailed(conversationId)) {
    log.info(
      { messageId, conversationId },
      "Skipping upsert — conversation marked failed during extraction",
    );
    return 0;
  }

  // Determine verification state from message role
  const verificationState =
    message.role === "user" ? "user_reported" : "assistant_inferred";

  let upserted = 0;
  for (const item of extracted) {
    const now = Date.now();
    const seenAt = message.createdAt;
    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, item.fingerprint),
          eq(memoryItems.scopeId, effectiveScopeId),
        ),
      )
      .get();

    let memoryItemId: string;
    let effectiveStatus: string = "active";
    if (existing) {
      memoryItemId = existing.id;
      // Promote verification state if re-seen from a more trusted source
      const promotedState =
        existing.verificationState === "assistant_inferred" &&
        verificationState === "user_reported"
          ? "user_reported"
          : existing.verificationState;
      effectiveStatus = "active";
      db.update(memoryItems)
        .set({
          status: effectiveStatus,
          confidence: clampUnitInterval(
            Math.max(existing.confidence, item.confidence),
          ),
          importance: clampUnitInterval(
            Math.max(existing.importance ?? 0, item.importance),
          ),
          lastSeenAt: Math.max(existing.lastSeenAt, seenAt),
          verificationState: promotedState,
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
          verificationState,
          scopeId: effectiveScopeId,
          firstSeenAt: message.createdAt,
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
      item.overrideConfidence === "explicit" &&
      effectiveStatus === "active"
    ) {
      // Explicit supersession: mark old item as superseded and link both items
      const oldItem = db
        .select({ id: memoryItems.id })
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.id, item.supersedes),
            eq(memoryItems.scopeId, effectiveScopeId),
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

        // Update new item's supersedes link
        db.update(memoryItems)
          .set({ supersedes: oldItem.id })
          .where(eq(memoryItems.id, memoryItemId))
          .run();

        // Remove superseded item from Qdrant vector index
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
          "Explicitly superseded memory item",
        );
      }
    } else if (item.supersedes && item.overrideConfidence === "tentative") {
      // Tentative: insert as active but don't supersede — both coexist
      log.debug(
        {
          newItemId: memoryItemId,
          supersedes: item.supersedes,
          overrideConfidence: "tentative",
        },
        "Tentative override — both items coexist",
      );
    } else if (item.supersedes && item.overrideConfidence === "inferred") {
      // Inferred: insert as active, don't supersede, log for observability
      log.debug(
        {
          newItemId: memoryItemId,
          supersedes: item.supersedes,
          overrideConfidence: "inferred",
        },
        "Inferred override — both items coexist (weak signal)",
      );
    }

    // Fallback subject-match supersession: only when the LLM did not
    // explicitly handle supersession for this item. This preserves the
    // original behavior for pattern-based extraction and items without
    // LLM-directed supersession.
    if (
      !item.supersedes &&
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
            eq(memoryItems.scopeId, effectiveScopeId),
            sql`${memoryItems.id} <> ${memoryItemId}`,
          ),
        )
        .run();
    }

    db.insert(memoryItemSources)
      .values({
        memoryItemId,
        messageId,
        evidence: truncate(item.statement, 500, ""),
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    enqueueMemoryJob("embed_item", { itemId: memoryItemId });
  }

  log.debug(
    { messageId, extracted: extracted.length, upserted },
    "Extracted memory items from message",
  );
  return upserted;
}

// ── Pattern-based extraction (fallback) ────────────────────────────────

function extractItemsPatternBased(
  text: string,
  scopeId: string = "default",
): ExtractedItem[] {
  const sentences = text
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 500);

  const items: ExtractedItem[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const classification = classifySentence(lower);
    if (!classification) continue;
    const subject = inferSubject(sentence, classification.kind);
    const statement = sentence.replace(/\s+/g, " ").trim();
    const fingerprint = computeMemoryFingerprint(
      scopeId,
      classification.kind,
      subject,
      statement,
    );
    items.push({
      kind: classification.kind,
      subject,
      statement,
      confidence: classification.confidence,
      importance: classification.importance,
      fingerprint,
      supersedes: null,
      overrideConfidence: "inferred" as OverrideConfidence,
    });
  }

  return deduplicateItems(items);
}

function classifySentence(
  lower: string,
): { kind: MemoryItemKind; confidence: number; importance: number } | null {
  if (
    includesAny(lower, [
      "i prefer",
      "prefer to",
      "favorite",
      "i like",
      "i dislike",
    ])
  ) {
    return { kind: "preference", confidence: 0.78, importance: 0.7 };
  }
  if (
    includesAny(lower, [
      "my name is",
      "i am ",
      "i work as",
      "i live in",
      "timezone",
    ])
  ) {
    return { kind: "identity", confidence: 0.72, importance: 0.8 };
  }
  if (includesAny(lower, ["project", "repository", "repo", "codebase"])) {
    return { kind: "project", confidence: 0.68, importance: 0.6 };
  }
  if (
    includesAny(lower, ["we decided", "decision", "chosen approach", "we will"])
  ) {
    return { kind: "decision", confidence: 0.75, importance: 0.7 };
  }
  if (
    includesAny(lower, ["todo", "to do", "next step", "follow up", "need to"])
  ) {
    return { kind: "project", confidence: 0.74, importance: 0.6 };
  }
  if (
    includesAny(lower, [
      "must",
      "cannot",
      "should not",
      "constraint",
      "requirement",
    ])
  ) {
    return { kind: "constraint", confidence: 0.7, importance: 0.7 };
  }
  if (includesAny(lower, ["remember", "important", "fact", "noted"])) {
    return { kind: "identity", confidence: 0.62, importance: 0.5 };
  }
  return null;
}

function inferSubject(sentence: string, kind: MemoryItemKind): string {
  const trimmed = sentence.trim();
  if (kind === "project") {
    const match = trimmed.match(
      /(?:project|repo(?:sitory)?)\s+([A-Za-z0-9._/-]{2,80})/i,
    );
    if (match) return match[1];
  }
  const words = trimmed.split(/\s+/).slice(0, 6).join(" ");
  return truncate(words, 80, "");
}

function includesAny(text: string, needles: string[]): boolean {
  for (const needle of needles) {
    if (text.includes(needle)) return true;
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────

function deduplicateItems(items: ExtractedItem[]): ExtractedItem[] {
  const seen = new Set<string>();
  const unique: ExtractedItem[] = [];
  for (const item of items) {
    if (seen.has(item.fingerprint)) continue;
    seen.add(item.fingerprint);
    unique.push(item);
  }
  return unique;
}

/** Parse a score value, returning `fallback` for null, undefined, empty strings, and non-finite numbers. */
function parseScore(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

