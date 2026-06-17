/**
 * Best-effort parser for the daemon's `tool_result.result` string when a
 * web_search tool's structured `activityMetadata` is unavailable.
 *
 * Used by `useToolCallCardData` as a fallback for reloaded conversations
 * — the daemon doesn't persist `activityMetadata` per its v1 scope, so
 * after a page reload only the legacy `result: string` text dump survives.
 * Parsing it lets us reconstruct minimal `{ title, url, domain }` chips for
 * the web-search step row instead of rendering "0 links".
 *
 * Format coverage:
 *   - **Anthropic-native** (most common — see
 *     `assistant/src/daemon/conversation-agent-loop-handlers.ts`'s
 *     `web_search_tool_result` handler) emits `Title\nURL` pairs joined by
 *     `\n\n`. Trivial to parse.
 *   - **Brave / Tavily** emit a header line (`Web search results for "q":`)
 *     followed by numbered chunks like `1. Title\n   URL: <url>\n   ...`.
 *     We strip the `URL: ` prefix and treat the line above the URL as the
 *     title.
 *   - **Perplexity** emits prose plus a `Sources:` block with `[N] <url>`
 *     citations — no per-citation title. We extract those URLs with an
 *     empty-string title so the step row still surfaces favicons + domains.
 *
 * Intentionally heuristic — we don't recover snippets, durations, providers,
 * or per-result favicon URLs (the consumer derives faviconUrl from domain
 * downstream). Returns `[]` when no URLs are found.
 */

import type { WebSearchResultItem } from "@/assistant/web-activity-types";

const URL_PATTERN = /^https?:\/\/\S+/;
const URL_PREFIX_BRAVE_TAVILY = /^URL:\s*(https?:\/\/\S+)/i;
const URL_PREFIX_PERPLEXITY = /^\[\d+\]\s*(https?:\/\/\S+)/;

/**
 * Extract the bare hostname from a URL. Mirrors `extractDomain` in the
 * daemon (`web-search.ts`) — strips a leading `www.` so favicon caches and
 * de-dup logic line up regardless of the canonicalisation upstream.
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Strip provider-specific prefixes off a candidate URL line. The Brave /
 * Tavily formatters indent and prefix with `URL:` (e.g. `   URL: https://x`).
 * Perplexity's `Sources:` block prefixes citations with `[1] https://x`.
 */
function stripUrlPrefix(line: string): string {
  const trimmed = line.trim();
  return (
    URL_PREFIX_BRAVE_TAVILY.exec(trimmed)?.[1] ??
    URL_PREFIX_PERPLEXITY.exec(trimmed)?.[1] ??
    trimmed
  );
}

/**
 * Trim Brave-style numbered prefixes ("1. ", "2. ") off a candidate title
 * line so the displayed chip reads as a natural page title.
 */
function stripTitlePrefix(line: string): string {
  return line.trim().replace(/^\d+\.\s+/, "");
}

interface ParsedPair {
  title: string;
  url: string;
}

/**
 * Walk lines top-down. Each time we see a URL line, take the most recent
 * preceding non-empty, non-URL line as its title. This handles all three
 * documented formats without per-provider branching:
 *
 *   - Anthropic-native: `Title\nURL` → title is the immediately preceding
 *     line.
 *   - Brave / Tavily: `1. Title\n   URL: <url>` → title is the previous
 *     numbered line; description lines following the URL aren't picked up
 *     as titles because they appear AFTER the URL in their chunk.
 *   - Perplexity: `[1] <url>` → title is empty (no prior line is a clean
 *     candidate within the same citation block; consumer renders the
 *     domain as a fallback chip label).
 *
 * Drops the "Web search results for ..." header (it's not a result title).
 * Dedupes URLs — providers occasionally repeat a citation across the prose
 * body and the Sources block.
 */
function collectPairs(text: string): ParsedPair[] {
  const lines = text.split(/\r?\n/);
  const pairs: ParsedPair[] = [];
  const seenUrls = new Set<string>();
  let pendingTitle = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      // Blank line clears the pending title so titles don't bleed across
      // result chunks in Anthropic-native output.
      pendingTitle = "";
      continue;
    }

    const candidateUrl = stripUrlPrefix(line);
    if (URL_PATTERN.test(candidateUrl)) {
      if (!seenUrls.has(candidateUrl)) {
        seenUrls.add(candidateUrl);
        pairs.push({ title: pendingTitle, url: candidateUrl });
      }
      // Whether we kept the URL or dropped it as a dup, clear the pending
      // title — the URL consumed it.
      pendingTitle = "";
      continue;
    }

    // Header line for Brave / Tavily ("Web search results for ...:") — skip.
    if (/^Web search results for /i.test(line)) continue;
    // Perplexity "Sources:" header — skip.
    if (/^Sources:?$/i.test(line)) continue;

    pendingTitle = stripTitlePrefix(line);
  }

  return pairs;
}

/**
 * Public entry point — converts a `tool_result.result` text dump into a
 * minimal `WebSearchResultItem[]`. Returns `[]` for empty/whitespace input
 * or any text that contains no URLs.
 */
export function parseWebSearchResultText(
  text: string | undefined,
): WebSearchResultItem[] {
  if (!text || !text.trim()) return [];

  return collectPairs(text).map((pair, idx) => {
    const domain = extractDomain(pair.url);
    return {
      rank: idx + 1,
      title: pair.title,
      url: pair.url,
      domain,
      // No faviconUrl — the ToolStepPill falls back to a monogram derived
      // from the domain when this is omitted.
    };
  });
}
