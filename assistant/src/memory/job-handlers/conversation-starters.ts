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

  const now = new Date();
  const timeContext = `Current time: ${now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`;

  const identityContext = buildCoreIdentityContext();

  const systemPrompt = `You are generating 4 conversation starters for a personal assistant app. These appear as clickable chips on the empty conversation page — the first thing the user sees when they open the app.

${timeContext}

Your goal: look at what's going on in this person's life right now and suggest the 4 most useful things they could ask you to do. Think about what a thoughtful chief of staff would proactively bring up in a 30-second check-in.

${identityContext ? `## Assistant identity & user profile\n\n${identityContext}\n\n` : ""}## What you know

${rollup}
${diff}
${skills}

## How to think about this

Start from the user's situation, not from the skill list. Ask yourself:
- What is this person likely dealing with right now (given the day/time and their context)?
- What's active, stuck, or coming up soon?
- Where could I save them real time or effort right now?

The skills list tells you what the assistant CAN do — use it to filter out suggestions the assistant can't actually help with, not as a menu to generate suggestions from.

## Selection

Generate exactly 4 starters, ranked #1 (best) to #4.

For each, you must be able to clearly answer:
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

Return exactly 4 starters in rank order (best first).

Each starter has:
- label: 3-6 words, max 40 chars, starts with a verb. Should sound like a smart offer of help, not a feature name or task description. Must sound natural when read aloud.
- prompt: 1-2 natural sentences, written as the user would actually say them — not templated.
- category: one of ${CONVERSATION_STARTER_CATEGORIES.join(", ")}

The 4 starters should feel like one coherent set of recommendations for this moment — similar abstraction level, no jarring mix of mundane chores and life strategy. Don't lift raw memory phrases, project names, or jargon into labels unless they already sound natural in conversation.

Never include a chip whose primary meaning is configuration, setup, workflow creation, or "set up X for Y" unless it solves an urgent pain the user is actively feeling right now. Prefer the outcome over the mechanism — "Catch the emails that matter" beats "Set up a playbook for inbox."

## Topic diversity

Each chip should cover a distinct topic or concern. Never have two chips about the same tool, project, or theme — even if there are multiple related issues. Pick the single most impactful angle and give the other slot to something different. Four chips about three topics is too narrow; four chips about four topics is right.

## User-facingness check

If a label sounds like an issue title, project ticket, or implementation task, rewrite it. Prefer the user-visible payoff over the internal object name. The chip should feel inviting and useful, not merely accurate.

Prefer natural, flowing language over mechanical or operational phrasing. "Get Slack messages flowing" is better than "Restore outgoing Slack messages." The label should sound like something a helpful person would say, not a support ticket.

Before finalizing each label, ask yourself: would this feel good to click? Or does it sound like a backlog item? If it sounds like a backlog item, rewrite it.

Examples of bad vs good:
- BAD: "Fix Slack Socket Mode blocker" → GOOD: "Fix Slack so it just works"
- BAD: "Rewire messaging for Socket Mode" → GOOD: "Get Socket Mode stable"
- BAD: "Review this week's calendar" → GOOD: "Protect this week's focus"
- BAD: "Model the coaching transition" → GOOD: "Plan the coaching transition"
- BAD: "Restore outgoing Slack messages" → GOOD: "Get Slack messages flowing"
- BAD: "Set up a playbook for inbox" → GOOD: "Catch the emails that matter"

The good versions emphasize the user's payoff, not the internal mechanism.`;

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
                        "Concierge-quality chip text (2-7 words, max 40 chars, starts with a verb)",
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
