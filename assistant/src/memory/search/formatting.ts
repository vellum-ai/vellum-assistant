import { estimateTextTokens } from "../../context/token-estimator.js";
import type { TieredCandidate } from "./tier-classifier.js";

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
// Two-layer injection format
// ---------------------------------------------------------------------------

/** Kinds classified as identity for the <user_identity> section. */
export const IDENTITY_KINDS = new Set(["identity"]);

/** Kinds classified as preferences for the <applicable_preferences> section. */
export const PREFERENCE_KINDS = new Set(["preference", "constraint"]);

/** Per-item token budget for tier 1 items. */
const TIER1_PER_ITEM_TOKENS = 150;

/** Per-item token budget for tier 2 items. */
const TIER2_PER_ITEM_TOKENS = 100;

/** Approximate chars-per-token for truncation (matches token-estimator). */
const CHARS_PER_TOKEN = 4;

/**
 * Build a two-layer XML injection block from tiered candidates.
 *
 * Sections:
 * - `<user_identity>`: identity-kind items from tier 1 (plain statements)
 * - `<relevant_context>`: tier 1 non-identity, non-preference items (episode-wrapped)
 * - `<applicable_preferences>`: preference/constraint items from tier 1 (plain statements)
 * - `<possibly_relevant>`: tier 2 items (episode-wrapped with optional staleness)
 *
 * Empty sections are omitted. If all sections are empty, returns `""`.
 */
export function buildTwoLayerInjection(params: {
  identityItems: TieredCandidate[];
  tier1Candidates: TieredCandidate[];
  tier2Candidates: TieredCandidate[];
  preferences: TieredCandidate[];
  totalBudgetTokens?: number;
}): string {
  const {
    identityItems,
    tier1Candidates,
    tier2Candidates,
    preferences,
    totalBudgetTokens,
  } = params;

  // If everything is empty, return empty string
  if (
    identityItems.length === 0 &&
    tier1Candidates.length === 0 &&
    tier2Candidates.length === 0 &&
    preferences.length === 0
  ) {
    return "";
  }

  // Budget tracking — tier 1 gets priority.
  // Reserve tokens for XML wrapper overhead (<memory_context>, section tags,
  // newlines between sections) so the final assembled text stays within budget.
  const WRAPPER_OVERHEAD_TOKENS = estimateTextTokens(
    "<memory_context>\n\n\n\n</memory_context>",
  );
  const SECTION_TAG_TOKENS = estimateTextTokens(
    "<possibly_relevant>\n\n</possibly_relevant>",
  );
  const sectionCount = [
    identityItems.length,
    tier1Candidates.length,
    tier2Candidates.length,
    preferences.length,
  ].filter((n) => n > 0).length;
  const structuralOverhead =
    WRAPPER_OVERHEAD_TOKENS + sectionCount * SECTION_TAG_TOKENS;
  let remainingTokens = totalBudgetTokens
    ? Math.max(1, totalBudgetTokens - structuralOverhead)
    : Infinity;

  // Render tier 1 items first (identity, relevant context, preferences)
  const identityLines = renderPlainStatements(
    identityItems,
    TIER1_PER_ITEM_TOKENS,
    remainingTokens,
  );
  remainingTokens -= estimateTextTokens(identityLines.join("\n"));

  const relevantEpisodes = renderEpisodes(
    tier1Candidates,
    TIER1_PER_ITEM_TOKENS,
    remainingTokens,
  );
  remainingTokens -= estimateTextTokens(relevantEpisodes.join("\n"));

  const preferenceLines = renderPlainStatements(
    preferences,
    TIER1_PER_ITEM_TOKENS,
    remainingTokens,
  );
  remainingTokens -= estimateTextTokens(preferenceLines.join("\n"));

  // Tier 2 uses remaining budget
  const possiblyRelevantEpisodes = renderEpisodesWithStaleness(
    tier2Candidates,
    TIER2_PER_ITEM_TOKENS,
    remainingTokens,
  );

  // Assemble sections — omit empty ones
  const sections: string[] = [];

  if (identityLines.length > 0) {
    sections.push(
      `<user_identity>\n${identityLines.join("\n")}\n</user_identity>`,
    );
  }

  if (relevantEpisodes.length > 0) {
    sections.push(
      `<relevant_context>\n${relevantEpisodes.join("\n")}\n</relevant_context>`,
    );
  }

  if (preferenceLines.length > 0) {
    sections.push(
      `<applicable_preferences>\n${preferenceLines.join("\n")}\n</applicable_preferences>`,
    );
  }

  if (possiblyRelevantEpisodes.length > 0) {
    sections.push(
      `<possibly_relevant>\n${possiblyRelevantEpisodes.join("\n")}\n</possibly_relevant>`,
    );
  }

  if (sections.length === 0) return "";

  return `<memory_context>\n\n${sections.join("\n\n")}\n\n</memory_context>`;
}

/**
 * Render candidates as plain statement lines (for identity / preference sections).
 */
function renderPlainStatements(
  items: TieredCandidate[],
  perItemBudgetTokens: number,
  remainingBudget: number,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used >= remainingBudget) break;
    const maxChars = perItemBudgetTokens * CHARS_PER_TOKEN;
    const text = escapeXmlTags(truncate(item.text, maxChars));
    const tokens = estimateTextTokens(text);
    if (used + tokens > remainingBudget) break;
    lines.push(text);
    used += tokens;
  }
  return lines;
}

/**
 * Render candidates as `<episode>` elements with source attribution.
 */
function renderEpisodes(
  items: TieredCandidate[],
  perItemBudgetTokens: number,
  remainingBudget: number,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used >= remainingBudget) break;
    const maxChars = perItemBudgetTokens * CHARS_PER_TOKEN;
    const text = escapeXmlTags(truncate(item.text, maxChars));
    const sourceAttr = buildSourceAttr(item);
    const line = `<episode${sourceAttr}>\n${text}\n</episode>`;
    const tokens = estimateTextTokens(line);
    if (used + tokens > remainingBudget) break;
    lines.push(line);
    used += tokens;
  }
  return lines;
}

/**
 * Render tier 2 candidates as `<episode>` elements with staleness annotation.
 */
function renderEpisodesWithStaleness(
  items: TieredCandidate[],
  perItemBudgetTokens: number,
  remainingBudget: number,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used >= remainingBudget) break;
    const maxChars = perItemBudgetTokens * CHARS_PER_TOKEN;
    const text = escapeXmlTags(truncate(item.text, maxChars));
    const sourceAttr = buildSourceAttr(item);
    const stalenessAttr =
      item.staleness && item.staleness !== "fresh"
        ? ` staleness="${escapeXmlAttr(item.staleness)}"`
        : "";
    const line = `<episode${sourceAttr}${stalenessAttr}>\n${text}\n</episode>`;
    const tokens = estimateTextTokens(line);
    if (used + tokens > remainingBudget) break;
    lines.push(line);
    used += tokens;
  }
  return lines;
}

/**
 * Build the `source="..."` attribute for an episode tag.
 * Uses the candidate's sourceLabel (conversation title) if available,
 * combined with a short date from createdAt.
 */
function buildSourceAttr(item: TieredCandidate): string {
  const date = formatShortDate(item.createdAt);
  if (item.sourceLabel) {
    return ` source="${escapeXmlAttr(`${item.sourceLabel} (${date})`)}"`;
  }
  return ` source="${escapeXmlAttr(date)}"`;
}

function escapeXmlAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format epoch-ms as a short human-readable date like "Mar 7" or "Mar 7 2024".
 * Omits the year when the date is in the current year.
 */
function formatShortDate(epochMs: number): string {
  const date = new Date(epochMs);
  const now = new Date();
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[date.getMonth()];
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day} ${date.getFullYear()}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
