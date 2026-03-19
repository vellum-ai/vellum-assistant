/**
 * Archive recall: retrieval layer over the simplified memory archive tables
 * (memory_observations, memory_chunks, memory_episodes).
 *
 * Two retrieval paths:
 *
 * 1. **Prefetch** — lightweight query run on every turn. Fetches recent
 *    episodes and observations to detect whether the user's turn references
 *    past context that the archive can answer.
 *
 * 2. **Deeper recall** — triggered when the prefetch surfaces strong hits,
 *    or when the user's turn contains explicit past-reference or
 *    analogy/debugging-shaped language. Queries all three archive tables
 *    and returns up to 3 source-linked bullets wrapped in
 *    `<supporting_recall>`.
 *
 * Empty results produce no output (no `<supporting_recall>` tag).
 */

import { and, desc, eq, like, or, sql } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { memoryChunks, memoryEpisodes, memoryObservations } from "./schema.js";

const log = getLogger("memory-archive-recall");

// ── Pattern matchers ────────────────────────────────────────────────

/**
 * Phrases that signal the user is explicitly referencing a past
 * interaction, artifact, or fact the assistant should recall.
 */
const PAST_REFERENCE_PATTERNS = [
  /\b(?:remember|recall|mentioned|talked about|discussed|said|told you|last time|earlier|before|previously)\b/i,
  /\bwhat (?:did|was|were)\b.*\b(?:we|i|you)\b/i,
  /\bdo you (?:know|remember)\b/i,
];

/**
 * Phrases that signal an analogy or debugging-shaped query where
 * historical context would be especially valuable.
 */
const ANALOGY_DEBUG_PATTERNS = [
  /\b(?:similar to|like when|same (?:issue|problem|error|bug)|happened before|recurring|déjà vu)\b/i,
  /\b(?:last time.*(?:fix|solve|debug|resolve))\b/i,
  /\b(?:keep (?:getting|seeing|hitting)|again|keeps happening)\b/i,
];

// ── Turn classification ─────────────────────────────────────────────

export type RecallTrigger =
  | "explicit_past_reference"
  | "analogy_debug"
  | "strong_prefetch"
  | "none";

/**
 * Classify whether a user turn warrants deeper archive recall.
 */
export function classifyRecallTrigger(
  userText: string,
  prefetchHitCount: number,
): RecallTrigger {
  if (PAST_REFERENCE_PATTERNS.some((p) => p.test(userText))) {
    return "explicit_past_reference";
  }
  if (ANALOGY_DEBUG_PATTERNS.some((p) => p.test(userText))) {
    return "analogy_debug";
  }
  if (prefetchHitCount >= 2) {
    return "strong_prefetch";
  }
  return "none";
}

// ── Prefetch ────────────────────────────────────────────────────────

/** A lightweight prefetch hit from the archive tables. */
export interface PrefetchHit {
  source: "episode" | "observation" | "chunk";
  id: string;
  content: string;
  createdAt: number;
  conversationId?: string | null;
}

/**
 * Lightweight prefetch over recent episodes and observations for the
 * given scope. Returns up to `limit` hits ordered by recency. This is
 * cheap enough to run on every turn.
 */
export function prefetchArchive(
  scopeId: string,
  userText: string,
  limit: number = 10,
): PrefetchHit[] {
  const db = getDb();
  const hits: PrefetchHit[] = [];

  // Extract meaningful keywords from user text (words >= 4 chars)
  const keywords = extractKeywords(userText);
  if (keywords.length === 0) return hits;

  try {
    // Query recent episodes whose title or summary contain any keyword
    const episodeConditions = keywords.map((kw) =>
      or(
        like(memoryEpisodes.title, `%${kw}%`),
        like(memoryEpisodes.summary, `%${kw}%`),
      ),
    );

    const episodes = db
      .select({
        id: memoryEpisodes.id,
        title: memoryEpisodes.title,
        summary: memoryEpisodes.summary,
        createdAt: memoryEpisodes.createdAt,
        conversationId: memoryEpisodes.conversationId,
      })
      .from(memoryEpisodes)
      .where(and(eq(memoryEpisodes.scopeId, scopeId), or(...episodeConditions)))
      .orderBy(desc(memoryEpisodes.createdAt))
      .limit(limit)
      .all();

    for (const ep of episodes) {
      hits.push({
        source: "episode",
        id: ep.id,
        content: `${ep.title}: ${ep.summary}`,
        createdAt: ep.createdAt,
        conversationId: ep.conversationId,
      });
    }

    // Query recent observations whose content matches any keyword
    const observationConditions = keywords.map((kw) =>
      like(memoryObservations.content, `%${kw}%`),
    );

    const observations = db
      .select({
        id: memoryObservations.id,
        content: memoryObservations.content,
        createdAt: memoryObservations.createdAt,
        conversationId: memoryObservations.conversationId,
      })
      .from(memoryObservations)
      .where(
        and(
          eq(memoryObservations.scopeId, scopeId),
          or(...observationConditions),
        ),
      )
      .orderBy(desc(memoryObservations.createdAt))
      .limit(limit)
      .all();

    for (const obs of observations) {
      hits.push({
        source: "observation",
        id: obs.id,
        content: obs.content,
        createdAt: obs.createdAt,
        conversationId: obs.conversationId,
      });
    }
  } catch (err) {
    log.warn({ err }, "Archive prefetch failed");
  }

  // Sort all hits by recency and cap at limit
  hits.sort((a, b) => b.createdAt - a.createdAt);
  return hits.slice(0, limit);
}

// ── Deeper recall ───────────────────────────────────────────────────

/** A source-linked recall bullet for injection. */
export interface RecallBullet {
  /** Human-readable one-line summary. */
  text: string;
  /** Which archive table sourced this bullet. */
  source: "episode" | "observation" | "chunk";
  /** Row ID in the source table. */
  sourceId: string;
  /** Optional conversation title for provenance. */
  conversationTitle?: string | null;
}

export interface ArchiveRecallResult {
  /** The recall trigger that activated deeper recall (or "none"). */
  trigger: RecallTrigger;
  /** Up to 3 source-linked bullets. Empty when no relevant results. */
  bullets: RecallBullet[];
  /** Rendered `<supporting_recall>` block, or empty string. */
  text: string;
  /** Number of prefetch hits examined. */
  prefetchHitCount: number;
}

/**
 * Run archive recall for a user turn.
 *
 * 1. Runs a lightweight prefetch over episodes and observations.
 * 2. Classifies whether deeper recall is warranted.
 * 3. If triggered, queries all three archive tables and assembles
 *    up to 3 source-linked bullets.
 * 4. Returns rendered `<supporting_recall>` or empty string.
 */
export function buildArchiveRecall(
  scopeId: string,
  userText: string,
): ArchiveRecallResult {
  // Step 1: prefetch
  const prefetchHits = prefetchArchive(scopeId, userText);
  const prefetchHitCount = prefetchHits.length;

  // Step 2: classify
  const trigger = classifyRecallTrigger(userText, prefetchHitCount);

  if (trigger === "none") {
    return {
      trigger,
      bullets: [],
      text: "",
      prefetchHitCount,
    };
  }

  // Step 3: deeper recall
  const bullets = deeperRecall(scopeId, userText, prefetchHits);

  // Step 4: render
  const text = renderSupportingRecall(bullets);

  log.debug(
    {
      trigger,
      prefetchHitCount,
      bulletCount: bullets.length,
    },
    "Archive recall completed",
  );

  return {
    trigger,
    bullets,
    text,
    prefetchHitCount,
  };
}

// ── Deeper recall implementation ────────────────────────────────────

/**
 * Query all three archive tables for the user's text and assemble
 * up to 3 source-linked bullets. Prioritizes episodes (narrative
 * summaries) over observations (raw facts) over chunks (indexed text).
 */
function deeperRecall(
  scopeId: string,
  userText: string,
  prefetchHits: PrefetchHit[],
): RecallBullet[] {
  const db = getDb();
  const keywords = extractKeywords(userText);
  if (keywords.length === 0) return [];

  const bullets: RecallBullet[] = [];
  const seenContent = new Set<string>();
  const MAX_BULLETS = 3;

  try {
    // --- Episodes: highest signal (narrative summaries) ---
    const episodeConditions = keywords.map((kw) =>
      or(
        like(memoryEpisodes.title, `%${kw}%`),
        like(memoryEpisodes.summary, `%${kw}%`),
      ),
    );

    const episodes = db
      .select({
        id: memoryEpisodes.id,
        title: memoryEpisodes.title,
        summary: memoryEpisodes.summary,
        conversationId: memoryEpisodes.conversationId,
      })
      .from(memoryEpisodes)
      .where(and(eq(memoryEpisodes.scopeId, scopeId), or(...episodeConditions)))
      .orderBy(desc(memoryEpisodes.createdAt))
      .limit(MAX_BULLETS)
      .all();

    for (const ep of episodes) {
      if (bullets.length >= MAX_BULLETS) break;
      const normalized = normalizeForDedup(ep.summary);
      if (seenContent.has(normalized)) continue;
      seenContent.add(normalized);

      const convTitle = lookupConversationTitle(db, ep.conversationId);
      bullets.push({
        text: `${ep.title} — ${truncate(ep.summary, 200)}`,
        source: "episode",
        sourceId: ep.id,
        conversationTitle: convTitle,
      });
    }

    // --- Observations: raw factual statements ---
    if (bullets.length < MAX_BULLETS) {
      const observationConditions = keywords.map((kw) =>
        like(memoryObservations.content, `%${kw}%`),
      );

      const observations = db
        .select({
          id: memoryObservations.id,
          content: memoryObservations.content,
          conversationId: memoryObservations.conversationId,
        })
        .from(memoryObservations)
        .where(
          and(
            eq(memoryObservations.scopeId, scopeId),
            or(...observationConditions),
          ),
        )
        .orderBy(desc(memoryObservations.createdAt))
        .limit(MAX_BULLETS)
        .all();

      for (const obs of observations) {
        if (bullets.length >= MAX_BULLETS) break;
        const normalized = normalizeForDedup(obs.content);
        if (seenContent.has(normalized)) continue;
        seenContent.add(normalized);

        const convTitle = lookupConversationTitle(db, obs.conversationId);
        bullets.push({
          text: truncate(obs.content, 200),
          source: "observation",
          sourceId: obs.id,
          conversationTitle: convTitle,
        });
      }
    }

    // --- Chunks: indexed text fragments ---
    if (bullets.length < MAX_BULLETS) {
      const chunkConditions = keywords.map((kw) =>
        like(memoryChunks.content, `%${kw}%`),
      );

      const chunks = db
        .select({
          id: memoryChunks.id,
          content: memoryChunks.content,
          observationId: memoryChunks.observationId,
        })
        .from(memoryChunks)
        .where(and(eq(memoryChunks.scopeId, scopeId), or(...chunkConditions)))
        .orderBy(desc(memoryChunks.createdAt))
        .limit(MAX_BULLETS)
        .all();

      for (const chunk of chunks) {
        if (bullets.length >= MAX_BULLETS) break;
        const normalized = normalizeForDedup(chunk.content);
        if (seenContent.has(normalized)) continue;
        seenContent.add(normalized);

        // Look up the observation's conversationId for provenance
        const obs = db
          .select({ conversationId: memoryObservations.conversationId })
          .from(memoryObservations)
          .where(eq(memoryObservations.id, chunk.observationId))
          .get();

        const convTitle = obs
          ? lookupConversationTitle(db, obs.conversationId)
          : null;

        bullets.push({
          text: truncate(chunk.content, 200),
          source: "chunk",
          sourceId: chunk.id,
          conversationTitle: convTitle,
        });
      }
    }
  } catch (err) {
    log.warn({ err }, "Deeper archive recall failed");
  }

  // Also incorporate prefetch hits that weren't already captured
  for (const hit of prefetchHits) {
    if (bullets.length >= MAX_BULLETS) break;
    const normalized = normalizeForDedup(hit.content);
    if (seenContent.has(normalized)) continue;
    seenContent.add(normalized);

    bullets.push({
      text: truncate(hit.content, 200),
      source: hit.source,
      sourceId: hit.id,
    });
  }

  return bullets.slice(0, MAX_BULLETS);
}

// ── Rendering ───────────────────────────────────────────────────────

/**
 * Render recall bullets into `<supporting_recall>` XML block.
 * Returns empty string when there are no bullets.
 */
export function renderSupportingRecall(bullets: RecallBullet[]): string {
  if (bullets.length === 0) return "";

  const lines = bullets.map((b) => {
    const provenance = b.conversationTitle
      ? ` (from: ${b.conversationTitle})`
      : "";
    return `- ${b.text}${provenance}`;
  });

  return `<supporting_recall>\n${lines.join("\n")}\n</supporting_recall>`;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract meaningful keywords from user text for LIKE-based matching.
 * Filters out short words (< 4 chars) and common stop words.
 */
export function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    "about",
    "also",
    "been",
    "could",
    "does",
    "from",
    "have",
    "into",
    "just",
    "know",
    "like",
    "make",
    "more",
    "much",
    "only",
    "over",
    "said",
    "some",
    "than",
    "that",
    "them",
    "then",
    "they",
    "this",
    "very",
    "want",
    "were",
    "what",
    "when",
    "will",
    "with",
    "your",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  return [...new Set(words)];
}

/**
 * Look up a conversation's title for provenance display.
 */
function lookupConversationTitle(
  db: ReturnType<typeof getDb>,
  conversationId: string,
): string | null {
  try {
    const row = db
      .select({ title: sql<string | null>`title` })
      .from(sql`conversations`)
      .where(sql`id = ${conversationId}`)
      .get();
    return row?.title ?? null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

/**
 * Normalize text for content deduplication across sources.
 */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
