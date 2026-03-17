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
  conversationStarters,
  memoryCheckpoints,
} from "../schema.js";
import {
  buildMemoryRollup,
  buildSkillsSummary,
} from "./conversation-starters.js";

const log = getLogger("capability-cards-gen");

/** Capability categories for the feed. */
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
 * Internal clusters that guide card generation intent. Categories map to one
 * of these clusters to shape copy tone and priority signals.
 */
export type CardCluster = "contextual" | "active_work" | "discovery";

export const CATEGORY_CLUSTER: Record<CapabilityCardCategory, CardCluster> = {
  communication: "contextual",
  productivity: "active_work",
  development: "active_work",
  media: "discovery",
  automation: "discovery",
  web_social: "discovery",
  integration: "discovery",
};

/** Cluster precedence — lower index = higher hero-candidate priority. */
export const CLUSTER_PRECEDENCE: CardCluster[] = [
  "contextual",
  "active_work",
  "discovery",
];

/**
 * Allowed action-value tags. The LLM must choose from this set instead of
 * tool/integration taxonomy labels.
 */
const ACTION_VALUE_TAGS = [
  "Quick win",
  "Most useful tonight",
  "Unblocks tomorrow",
  "High leverage",
  "Work",
  "Personal",
  "2 min",
  "5 min",
] as const;

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
  high_priority: boolean;
}

interface GenerationResult {
  relevance: number;
  cards: GeneratedCard[];
}

/** Cluster-specific prompt guidance for outcome-first copy generation. */
function buildClusterPrompt(cluster: CardCluster): string {
  switch (cluster) {
    case "contextual":
      return "These cards address something happening right now — an unread message, an upcoming meeting, a recent notification. Emphasize timeliness and the relief of handling it. high_priority is appropriate here when there is a clear deadline or unread item.";
    case "active_work":
      return "These cards relate to work the user is actively doing — open PRs, in-progress tasks, ongoing projects. Emphasize momentum and getting unblocked. high_priority is appropriate only if there is a concrete blocker or imminent deadline.";
    case "discovery":
      return "These cards surface capabilities the user might not know about or hasn't tried yet. Emphasize the payoff and how little effort it takes. high_priority should almost never be true for discovery cards.";
  }
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
  const cluster = CATEGORY_CLUSTER[category];
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

  const clusterGuidance = buildClusterPrompt(cluster);

  const systemPrompt = `You are generating action-concierge cards for a personal AI assistant. Each card should read like a service the user would want — outcome-first, emphasizing what they get, not what the system does internally.

You are generating cards for the "${category}" category: ${CATEGORY_DESCRIPTIONS[category]}.
Cluster intent: ${cluster} — ${clusterGuidance}

Given the user's memories below, do two things:
1. Assess how relevant this category is to this user (0.0–1.0). A score of 0.7+ means the user has clear context that makes this category actionable. Score lower if the user's memories have little relation to this category.
2. If relevant (0.7+), generate 2–3 cards ordered strongest-first (the card you're most confident delivers value should come first).

For each card, provide:
- icon: One of these Lucide icon names: ${allIcons.join(", ")}
- title: Outcome-first, user-desire-oriented, max 50 chars. Frame as what the user gets, not what the tool does. Good: "Clear your inbox before standup", "Unblock the auth PR". Bad: "Run email triage", "Check PR status".
- description: One line explaining the concrete payoff, personalized to the user's context, max 120 chars
- prompt: The full message that will be sent when clicked (1-2 natural sentences, as if the user typed it)
- tags: 1-2 action-value labels from this list ONLY: ${ACTION_VALUE_TAGS.join(", ")}. Choose labels that signal urgency, payoff, or effort — never use tool or integration names as tags.
- high_priority: true ONLY if there is a concrete why-now moment (e.g., a meeting in the next few hours, an unread thread from today, a deploy deadline). Do not mark cards as high_priority for general usefulness.

Rules:
- Be specific to THIS user — generic suggestions are not useful.
- Cards should feel like services the user would want, not internal task tickets.
- Return cards strongest-first — the first card should be the most compelling.
- Prompts should be natural, as if the user typed them.
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
                      description:
                        "1-2 action-value labels from the allowed set",
                    },
                    high_priority: {
                      type: "boolean",
                      description:
                        "true only for concrete why-now moments, false otherwise",
                    },
                  },
                  required: [
                    "icon",
                    "title",
                    "description",
                    "prompt",
                    "tags",
                    "high_priority",
                  ],
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

    // Preserve model order (strongest-first) and cap visible tags at 2
    const allowedTags = new Set<string>(ACTION_VALUE_TAGS);
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
          ? c.tags
              .filter(
                (t): t is string => typeof t === "string" && allowedTags.has(t),
              )
              .slice(0, 2)
          : [],
        high_priority: c.high_priority === true,
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
  db.delete(conversationStarters)
    .where(
      and(
        eq(conversationStarters.scopeId, scopeId),
        eq(conversationStarters.category, category),
        eq(conversationStarters.cardType, "card"),
      ),
    )
    .run();

  // Insert new cards — encode high_priority as a tag prefix so the route
  // layer can read the signal without a schema migration.
  for (const card of result.cards) {
    const tagParts = [...card.tags];
    if (card.high_priority) {
      tagParts.unshift("__high_priority__");
    }
    db.insert(conversationStarters)
      .values({
        id: uuid(),
        label: card.title,
        prompt: card.prompt,
        icon: card.icon,
        description: card.description,
        tags: tagParts.join(","),
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
