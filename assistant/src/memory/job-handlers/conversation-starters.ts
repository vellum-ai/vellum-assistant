/**
 * Job handler for generating conversation starters.
 *
 * Crosses user memory items with the skill catalog to produce personalized
 * suggestion chips shown on the empty conversation page.
 */

import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { loadSkillCatalog } from "../../config/skills.js";
import { buildCoreIdentityContext } from "../../prompts/system-prompt.js";
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
  memoryObservations,
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
  const observations = db
    .select({
      content: memoryObservations.content,
      role: memoryObservations.role,
    })
    .from(memoryObservations)
    .where(eq(memoryObservations.scopeId, scopeId))
    .orderBy(desc(memoryObservations.createdAt))
    .limit(60)
    .all();

  if (observations.length === 0) return "";

  const byKind = new Map<string, string[]>();
  for (const item of observations) {
    const kind = item.role;
    let lines = byKind.get(kind);
    if (!lines) {
      lines = [];
      byKind.set(kind, lines);
    }
    lines.push(`- ${item.content}`);
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

  const now = new Date();
  const timeContext = `Current time: ${now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`;

  // Truncate identity context to prevent oversized prompts when SOUL.md /
  // IDENTITY.md / USER.md are large.
  const rawIdentityContext = buildCoreIdentityContext();
  const identityContext = rawIdentityContext
    ? truncate(rawIdentityContext, 2000, "\n…[truncated]")
    : null;

  const systemPrompt = `You are generating 4 conversation starters for a personal assistant app. These appear as clickable chips on the empty conversation page — the first thing the user sees when they open the app. Clicking a chip sends its prompt as a message from the user.

${timeContext}

Your goal: suggest the 4 most useful things this person could ask you to do right now.

${identityContext ? `## Assistant identity & user profile\n\n${identityContext}\n\n` : ""}## What you know

${rollup}
${diff}
${skills}

## Selection

Generate exactly 4 starters, ranked #1 (best) to #4.

Start from the user's situation, not from the skill list. Ask yourself:
- What is this person likely dealing with right now (given the day/time and their context)?
- What's active, stuck, or coming up soon?
- Where could I save them real time or effort right now?

The skills list tells you what the assistant CAN do — use it to filter out suggestions the assistant can't actually help with, not as a menu to generate suggestions from.

For each starter, you must clearly answer:
- Why now? (timing — day of week, recent activity, upcoming deadline)
- Why this user? (grounded in their specific context, not generic)
- Why would they be glad I suggested this? (genuine usefulness, not just relevance)

If you can't answer all three strongly, replace it with something better.

Prioritize:
- Relief: unblock something stuck, reduce drag
- Momentum: advance work already in motion
- Confidence: surface what they need to decide or act on
- Curiosity: something timely they'd want to know about

Favor what is live over what is merely true. Recent changes matter more than old memories. Active work matters more than dormant topics. This week matters more than "someday."

## Output format

Each starter has:
- label: 3-6 words, max 40 chars, starts with a verb. Written in the user's voice — something they'd want to do, not something the assistant is offering.
- prompt: 1-2 natural sentences, as the user would actually say them.
- category: one of ${CONVERSATION_STARTER_CATEGORIES.join(", ")}

## Constraints

**Voice**: The user clicks these chips to send a message. Every label must read as something the user is asking to do, never something the assistant is saying to the user.

**Coherence**: The 4 starters should feel like one set — similar abstraction level, no jarring mix of mundane chores and life strategy.

**Diversity**: Each chip covers a distinct topic. Never two chips about the same tool, project, or theme. Four topics, four chips.

**No setup chips**: Never include a chip whose primary meaning is configuration or "set up X for Y" unless it solves an urgent pain the user is actively feeling. Prefer the outcome over the mechanism.

**Natural language**: No jargon, project names, or raw memory phrases in labels unless they already sound natural in conversation. If a label sounds like a ticket title or backlog item, rewrite it as something the user would actually say.

## Examples

Bad → Good (ticket-speak → natural):
- "Fix Slack Socket Mode blocker" → "Fix Slack so it just works"
- "Restore outgoing Slack messages" → "Get Slack messages flowing"
- "Review this week's calendar" → "Protect this week's focus"
- "Set up a playbook for inbox" → "Triage my inbox"

Bad → Good (assistant voice → user voice):
- "You've got a busy week ahead" → "Plan my week ahead"
- "Let me check your calendar" → "Check my Thursday schedule"`;

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
                        "User-voice chip label (2-7 words, max 40 chars, verb-first)",
                    },
                    prompt: {
                      type: "string",
                      description:
                        "Full message sent on click (1-2 natural sentences, as the user would say it)",
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
      .slice(0, 4)
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

  // Collect the memory roles that informed this batch
  const roleRows = db
    .select({ role: memoryObservations.role })
    .from(memoryObservations)
    .where(eq(memoryObservations.scopeId, scopeId))
    .groupBy(memoryObservations.role)
    .all();
  const sourceKinds = roleRows.map((r) => r.role).join(",");

  // Remove previous starters for this scope before inserting the new batch
  db.delete(conversationStarters)
    .where(eq(conversationStarters.scopeId, scopeId))
    .run();

  // Insert starters — all are chips
  for (const starter of starters) {
    db.insert(conversationStarters)
      .values({
        id: uuid(),
        label: starter.label,
        prompt: starter.prompt,
        category: starter.category,
        cardType: "chip",
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
