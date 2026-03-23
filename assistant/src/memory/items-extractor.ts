import { and, desc, eq, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type { MemoryExtractionConfig } from "../config/types.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { resolveGuardianPersona } from "../prompts/persona-resolver.js";
import { buildCoreIdentityContext } from "../prompts/system-prompt.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { BackendUnavailableError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { maybeEnqueueConversationStartersJob } from "./conversation-starters-cadence.js";
import { getDb } from "./db.js";
import { computeMemoryFingerprint } from "./fingerprint.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { upsertJournalMemoriesFromDisk } from "./journal-memory.js";
import { extractTextFromStoredMessageContent } from "./message-content.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { getQdrantClient } from "./qdrant-client.js";
import { memoryItems, memoryItemSources, messages } from "./schema.js";
import { isConversationFailed } from "./task-memory-cleanup.js";
import { clampUnitInterval } from "./validation.js";

const log = getLogger("memory-items-extractor");

export type MemoryItemKind =
  | "identity"
  | "preference"
  | "project"
  | "decision"
  | "constraint"
  | "event"
  | "journal";

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
  /** True when the LLM emitted a supersedes ID that was rejected (hallucinated). */
  supersedesRejected?: boolean;
}

const VALID_KINDS = new Set<string>([
  "identity",
  "preference",
  "project",
  "decision",
  "constraint",
  "event",
  "journal",
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

// Budget for the extraction system prompt (in characters). This is a
// conservative estimate that fits comfortably within even small model
// context windows (latency-optimized models like Haiku). The remaining
// context budget is consumed by the user message, tool schema, and response
// tokens. ~6000 tokens ≈ 24 000 chars is a safe ceiling.
const EXTRACTION_SYSTEM_PROMPT_CHAR_BUDGET = 24_000;

function buildExtractionSystemPrompt(
  existingItems: Array<{
    id: string;
    kind: string;
    subject: string;
    statement: string;
  }>,
  messageRole: string,
  userPersona?: string | null,
): string {
  // Build the fixed instruction body first so we can measure it and allocate
  // the remaining budget to identity context.
  let instructions = `You are a memory extraction system. Given a message from a conversation, extract structured memory items that would be valuable to remember for future interactions.

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
- Do NOT extract raw code snippets, JSON fragments, YAML, configuration values, log output, or data structures. Only extract the human-readable meaning or intent behind such content, not the literal syntax.
- Prefer fewer high-quality items over many low-quality ones.
- If the message contains no memorable information, return an empty array.
- The preceding conversation context (if provided) is for disambiguation only. Extract items ONLY from the final message after the --- separator, not from the context messages.`;

  // Try to extract user name from persona text
  let userName = "the user";
  if (userPersona) {
    const nameMatch = userPersona.match(/\*\*Name:\*\*\s*(.+)/);
    if (nameMatch) {
      userName = nameMatch[1].trim();
    }
  }

  if (messageRole === "assistant") {
    instructions += `

IMPORTANT: The message below is from the ASSISTANT. You may extract facts about actions taken, decisions made, and outcomes achieved. However, do NOT attribute the assistant's own identity, personality, or self-descriptions to the user. If the assistant is just introducing itself or expressing uncertainty about its own nature, extract nothing.`;
  }

  instructions += `

## Examples

Good extractions from user messages:
- "I'm a backend engineer at Acme Corp, mostly working with Go and PostgreSQL"
  → kind: identity, subject: "Role at Acme Corp", statement: "${userName} is a backend engineer at Acme Corp, works primarily with Go and PostgreSQL"

- "Always use semantic commits in this repo. I hate squash merges."
  → kind: constraint, subject: "Git conventions", statement: "${userName} requires semantic commit messages. Strongly dislikes squash merges."

- "We decided to go with Redis for the cache layer because DynamoDB was too expensive at our read volume"
  → kind: decision, subject: "Cache layer choice", statement: "${userName} chose Redis over DynamoDB for caching due to cost at high read volumes"

Good extractions from assistant messages:
- "Based on your earlier mention, I see you're using Next.js 14 with the app router for the dashboard project."
  → kind: project, subject: "Dashboard tech stack", statement: "${userName}'s dashboard project uses Next.js 14 with the app router"

- "Since you mentioned your team follows trunk-based development, I'll keep the changes in a single commit."
  → kind: constraint, subject: "Team branching strategy", statement: "${userName}'s team follows trunk-based development"

- "I've refactored the auth middleware to use JWT validation and added rate limiting to the login endpoint."
  → kind: project, subject: "Auth middleware changes", statement: "Auth middleware was refactored to use JWT validation with rate limiting on the login endpoint"

Do NOT extract:
- "I'll check that file for you" → assistant operational statement with no lasting information
- "I think the best approach would be to refactor this" → speculative, no action taken yet
- "The tests passed" → transient status
- "Sure, sounds good" → filler
- "\`\`\`json {"key": "val"} \`\`\`" → raw code/data, extract meaning not syntax`;

  if (existingItems.length > 0) {
    instructions += `\n\nExisting memory items (use these to identify supersession targets — set \`supersedes\` to the item ID if the new information replaces one of these):\n`;
    for (const item of existingItems) {
      instructions += `- [${item.id}] (${item.kind}) ${item.subject}: ${item.statement}\n`;
    }
  }

  // Inject identity context so extracted memories use real names instead of
  // generic "User ..." labels. Budget is dynamically computed: whatever
  // remains after the fixed instructions fits within the system prompt
  // ceiling, preventing oversized prompts from exceeding the provider input
  // window (which would cause sendMessage to error).
  const rawIdentityContext = buildCoreIdentityContext(
    userPersona ? { userPersona } : undefined,
  );

  let prompt = "";
  if (rawIdentityContext) {
    // Reserve space for the wrapping text: "# Identity Context\n\n" + "\n\n---\n\n"
    const wrapperOverhead = "# Identity Context\n\n\n\n---\n\n".length;
    const identityBudget =
      EXTRACTION_SYSTEM_PROMPT_CHAR_BUDGET -
      instructions.length -
      wrapperOverhead;

    if (identityBudget > 0) {
      const identityContext = truncate(
        rawIdentityContext,
        identityBudget,
        "\n...[identity context truncated]",
      );
      prompt += `# Identity Context\n\n${identityContext}\n\n---\n\n`;
    }
  }

  prompt += instructions;
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
  // Escape LIKE wildcards so user text with % or _ doesn't alter query semantics
  const escaped = words.replace(/%/g, "").replace(/_/g, "");
  const subjectPrefix = escaped.length > 0 ? `${escaped}%` : "%";

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
  messageRole: string,
  precedingMessages: Array<{ role: string; content: string }>,
  userPersona?: string | null,
): Promise<ExtractedItem[]> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for memory extraction",
    );
  }

  // Query existing items to give the LLM supersession context
  const existingItems = queryExistingItemsForContext(scopeId, text);
  const systemPrompt = buildExtractionSystemPrompt(
    existingItems,
    messageRole,
    userPersona,
  );

  const assistantName = getAssistantName() ?? "the assistant";
  const messagePrefix =
    messageRole === "assistant"
      ? `[This message is from ${assistantName}]\n\n`
      : `[This message is from the user]\n\n`;

  // Build user content with optional preceding conversation context
  const contextParts: string[] = [];
  for (const msg of precedingMessages) {
    const msgText = extractTextFromStoredMessageContent(msg.content);
    if (msgText.length === 0) continue;
    const roleLabel =
      msg.role === "assistant"
        ? (getAssistantName() ?? "assistant")
        : "user";
    contextParts.push(`[${roleLabel}]: ${msgText}`);
  }
  let userContent = `${messagePrefix}${text}`;
  if (contextParts.length > 0) {
    userContent = `Preceding conversation context:\n${contextParts.join("\n\n")}\n\n---\n\nMessage to extract from:\n${messagePrefix}${text}`;
  }

  const response = await provider.sendMessage(
    [userMessage(userContent)],
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
        tool_choice: { type: "tool" as const, name: "store_memory_items" },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    throw new Error("No tool_use block in LLM extraction response");
  }

  const input = toolBlock.input as { items?: LLMExtractedItem[] };
  if (!Array.isArray(input.items)) {
    throw new Error("Invalid items structure in LLM extraction response");
  }

  // Build set of known existing item IDs for supersession validation
  const existingItemIds = new Set(existingItems.map((e) => e.id));

  const items: ExtractedItem[] = [];
  for (const raw of input.items) {
    // Apply kind migration map for old kind names, then validate
    const resolvedKind = KIND_MIGRATION_MAP[raw.kind] ?? raw.kind;
    if (resolvedKind === "journal") continue; // journal memories created directly from disk
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

    // Validate supersedes: must reference a known existing item ID.
    // Reject hallucinated IDs that don't match any item we showed the LLM.
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

    items.push({
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

  return deduplicateItems(items);
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
      conversationId: messages.conversationId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  if (!message) return 0;

  // Fetch up to 6 preceding messages from the same conversation for
  // disambiguation context (e.g. resolving "that framework" or "yes, do it").
  const effectiveConversationId = conversationId ?? message.conversationId;
  const precedingMessages = effectiveConversationId
    ? db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, effectiveConversationId),
            sql`${messages.createdAt} < ${message.createdAt}`,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(6)
        .all()
        .reverse()
    : [];

  const effectiveScopeId = scopeId ?? "default";

  // Directly create journal memories from any journal files written during
  // this message, bypassing LLM extraction (which would summarize/rewrite them).
  // This must run before the extraction guards (semantic density, useLLM, etc.)
  // because journal disk scanning is independent of LLM extraction.
  let journalUpserted = 0;
  if (message.role === "assistant") {
    journalUpserted = upsertJournalMemoriesFromDisk(
      message.createdAt,
      effectiveScopeId,
      messageId,
    );
  }

  const text = extractTextFromStoredMessageContent(message.content);
  if (!hasSemanticDensity(text)) {
    log.debug(
      { messageId },
      "Skipping extraction — message lacks semantic density",
    );
    return journalUpserted;
  }

  const config = getConfig();
  const extractionConfig = config.memory.extraction;

  // Resolve the guardian's persona to provide personality-aware extraction
  // context. Currently uses the guardian persona for all conversations —
  // non-guardian conversations are rare and the guardian's persona provides
  // better extraction context than none.
  const userPersona = resolveGuardianPersona();

  if (!extractionConfig.useLLM) {
    return journalUpserted;
  }

  const extracted = await extractItemsWithLLM(
    text,
    extractionConfig,
    effectiveScopeId,
    message.role,
    precedingMessages,
    userPersona,
  );

  if (extracted.length === 0) return journalUpserted;

  // Guard: re-check after the async LLM call. The event loop yields during
  // extractItemsWithLLM, so another task could have marked the conversation
  // as failed in the meantime. Bail before writing to the DB.
  if (conversationId && isConversationFailed(conversationId)) {
    log.info(
      { messageId, conversationId },
      "Skipping upsert — conversation marked failed during extraction",
    );
    return journalUpserted;
  }

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
      effectiveStatus = "active";
      // Preserve sourceType for tool-sourced items — extraction should not
      // demote items the user explicitly saved.
      const effectiveSourceType =
        existing.sourceType === "tool" ? "tool" : "extraction";

      // Dual-write verificationState alongside sourceType for client compat.
      // Promote from assistant_inferred → user_reported when re-seen from user.
      const effectiveVerificationState =
        message.role === "user" || existing.verificationState === "user_reported"
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
            Math.max(existing.importance ?? 0, item.importance),
          ),
          lastSeenAt: Math.max(existing.lastSeenAt, seenAt),
          sourceType: effectiveSourceType,
          sourceMessageRole: message.role,
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
          sourceMessageRole: message.role,
          // Dual-write verificationState for client compat
          verificationState:
            message.role === "user" ? "user_reported" : "assistant_inferred",
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

    // Handle LLM-directed supersession based on overrideConfidence.
    // Guard: skip if supersedes targets the current item (self-supersession on
    // fingerprint re-hit would incorrectly remove an active memory).
    if (
      item.supersedes &&
      item.supersedes !== memoryItemId &&
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
    // explicitly handle supersession for this item. Skip items whose
    // supersedes ID was rejected (hallucinated) — they should coexist,
    // not trigger subject-based replacement.
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
        evidence: item.statement,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    enqueueMemoryJob("embed_item", { itemId: memoryItemId });
  }

  upserted += journalUpserted;

  log.debug(
    { messageId, extracted: extracted.length, upserted },
    "Extracted memory items from message",
  );

  // Trigger conversation starters generation when new items are upserted
  if (upserted > 0) {
    try {
      maybeEnqueueConversationStartersJob(effectiveScopeId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to check conversation starters cadence",
      );
    }
  }

  return upserted;
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
