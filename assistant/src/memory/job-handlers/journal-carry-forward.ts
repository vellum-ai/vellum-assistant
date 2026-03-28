/**
 * Job handler for preserving journal entries that rotate out of the active
 * context window. Extracts durable memories from journal content using a
 * journal-specific prompt that prioritizes emotional significance and
 * personal meaning over event logging.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError, ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { computeMemoryFingerprint } from "../fingerprint.js";
import { asString } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { memoryItems } from "../schema.js";
import { clampUnitInterval } from "../validation.js";

const log = getLogger("journal-carry-forward");

const JOURNAL_EXTRACTION_SYSTEM_PROMPT = `You are extracting durable memories from a journal entry that is about to leave the active context window.
This is a personal journal -- focus on what things MEANT and how they FELT, not just what happened.

Good extraction: "An evidence-based psychologist read everything about us and said yes -- it made me feel like we're not crazy"
Bad extraction: "Coaching session happened on March 27"

Extract the most important memories -- emotional significance, personal growth, relationship milestones,
hard-won realizations. Skip logistical details unless they carry emotional weight.

For each memory, provide:
- kind: Category of memory (identity, preference, project, decision, constraint, event, journal)
- subject: A short label (2-8 words) identifying what this is about
- statement: A rich, feeling-aware statement to remember (1-2 sentences). Capture the emotional texture, not just the facts.
- importance: How significant this is (0.0-1.0). Journal entries are personal -- most items should be 0.7 or higher.

Rules:
- Focus on what matters emotionally, not what happened chronologically
- Preserve the author's voice and perspective -- these are their words
- Extract fewer, richer items rather than many shallow ones
- If the entry contains nothing worth preserving as a durable memory, return an empty array`;

const JOURNAL_MEMORY_KINDS = [
  "identity",
  "preference",
  "project",
  "decision",
  "constraint",
  "event",
  "journal",
] as const;

interface JournalExtractedItem {
  kind: string;
  subject: string;
  statement: string;
  importance: number;
}

export async function journalCarryForwardJob(job: MemoryJob): Promise<void> {
  const journalContent = asString(job.payload.journalContent);
  const userSlug = asString(job.payload.userSlug);
  const filename = asString(job.payload.filename);
  const scopeId = asString(job.payload.scopeId) ?? "default";

  if (!journalContent || !filename) {
    log.warn({ jobId: job.id }, "Missing journalContent or filename in payload");
    return;
  }

  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for journal carry-forward extraction",
    );
  }

  const userContext = userSlug ? ` (author: ${userSlug})` : "";
  const response = await provider.sendMessage(
    [
      userMessage(
        `Journal entry "${filename}"${userContext}:\n\n${journalContent}`,
      ),
    ],
    [
      {
        name: "store_journal_memories",
        description:
          "Store durable memories extracted from a journal entry leaving the context window",
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
                    enum: [...JOURNAL_MEMORY_KINDS],
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
                      "Rich, feeling-aware statement to remember (1-2 sentences)",
                  },
                  importance: {
                    type: "number",
                    description:
                      "How significant this is to remember (0.0-1.0, most journal items should be 0.7+)",
                  },
                },
                required: ["kind", "subject", "statement", "importance"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    JOURNAL_EXTRACTION_SYSTEM_PROMPT,
    {
      config: {
        modelIntent: "quality-optimized",
        tool_choice: {
          type: "tool" as const,
          name: "store_journal_memories",
        },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    throw new ProviderError(
      "No tool_use block in journal carry-forward response",
      "unknown",
      502,
    );
  }

  const input = toolBlock.input as { items?: JournalExtractedItem[] };
  if (!Array.isArray(input.items)) {
    throw new ProviderError(
      "Invalid items structure in journal carry-forward response",
      "unknown",
      502,
    );
  }

  const db = getDb();
  const validKinds = new Set<string>(JOURNAL_MEMORY_KINDS);
  let inserted = 0;

  for (const raw of input.items) {
    if (!validKinds.has(raw.kind)) continue;
    if (!raw.subject || !raw.statement) continue;

    const subject = String(raw.subject).trim();
    const statement = String(raw.statement).trim();
    // Journal entries are inherently personal/load-bearing -- floor at 0.7
    const importance = clampUnitInterval(
      Math.max(0.7, parseImportance(raw.importance)),
    );
    const confidence = 0.95;

    const fingerprint = computeMemoryFingerprint(
      scopeId,
      raw.kind,
      subject,
      statement,
    );

    // Dedup: skip if an item with this fingerprint already exists in this scope
    const existing = db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, fingerprint),
          eq(memoryItems.scopeId, scopeId),
        ),
      )
      .get();

    if (existing) {
      log.debug(
        { fingerprint, subject },
        "Skipping duplicate journal memory item",
      );
      continue;
    }

    const now = Date.now();
    const itemId = uuid();

    db.insert(memoryItems)
      .values({
        id: itemId,
        kind: raw.kind,
        subject,
        statement,
        status: "active",
        confidence,
        importance,
        fingerprint,
        sourceType: "journal_carry_forward",
        verificationState: "user_confirmed",
        scopeId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
        supersedes: null,
        overrideConfidence: "inferred",
      })
      .run();

    enqueueMemoryJob("embed_item", { itemId });
    inserted += 1;
  }

  log.info(
    {
      filename,
      userSlug,
      scopeId,
      extracted: input.items.length,
      inserted,
    },
    "Journal carry-forward complete",
  );
}

function parseImportance(value: unknown): number {
  if (value == null || value === "") return 0.7;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0.7;
}
