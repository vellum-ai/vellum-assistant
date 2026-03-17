/**
 * The SYSTEM_PROMPT_CACHE_BOUNDARY marker is a lightweight constant kept in its
 * own file so that providers (openai, gemini) can import it without pulling in
 * the full system-prompt module and its heavy transitive dependencies, which
 * would otherwise create a circular import cycle.
 */
export const SYSTEM_PROMPT_CACHE_BOUNDARY =
  "\n<!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->\n";
