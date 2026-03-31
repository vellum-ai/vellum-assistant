import { eq } from "drizzle-orm";

import { estimateTextTokens } from "../../context/token-estimator.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { memoryItems } from "../schema.js";
import type { Candidate } from "./types.js";

const log = getLogger("memory-formatting");

/**
 * Escape XML-like tag sequences in recalled text to prevent delimiter injection.
 * Recalled content is interpolated verbatim inside `<memory>` wrapper tags,
 * so any literal `</memory>` (or similar) in the text could break the wrapper
 * and let recalled content masquerade as top-level prompt instructions.
 *
 * Strategy: replace `<` in any XML-tag-like pattern with the Unicode full-width
 * less-than sign (U+FF1C) which is visually similar but won't be parsed as XML.
 */
export function escapeXmlTags(text: string): string {
  // Match anything that looks like an XML tag: <word...> or </word...>
  return text.replace(
    /<\/?[a-zA-Z][a-zA-Z0-9_-]*[\s>\/]/g,
    (match) => "\uFF1C" + match.slice(1),
  );
}

/**
 * Convert an epoch-ms timestamp to a timezone-aware absolute time string.
 * Format: "YYYY-MM-DD HH:mm TZ" (e.g. "2025-02-13 15:30 PST").
 */
export function formatAbsoluteTime(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  // Extract short timezone abbreviation (e.g. "PST", "EST", "UTC")
  const tz =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "UTC";

  return `${year}-${month}-${day} ${hours}:${minutes} ${tz}`;
}

/**
 * Convert an epoch-ms timestamp to a human-readable relative time string.
 */
export function formatRelativeTime(epochMs: number): string {
  const elapsed = Math.max(0, Date.now() - epochMs);
  const hours = elapsed / (1000 * 60 * 60);
  if (hours < 1) return "just now";
  if (hours < 24) {
    const h = Math.floor(hours);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = hours / 24;
  if (days < 7) {
    const d = Math.floor(days);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return `${m} month${m === 1 ? "" : "s"} ago`;
  }
  const y = Math.floor(days / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------
// Unified injection format
// ---------------------------------------------------------------------------

/**
 * Build a unified `<memory_context>` XML injection block from scored candidates.
 *
 * All candidates are rendered in a single `<recalled>` section sorted by
 * `finalScore` descending, with each candidate tagged by type:
 * - items: `<item id="item:ID" kind="KIND" importance="N.NN" timestamp="..." from="...">`
 * - segments: `<segment id="seg:ID" timestamp="..." from="...">`
 * - summaries: `<summary id="sum:ID" timestamp="..." from="...">`
 *
 * An optional `<echoes>` section renders serendipity items — random
 * importance-weighted memories for unexpected connections.
 *
 * Respects token budget: iterates candidates in score order, accumulates
 * token estimates, and stops when the budget is exhausted.
 */
export function buildMemoryInjection(params: {
  candidates: Array<Candidate & { sourceLabel?: string; staleness?: string; supersedes?: string }>;
  serendipityItems?: Array<Candidate & { sourceLabel?: string }>;
  totalBudgetTokens?: number;
}): string {
  const { candidates, serendipityItems, totalBudgetTokens } = params;

  if (candidates.length === 0 && (!serendipityItems || serendipityItems.length === 0)) {
    return "";
  }

  // Sort by finalScore descending
  const sorted = [...candidates].sort((a, b) => b.finalScore - a.finalScore);

  // Reserve tokens for structural overhead
  const WRAPPER_OVERHEAD_TOKENS = estimateTextTokens(
    "<memory_context __injected>\n<recalled>\n</recalled>\n</memory_context>",
  );
  let remainingTokens = totalBudgetTokens
    ? Math.max(1, totalBudgetTokens - WRAPPER_OVERHEAD_TOKENS)
    : Infinity;

  // Render candidates within budget
  const lines: string[] = [];
  for (const c of sorted) {
    if (remainingTokens <= 0) break;
    const line = renderCandidate(c);
    const tokens = estimateTextTokens(line);
    if (tokens > remainingTokens) continue;
    lines.push(line);
    remainingTokens -= tokens;
  }

  if (lines.length === 0 && (!serendipityItems || serendipityItems.length === 0)) {
    return "";
  }

  const sections: string[] = [];

  if (lines.length > 0) {
    sections.push(`<recalled>\n${lines.join("\n")}\n</recalled>`);
  }

  // Echoes section for serendipity items — capped at ~400 tokens of
  // the remaining budget after <recalled> items are rendered.
  if (serendipityItems && serendipityItems.length > 0) {
    const ECHOES_MAX_TOKENS = 400;
    let echoesBudget = Math.min(remainingTokens, ECHOES_MAX_TOKENS);
    const echoLines: string[] = [];
    for (const c of serendipityItems) {
      if (echoesBudget <= 0) break;
      const line = renderCandidate(c);
      const tokens = estimateTextTokens(line);
      if (tokens > echoesBudget) continue;
      echoLines.push(line);
      echoesBudget -= tokens;
      remainingTokens -= tokens;
    }
    if (echoLines.length > 0) {
      sections.push(`<echoes>\n${echoLines.join("\n")}\n</echoes>`);
    }
  }

  if (sections.length === 0) return "";

  return `<memory_context __injected>\n${sections.join("\n")}\n</memory_context>`;
}

/**
 * Look up the supersession chain for a given superseded item ID.
 *
 * Returns the immediate predecessor's statement and timestamp, plus the
 * total chain depth (how many items were superseded in sequence).
 * Chain traversal is capped at 10 iterations to prevent infinite loops.
 */
export function lookupSupersessionChain(supersededId: string): {
  previousStatement: string;
  previousTimestamp: number;
  chainDepth: number;
} | null {
  try {
    const db = getDb();

    // Look up the immediate predecessor
    const predecessor = db
      .select({
        statement: memoryItems.statement,
        firstSeenAt: memoryItems.firstSeenAt,
        supersedes: memoryItems.supersedes,
      })
      .from(memoryItems)
      .where(eq(memoryItems.id, supersededId))
      .get();

    if (!predecessor) return null;

    // Count chain depth by following supersedes links (cap at 10)
    let chainDepth = 1;
    let currentSupersedes = predecessor.supersedes;
    const MAX_CHAIN_DEPTH = 10;

    while (currentSupersedes && chainDepth < MAX_CHAIN_DEPTH) {
      const ancestor = db
        .select({ supersedes: memoryItems.supersedes })
        .from(memoryItems)
        .where(eq(memoryItems.id, currentSupersedes))
        .get();

      if (!ancestor) break;
      chainDepth++;
      currentSupersedes = ancestor.supersedes;
    }

    return {
      previousStatement: predecessor.statement,
      previousTimestamp: predecessor.firstSeenAt,
      chainDepth,
    };
  } catch (err) {
    log.warn({ err }, "Failed to look up supersession chain");
    return null;
  }
}

/**
 * Render a single candidate as an XML element based on its type.
 */
function renderCandidate(c: Candidate & { sourceLabel?: string; supersedes?: string }): string {
  const text = escapeXmlTags(c.text);
  const timestamp = formatAbsoluteTime(c.createdAt);
  const fromAttr = c.sourceLabel
    ? ` from="${escapeXmlAttr(c.sourceLabel)}"`
    : "";
  const pathAttr = c.sourcePath
    ? ` path="${escapeXmlAttr(c.sourcePath)}"`
    : "";

  // Build inline supersession suffix for items
  let supersessionSuffix = "";
  if (c.type === "item" && c.supersedes) {
    const chain = lookupSupersessionChain(c.supersedes);
    if (chain) {
      const prevTimestamp = formatAbsoluteTime(chain.previousTimestamp);
      supersessionSuffix = `<supersedes count="${chain.chainDepth}">${escapeXmlTags(chain.previousStatement)} (${prevTimestamp})</supersedes>`;
    }
  }

  switch (c.type) {
    case "item":
      return `<item id="item:${escapeXmlAttr(c.id)}" kind="${escapeXmlAttr(c.kind)}" importance="${c.importance.toFixed(2)}" timestamp="${escapeXmlAttr(timestamp)}"${fromAttr}${pathAttr}>${text}${supersessionSuffix}</item>`;
    case "segment":
      return `<segment id="seg:${escapeXmlAttr(c.id)}" timestamp="${escapeXmlAttr(timestamp)}"${fromAttr}${pathAttr}>${text}</segment>`;
    case "summary":
      return `<summary id="sum:${escapeXmlAttr(c.id)}" timestamp="${escapeXmlAttr(timestamp)}"${fromAttr}${pathAttr}>${text}</summary>`;
    default:
      // media or unknown types — render as item
      return `<item id="item:${escapeXmlAttr(c.id)}" kind="${escapeXmlAttr(c.kind)}" importance="${c.importance.toFixed(2)}" timestamp="${escapeXmlAttr(timestamp)}"${fromAttr}${pathAttr}>${text}${supersessionSuffix}</item>`;
  }
}

function escapeXmlAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
