/**
 * Job handler for generating conversation starters.
 *
 * Crosses user memory items with the skill catalog to produce personalized
 * suggestion chips shown on the empty conversation page.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { loadSkillCatalog } from "../../config/skills.js";
import { resolveGuardianPersona } from "../../prompts/persona-resolver.js";
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
  memoryGraphNodes,
} from "../schema.js";

const log = getLogger("conversation-starters-gen");

function checkpointKey(base: string, scopeId: string): string {
  return `${base}:${scopeId}`;
}

const CK_ITEM_COUNT = "conversation_starters:item_count_at_last_gen";
const CK_BATCH = "conversation_starters:generation_batch";
const CK_LAST_GEN_AT = "conversation_starters:last_gen_at";

// ── Rollup construction ───────────────────────────────────────────

function buildMemoryRollup(scopeId: string): string {
  let rows: Array<{
    type: string;
    content: string;
    significance: number | null;
  }>;
  try {
    const db = getDb();
    rows = db
      .select({
        type: memoryGraphNodes.type,
        content: memoryGraphNodes.content,
        significance: memoryGraphNodes.significance,
      })
      .from(memoryGraphNodes)
      .where(
        and(
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
          eq(memoryGraphNodes.scopeId, scopeId),
        ),
      )
      .orderBy(desc(memoryGraphNodes.significance))
      .limit(60)
      .all();
  } catch {
    // Table may have been dropped (migration 203)
    return "";
  }

  if (rows.length === 0) return "";

  const byKind = new Map<string, string[]>();
  for (const item of rows) {
    const nl = item.content.indexOf("\n");
    const subject = nl >= 0 ? item.content.slice(0, nl) : item.content;
    const statement = nl >= 0 ? item.content.slice(nl + 1) : item.content;
    let lines = byKind.get(item.type);
    if (!lines) {
      lines = [];
      byKind.set(item.type, lines);
    }
    lines.push(`- ${subject}: ${statement}`);
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
    content: string;
  }>(
    `SELECT type AS kind, content FROM memory_graph_nodes
     WHERE fidelity != 'gone' AND scope_id = ? AND created > ?
     ORDER BY created DESC LIMIT 20`,
    scopeId,
    lastGenAt,
  );

  if (newItems.length === 0) return "";

  return (
    "## New since last generation\n" +
    newItems
      .map((i) => {
        const nl = i.content.indexOf("\n");
        const subject = nl >= 0 ? i.content.slice(0, nl) : i.content;
        const statement = nl >= 0 ? i.content.slice(nl + 1) : i.content;
        return `- (${i.kind}) ${subject}: ${statement}`;
      })
      .join("\n")
  );
}

function buildSkillsSummary(): string {
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
const CONVERSATION_STARTER_CATEGORIES = [
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
  const provider = await getConfiguredProvider("conversationStarters");
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
  const timeContext = `Current time: ${now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })}`;

  // Truncate identity context to prevent oversized prompts when SOUL.md /
  // IDENTITY.md / users/<slug>.md are large.
  const rawIdentityContext = buildCoreIdentityContext({
    userPersona: resolveGuardianPersona(),
  });
  const identityContext = rawIdentityContext
    ? truncate(rawIdentityContext, 2000, "\n…[truncated]")
    : null;

  const systemPrompt = `You are generating conversation starters for a personal assistant app. These appear as clickable chips on the empty conversation page — the first thing the user sees when they open the app. Clicking a chip sends its prompt as a message from the user.

${timeContext}

Your goal: suggest the most useful things this person could ask you to do right now. Produce 8 candidates, ranked best-first; only the top 4 will be shown.

${
  identityContext
    ? `## Assistant identity & user profile\n\n${identityContext}\n\n`
    : ""
}## What you know

${rollup}
${diff}
${skills}

## Selection

Generate exactly 8 starters, ranked #1 (best) to #8. The top 4 will be shown; the rest are fallbacks in case any fail downstream validation (e.g. label too long). Put real effort into every slot — any of them may end up displayed.

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
- label: 3-6 words, max 40 chars, starts with a verb. Written in the user's voice — first-person about themselves, never referring to the user by name or in the third person. Something they'd want to do, not something the assistant is offering. MUST be a grammatically complete phrase: if it uses an adjective ("quarterly", "weekly"), include the noun it modifies ("quarterly review", "weekly sync"). Never end on a dangling modifier, preposition, or trailing "the/my/a". Prefer completeness over tightness when you have room under 40 chars.
- prompt: 1-2 natural sentences in the user's voice — what they'd type to the assistant. First-person about themselves (I/me/my), second-person to the assistant (you/your). Never refer to the user by name or in the third person, and never narrate what the assistant will do.
- category: one of ${CONVERSATION_STARTER_CATEGORIES.join(", ")}

## Constraints

**Voice**: The user clicks these chips to send a message to the assistant. Both the label AND the prompt must read as something the user is typing — first-person (I/me/my) about themselves, second-person (you/your) to the assistant. Never refer to the user by name or in the third person ("him", "her", "they", or their actual name) — that's the assistant's voice, not the user's. Never narrate what the assistant will do ("Let me check…", "I'll see what he's been up to…").

**Coherence**: The top 4 starters should feel like one set — similar abstraction level, no jarring mix of mundane chores and life strategy. The remaining 4 fallbacks may branch into adjacent topics.

**Diversity**: Each chip covers a distinct topic. Never two chips about the same tool, project, or theme. Across all 8 starters, avoid repeating topics.

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
- "Let me check your calendar" → "Check my Thursday schedule"
- "Catch up with <user's own name> today" → "Catch up with you today" (only the user's own name becomes "you" — third-party names like a colleague or friend stay as written)

Bad → Good (prompt in assistant's voice → prompt in user's voice):
- "It's Saturday morning and I haven't connected with <user's own name> yet. Let me see what they've been up to." → "What have you been up to today? Let's catch up." (assistant narrating about the user → user speaking to assistant; only the user's own name becomes "you/I", names of other people are preserved)
- "<User's own name> has had a busy week — I should check in on how they're feeling." → "I've had a busy week — can we talk through how it went?"

Bad → Good (incomplete phrase → complete):
- "Prep for Friday's quarterly" → "Prep for Friday's quarterly review"
- "Finish the onboarding" → "Finish the onboarding guide"
- "Draft the release" → "Draft the release notes"`;

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
          callSite: "conversationStarters" as const,
          max_tokens: 2048,
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
          s.label.length <= 40 &&
          typeof s.prompt === "string" &&
          s.prompt.length > 0,
      )
      .slice(0, 4)
      .map((s) => ({
        label: s.label,
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

  // Collect the memory types that informed this batch
  let sourceKinds = "";
  try {
    const kindRows = db
      .select({ kind: memoryGraphNodes.type })
      .from(memoryGraphNodes)
      .where(
        and(
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
          eq(memoryGraphNodes.scopeId, scopeId),
        ),
      )
      .groupBy(memoryGraphNodes.type)
      .all();
    sourceKinds = kindRows.map((r) => r.kind).join(",");
  } catch {
    // Table may have been dropped (migration 203)
  }

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
    `SELECT COUNT(*) AS c FROM memory_graph_nodes WHERE fidelity != 'gone' AND scope_id = ?`,
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
