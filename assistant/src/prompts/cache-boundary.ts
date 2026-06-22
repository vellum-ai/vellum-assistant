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
