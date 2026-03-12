import { and, eq, sql } from "drizzle-orm";
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
import {
  memoryItemConflicts,
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

interface ExtractedItem {
  kind: MemoryItemKind;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
  fingerprint: string;
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
  "event",
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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Given a message from a conversation, extract structured memory items that would be valuable to remember for future interactions.

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
- statement: The full factual statement to remember (1-2 sentences)
- confidence: How confident you are this is accurate (0.0-1.0)
- importance: How valuable this is to remember (0.0-1.0)
  - 1.0: Explicit user instructions about assistant behavior
  - 0.8-0.9: Personal facts, strong preferences, key decisions
  - 0.6-0.7: Project details, constraints, opinions
  - 0.3-0.5: Contextual details, minor preferences

Rules:
- Only extract genuinely memorable information. Skip pleasantries, filler, and transient discussion.
- Do NOT extract information about what tools the assistant used or what files it read — only extract substantive facts about the user, their projects, and their preferences.
- Do NOT extract claims about actions the assistant performed, outcomes it achieved, or progress it reported (e.g., "I booked an appointment", "I sent the email"). Only extract facts stated by the user or from external sources — the assistant's self-reports are not reliable memory material.
- Prefer fewer high-quality items over many low-quality ones.
- If the message contains no memorable information, return an empty array.`;

interface LLMExtractedItem {
  kind: string;
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
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
                          "Full factual statement to remember (1-2 sentences)",
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
                    },
                    required: [
                      "kind",
                      "subject",
                      "statement",
                      "confidence",
                      "importance",
                    ],
                  },
                },
              },
              required: ["items"],
            },
          },
        ],
        EXTRACTION_SYSTEM_PROMPT,
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
        items.push({
          kind: resolvedKind as MemoryItemKind,
          subject,
          statement,
          confidence,
          importance,
          fingerprint,
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
      // Preserve pending_clarification if this item has an unresolved conflict
      effectiveStatus =
        existing.status === "pending_clarification" &&
        hasPendingConflict(existing.id)
          ? "pending_clarification"
          : "active";
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
        })
        .run();
      upserted += 1;
    }

    // Only supersede other items when this item is active — a
    // pending_clarification item should not demote the existing active
    // item, since that would leave no retrievable memory until manual
    // conflict resolution occurs.
    if (SUPERSEDE_KINDS.has(item.kind) && effectiveStatus === "active") {
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

    // Queue contradiction check for newly inserted items
    if (!existing) {
      enqueueMemoryJob("check_contradictions", { itemId: memoryItemId });
    }
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

/** Returns true if the given memory item is the candidate in an unresolved conflict. */
function hasPendingConflict(itemId: string): boolean {
  const db = getDb();
  const row = db
    .select({ id: memoryItemConflicts.id })
    .from(memoryItemConflicts)
    .where(
      and(
        eq(memoryItemConflicts.candidateItemId, itemId),
        eq(memoryItemConflicts.status, "pending_clarification"),
      ),
    )
    .limit(1)
    .get();
  return row != null;
}
