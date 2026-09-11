/**
 * The SYSTEM_PROMPT_CACHE_BOUNDARY marker separates the system prompt's
 * cache blocks.  Placement is driven by the section pipeline: a section
 * carrying a cache-breakpoint declaration (bundled `cacheBreakpoint` field
 * or workspace frontmatter `cache_breakpoint: true`) ends a block, and
 * `buildSystemPrompt` joins the resulting blocks with this marker.
 *
 * The Anthropic provider splits on the marker and gives each block its own
 * `cache_control` breakpoint; other providers strip it (it is invisible
 * plain text either way).
 *
 * Kept in its own file so that providers (openai, gemini) can import it
 * without pulling in the full system-prompt module and its heavy transitive
 * dependencies, which would otherwise create a circular import cycle.
 */
export const SYSTEM_PROMPT_CACHE_BOUNDARY =
  "\n<!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->\n";

/**
 * The stable head of a system prompt: everything before its first cache
 * boundary, or the whole prompt when it carries none.
 */
function stableHead(prompt: string): string {
  const boundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  return boundary === -1 ? prompt : prompt.slice(0, boundary);
}

/**
 * Pick the system prompt a conversation sends this turn, given the prompt it
 * sent last (`current`) and a fresh rebuild from the workspace (`next`).
 *
 * A provider's prompt cache is prefix-based, and the system prompt is the
 * head of every request, so any byte that changes in it, in either block,
 * re-writes the whole conversation history behind it. On a long voice call
 * that is a six-figure token write to answer one utterance. The sections
 * behind the cache boundary (the first-run ritual, voice markers, connected
 * services) are the ones that change while a conversation is running, so a
 * rebuild that differs only there returns `current`: the conversation keeps
 * the suffix it started with for its whole life, and what changed on disk
 * reaches the next conversation. A change to the stable head (persona, trust
 * class, channel, the turn's tool surface) is deliberate and returns `next`,
 * refreshing the suffix with it.
 */
export function stabilizeSystemPrompt(current: string, next: string): string {
  if (current.length === 0 || next === current) {
    return next;
  }
  return stableHead(next) === stableHead(current) ? current : next;
}
