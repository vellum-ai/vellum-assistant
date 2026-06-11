/**
 * Static set of meta-query patterns that never need memory recall.
 * Matched case-insensitively against the trimmed user message.
 */

const META_QUERY_EXACT = new Set([
  "/help",
  "/status",
  "/version",
  "/info",
  "/settings",
  "/config",
  "/debug",
  "/reset",
  "/clear",
  "/undo",
  "/redo",
]);

const META_QUERY_PATTERNS: RegExp[] = [
  /^what model\b/i,
  /^which model\b/i,
  /^what (?:llm|ai|language model)\b/i,
  /^who are you\b/i,
  /^what are you\b/i,
  /^are you (?:gpt|claude|gemini|llama)\b/i,
  /^what(?:'s| is) your (?:name|version)\b/i,
  /^how do (?:i|you) (?:use|work)\b/i,
  /^what can you do\b/i,
  /^help$/i,
];

export function isMetaQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  if (META_QUERY_EXACT.has(trimmed.toLowerCase())) return true;

  return META_QUERY_PATTERNS.some((p) => p.test(trimmed));
}
