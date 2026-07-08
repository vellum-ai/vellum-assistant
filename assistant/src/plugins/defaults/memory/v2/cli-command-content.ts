/**
 * Render the prose-style capability statement embedded into the unified
 * `memory_v2_concept_pages` Qdrant collection (under the `cli-commands/<name>`
 * slug prefix). Mirrors `buildSkillContent` in shape — a short prose lead-in
 * followed by the dense capability material — so activation scoring weighs
 * both natural-language intent and structured help text.
 *
 * Intentionally uncapped: CLI `--help` output averages 1–2 KB and the longest
 * (browser, oauth) hits ~3.4 KB. The embedding backend handles inputs of this
 * size without trouble, and trimming would drop the very examples and flag
 * descriptions that make commands semantically findable.
 */
export function buildCliCommandContent(
  name: string,
  description: string,
  helpText: string,
): string {
  return `The "assistant ${name}" CLI command is available. ${description}.\n\nFull help:\n${helpText}`;
}
