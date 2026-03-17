/**
 * Job handler for generating capability cards.
 *
 * Each job generates cards for a single capability category, running in
 * parallel with jobs for other categories. Cards are personalized to the
 * user's memory items and available skills.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

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
import {
  capabilityCardCategories,
  memoryCheckpoints,
  threadStarters,
} from "../schema.js";
import { buildMemoryRollup, buildSkillsSummary } from "./thread-starters.js";

const log = getLogger("capability-cards-gen");

/** Capability categories for the feed (knowledge dropped — not actionable). */
export const CAPABILITY_CARD_CATEGORIES = [
  "communication",
  "productivity",
  "development",
  "media",
  "automation",
  "web_social",
  "integration",
] as const;

export type CapabilityCardCategory =
  (typeof CAPABILITY_CARD_CATEGORIES)[number];

/** Human-readable descriptions for each category, used in the LLM prompt. */
const CATEGORY_DESCRIPTIONS: Record<CapabilityCardCategory, string> = {
  communication: "Email, Slack, messaging, drafting messages, replying",
  productivity:
    "Calendar, tasks, planning, scheduling, meeting prep, time management",
  development:
    "Code, debugging, architecture, PR reviews, build systems, documentation",
  media: "Images, video, audio, 3D, creative assets, media editing",
  automation:
    "Workflows, scheduling, scripts, recurring tasks, integrations orchestration",
  web_social:
    "Web browsing, social media, research, competitive analysis, news",
  integration:
    "Third-party services, APIs, syncing data across tools, connecting services",
};

/**
 * Curated subset of VIcon names the LLM can choose from, organized by
 * category relevance. Kept small (~30) to avoid bloating the prompt.
 */
const ICON_PALETTE: Record<string, string[]> = {
  communication: [
    "lucide-mail",
    "lucide-message-circle",
    "lucide-message-square",
    "lucide-phone",
    "lucide-send",
  ],
  productivity: [
    "lucide-calendar",
    "lucide-clock",
    "lucide-clipboard-list",
    "lucide-list-checks",
    "lucide-flag",
  ],
  development: [
    "lucide-terminal",
    "lucide-git-branch",
    "lucide-file-code",
    "lucide-bug",
    "lucide-cpu",
  ],
  media: [
    "lucide-image",
    "lucide-video",
    "lucide-music-2",
    "lucide-camera",
    "lucide-palette",
  ],
  automation: [
    "lucide-zap",
    "lucide-refresh-cw",
    "lucide-settings",
    "lucide-layers",
    "lucide-rocket",
  ],
  web_social: [
    "lucide-globe",
    "lucide-search",
    "lucide-trending-up",
    "lucide-chart-bar",
    "lucide-binoculars",
  ],
  integration: [
    "lucide-puzzle",
    "lucide-link",
    "lucide-network",
    "lucide-package",
    "lucide-share-2",
  ],
};

const CK_BATCH = "capability_cards:generation_batch";

function checkpointKey(base: string, scopeId: string): string {
  return `${base}:${scopeId}`;
}

interface GeneratedCard {
  icon: string;
  title: string;
  description: string;
  prompt: string;
  tags: string[];
}

interface GenerationResult {
  relevance: number;
  cards: GeneratedCard[];
}

async function generateCardsForCategory(
  scopeId: string,
  category: CapabilityCardCategory,
): Promise<GenerationResult> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    log.info("No configured provider for capability card generation");
    return { relevance: 0, cards: [] };
  }

  const rollup = buildMemoryRollup(scopeId);
  if (!rollup) {
    log.info("No memory items to generate capability cards from");
    return { relevance: 0, cards: [] };
  }

  const skills = buildSkillsSummary();
  const icons = ICON_PALETTE[category] ?? [];
  const allIcons = [
    ...icons,
    // A few general-purpose icons always available
    "lucide-sparkles",
    "lucide-wand",
    "lucide-lightbulb",
    "lucide-star",
    "lucide-briefcase",
  ];

  const systemPrompt = `You are generating capability cards for a personal AI assistant's new thread page. These cards showcase what the assistant can do, personalized to the user's context.

You are generating cards for the "${category}" category: ${CATEGORY_DESCRIPTIONS[category]}.

Given the user's memories below, do two things:
1. Assess how relevant this category is to this user (0.0–1.0). A score of 0.7+ means the user has clear context that makes this category actionable. Score lower if the user's memories have little relation to this category.
2. If relevant (0.7+), generate 2–3 capability cards that cross the user's context with what the assistant can do in this area.

For each card, provide:
- icon: One of these Lucide icon names: ${allIcons.join(", ")}
- title: Action-oriented, verb-first, max 50 chars (e.g., "Triage your inbox", "Debug the auth middleware")
- description: One line explaining the outcome, personalized to the user's context, max 120 chars
- prompt: The full message that will be sent when clicked (1-2 natural sentences, as if the user typed it)
- tags: 1-3 short labels for integrations/tools involved (e.g., "Gmail", "Calendar", "Linear")

Rules:
- Be specific to THIS user — generic suggestions are not useful.
- Titles should be concise and scannable, starting with a verb.
- Prompts should be natural, as if the user typed them.
- Tags should reference actual tools/services relevant to the suggestion.
- If relevance is below 0.7, you may return an empty cards array.

${rollup}
${skills}`;

  const { signal, cleanup } = createTimeout(25000);
  try {
    const response = await provider.sendMessage(
      [
        userMessage(
          `Generate capability cards for the "${category}" category based on my context.`,
        ),
      ],
      [
        {
          name: "store_capability_cards",
          description:
            "Store the relevance assessment and generated capability cards",
          input_schema: {
            type: "object" as const,
            properties: {
              relevance: {
                type: "number",
                description:
                  "How relevant this category is to the user (0.0–1.0)",
              },
              cards: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    icon: {
                      type: "string",
                      description: "Lucide icon name from the provided list",
                    },
                    title: {
                      type: "string",
                      description:
                        "Action-oriented title, verb-first, max 50 chars",
                    },
                    description: {
                      type: "string",
                      description:
                        "One-line outcome description, max 120 chars",
                    },
                    prompt: {
                      type: "string",
                      description: "Full message sent on click (1-2 sentences)",
                    },
                    tags: {
                      type: "array",
                      items: { type: "string" },
                      description: "1-3 integration/tool tags",
                    },
                  },
                  required: ["icon", "title", "description", "prompt", "tags"],
                },
              },
            },
            required: ["relevance", "cards"],
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
            name: "store_capability_cards",
          },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn("No tool_use block in capability card generation response");
      return { relevance: 0, cards: [] };
    }

    const input = toolBlock.input as {
      relevance?: number;
      cards?: GeneratedCard[];
    };

    const relevance =
      typeof input.relevance === "number"
        ? Math.max(0, Math.min(1, input.relevance))
        : 0;

    if (!Array.isArray(input.cards)) {
      return { relevance, cards: [] };
    }

    const cards = input.cards
      .filter(
        (c) =>
          typeof c.title === "string" &&
          c.title.length > 0 &&
          typeof c.prompt === "string" &&
          c.prompt.length > 0,
      )
      .map((c) => ({
        icon:
          typeof c.icon === "string" && c.icon.length > 0
            ? c.icon
            : "lucide-sparkles",
        title: truncate(c.title, 50, ""),
        description: truncate(c.description ?? "", 120, ""),
        prompt: truncate(c.prompt, 500, ""),
        tags: Array.isArray(c.tags)
          ? c.tags.filter((t): t is string => typeof t === "string").slice(0, 3)
          : [],
      }));

    return { relevance, cards };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ── Job handler ───────────────────────────────────────────────────

export async function generateCapabilityCardsJob(
  job: MemoryJob,
): Promise<void> {
  const scopeId = asString(job.payload.scopeId) ?? "default";
  const category = asString(job.payload.category) as
    | CapabilityCardCategory
    | undefined;

  if (
    !category ||
    !(CAPABILITY_CARD_CATEGORIES as readonly string[]).includes(category)
  ) {
    log.warn({ category }, "Invalid or missing category for capability cards");
    return;
  }

  const result = await generateCardsForCategory(scopeId, category);

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

  // Upsert category relevance
  db.insert(capabilityCardCategories)
    .values({
      scopeId,
      category,
      relevance: result.relevance,
      generationBatch: nextBatch,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        capabilityCardCategories.scopeId,
        capabilityCardCategories.category,
      ],
      set: {
        relevance: result.relevance,
        generationBatch: nextBatch,
        createdAt: now,
      },
    })
    .run();

  // Delete old cards for this category+scope, then insert new ones
  db.delete(threadStarters)
    .where(
      and(
        eq(threadStarters.scopeId, scopeId),
        eq(threadStarters.category, category),
        eq(threadStarters.cardType, "card"),
      ),
    )
    .run();

  // Insert new cards
  for (const card of result.cards) {
    db.insert(threadStarters)
      .values({
        id: uuid(),
        label: card.title,
        prompt: card.prompt,
        icon: card.icon,
        description: card.description,
        tags: card.tags.join(","),
        category,
        cardType: "card",
        generationBatch: nextBatch,
        scopeId,
        sourceMemoryKinds: null,
        createdAt: now,
      })
      .run();
  }

  // Update batch checkpoint
  db.insert(memoryCheckpoints)
    .values({
      key: checkpointKey(CK_BATCH, scopeId),
      value: String(nextBatch),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: memoryCheckpoints.key,
      set: { value: String(nextBatch), updatedAt: now },
    })
    .run();

  log.info(
    {
      scopeId,
      category,
      relevance: result.relevance,
      cardCount: result.cards.length,
      batch: nextBatch,
    },
    "Generated capability cards",
  );
}
