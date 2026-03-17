/**
 * Job handler for generating conversation starters.
 *
 * Crosses user memory items with the skill catalog to produce personalized
 * suggestion chips shown on the empty conversation page.
 */

import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { loadSkillCatalog } from "../../config/skills.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import { getDb } from "../db.js";
import { asString } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { rawAll, rawGet } from "../raw-query.js";
import {
  conversationStarters,
  memoryCheckpoints,
  memoryItems,
} from "../schema.js";

const log = getLogger("conversation-starters-gen");

function checkpointKey(base: string, scopeId: string): string {
  return `${base}:${scopeId}`;
}

const CK_ITEM_COUNT = "conversation_starters:item_count_at_last_gen";
const CK_BATCH = "conversation_starters:generation_batch";
const CK_LAST_GEN_AT = "conversation_starters:last_gen_at";

// ── Rollup construction ───────────────────────────────────────────

export function buildMemoryRollup(scopeId: string): string {
  const db = getDb();
  const items = db
    .select({
      kind: memoryItems.kind,
      subject: memoryItems.subject,
      statement: memoryItems.statement,
      importance: memoryItems.importance,
    })
    .from(memoryItems)
    .where(
      and(eq(memoryItems.status, "active"), eq(memoryItems.scopeId, scopeId)),
    )
    .orderBy(desc(memoryItems.importance))
    .limit(60)
    .all();

  if (items.length === 0) return "";

  const byKind = new Map<string, string[]>();
  for (const item of items) {
    let lines = byKind.get(item.kind);
    if (!lines) {
      lines = [];
      byKind.set(item.kind, lines);
    }
    lines.push(`- ${item.subject}: ${item.statement}`);
  }

  let rollup = "";
  for (const [kind, lines] of byKind) {
    rollup += `## ${kind}\n${lines.join("\n")}\n\n`;
  }
  return truncate(rollup, 6000, "");
}

function buildNewItemsDiff(scopeId: string): string {
  const db = getDb();
  const checkpoint = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, checkpointKey(CK_LAST_GEN_AT, scopeId)))
    .get();
  const lastGenAt = checkpoint ? parseInt(checkpoint.value, 10) : 0;

  if (lastGenAt === 0) return ""; // No previous generation — skip diff

  const newItems = rawAll<{
    kind: string;
    subject: string;
    statement: string;
  }>(
    `SELECT kind, subject, statement FROM memory_items
     WHERE status = 'active' AND scope_id = ? AND first_seen_at > ?
     ORDER BY first_seen_at DESC LIMIT 20`,
    scopeId,
    lastGenAt,
  );

  if (newItems.length === 0) return "";

  return (
    "## New since last generation\n" +
    newItems.map((i) => `- (${i.kind}) ${i.subject}: ${i.statement}`).join("\n")
  );
}

export function buildSkillsSummary(): string {
  try {
    const catalog = loadSkillCatalog();
    if (catalog.length === 0) return "";

    const lines = catalog
      .filter((s) => s.description && s.displayName)
      .map((s) => {
        const emoji = s.emoji ? `${s.emoji} ` : "";
        const hints = s.activationHints?.length
          ? ` (hints: ${s.activationHints.join(", ")})`
          : "";
        return `- ${emoji}${s.displayName}: ${s.description}${hints}`;
      });

    return `## Available skills\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── LLM generation ────────────────────────────────────────────────

/** Capability categories matching the Intelligence page taxonomy. */
export const CONVERSATION_STARTER_CATEGORIES = [
  "communication",
  "productivity",
  "development",
  "media",
  "automation",
  "web_social",
  "knowledge",
  "integration",
] as const;

export type ConversationStarterCategory =
  (typeof CONVERSATION_STARTER_CATEGORIES)[number];

interface GeneratedStarter {
  label: string;
  prompt: string;
  category: string;
}

async function generateStarters(scopeId: string): Promise<GeneratedStarter[]> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    log.info("No configured provider for conversation starters generation");
    return [];
  }

  const rollup = buildMemoryRollup(scopeId);
  if (!rollup) {
    log.info("No memory items to generate conversation starters from");
    return [];
  }
  const diff = buildNewItemsDiff(scopeId);
  const skills = buildSkillsSummary();

  const systemPrompt = `You are choosing the top suggested starts for a personal AI assistant. These appear as clickable chips on the empty conversation page — the user's first impression of what they can do right now.

Given the user's accumulated memories and the assistant's available skills, generate 4-6 suggested starts. Each has:
- label: A one-second read (max 40 chars). Compress the user's likely intent into a short phrase starting with a verb. It should feel like something the user would actually say, not a feature name.
- prompt: The full message sent when clicked (1-2 natural sentences, written as the user).
- category: One of: ${CONVERSATION_STARTER_CATEGORIES.join(", ")}. Pick the best-fit category.

Quality bar for labels — bias toward:
- Relief: remove a pain point or unblock something stuck.
- Momentum: advance work already in progress.
- Confidence: surface information the user needs to make a decision.
- Curiosity: highlight something timely or surprising.
- Timely usefulness: prioritize what matters this week over what matters in general.

Coherence rules:
- The full set of 4-6 starters must read as one coherent row — same abstraction level, no jarring mix of setup chores and strategic projects.
- Do NOT suggest setup, admin, or configuration tasks unless they are genuinely blocking or time-sensitive. Users rarely want "configure X" as their first action.
- Every starter must be specific to THIS user's context — generic prompts like "Tell me a joke" or "Summarize my day" are not useful.
- Vary across different skills and memory areas, but keep the row feeling intentional, not random.
- Prompts should sound natural, as if the user typed them unprompted.

${rollup}
${diff}
${skills}`;

  const { signal, cleanup } = createTimeout(20000);
  try {
    const response = await provider.sendMessage(
      [
        userMessage(
          "Generate personalized conversation starters based on my context.",
        ),
      ],
      [
        {
          name: "store_conversation_starters",
          description: "Store generated conversation starter suggestions",
          input_schema: {
            type: "object" as const,
            properties: {
              starters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description:
                        "Short chip text (max 40 chars, starts with a verb, compressed user intent)",
                    },
                    prompt: {
                      type: "string",
                      description: "Full message sent on click (1-2 sentences)",
                    },
                    category: {
                      type: "string",
                      enum: [...CONVERSATION_STARTER_CATEGORIES],
                      description: "Capability category for grouping",
                    },
                  },
                  required: ["label", "prompt", "category"],
                },
              },
            },
            required: ["starters"],
          },
        },
      ],
      systemPrompt,
      {
        config: {
          modelIntent: "quality-optimized",
          max_tokens: 1024,
          tool_choice: {
            type: "tool" as const,
            name: "store_conversation_starters",
          },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn(
        "No tool_use block in conversation starters generation response",
      );
      return [];
    }

    const input = toolBlock.input as { starters?: GeneratedStarter[] };
    if (!Array.isArray(input.starters)) {
      log.warn("Invalid starters in generation response");
      return [];
    }

    return input.starters
      .filter(
        (s) =>
          typeof s.label === "string" &&
          s.label.length > 0 &&
          typeof s.prompt === "string" &&
          s.prompt.length > 0,
      )
      .map((s) => ({
        label: truncate(s.label, 40, ""),
        prompt: truncate(s.prompt, 500, ""),
        category:
          typeof s.category === "string" &&
          (CONVERSATION_STARTER_CATEGORIES as readonly string[]).includes(
            s.category,
          )
            ? s.category
            : "productivity",
      }));
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ── Job handler ───────────────────────────────────────────────────

export async function generateConversationStartersJob(
  job: MemoryJob,
): Promise<void> {
  const scopeId = asString(job.payload.scopeId) ?? "default";

  const starters = await generateStarters(scopeId);
  if (starters.length === 0) {
    log.info({ scopeId }, "No conversation starters generated");
    return;
  }

  const db = getDb();
  const now = Date.now();

  // Determine next batch number
  const batchCheckpoint = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, checkpointKey(CK_BATCH, scopeId)))
    .get();
  const nextBatch = batchCheckpoint
    ? parseInt(batchCheckpoint.value, 10) + 1
    : 1;

  // Collect the memory kinds that informed this batch
  const kindRows = db
    .select({ kind: memoryItems.kind })
    .from(memoryItems)
    .where(
      and(eq(memoryItems.status, "active"), eq(memoryItems.scopeId, scopeId)),
    )
    .groupBy(memoryItems.kind)
    .all();
  const sourceKinds = kindRows.map((r) => r.kind).join(",");

  // Insert starters
  for (const starter of starters) {
    db.insert(conversationStarters)
      .values({
        id: uuid(),
        label: starter.label,
        prompt: starter.prompt,
        category: starter.category,
        generationBatch: nextBatch,
        scopeId,
        sourceMemoryKinds: sourceKinds,
        createdAt: now,
      })
      .run();
  }

  // Count active items for checkpoint
  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );
  const totalActive = countRow?.c ?? 0;

  // Update all three checkpoints
  const upsertCheckpoint = (key: string, value: string) => {
    db.insert(memoryCheckpoints)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: memoryCheckpoints.key,
        set: { value, updatedAt: now },
      })
      .run();
  };

  upsertCheckpoint(checkpointKey(CK_ITEM_COUNT, scopeId), String(totalActive));
  upsertCheckpoint(checkpointKey(CK_BATCH, scopeId), String(nextBatch));
  upsertCheckpoint(checkpointKey(CK_LAST_GEN_AT, scopeId), String(now));

  log.info(
    { scopeId, batch: nextBatch, count: starters.length },
    "Generated conversation starters",
  );
}
