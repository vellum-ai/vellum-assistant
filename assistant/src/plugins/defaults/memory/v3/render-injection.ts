import { injectedSectionPath } from "../substrate/injected-block-slugs.js";
import { SKILLS_INJECTION_CATALOG_HINT } from "../substrate/skill-content.js";
import { SKILL_HEADER_PREFIX } from "./capabilities.js";
import type { SectionRef } from "./types.js";

/** Header line of the skills catalog hint chunk. Its own `# ` chunk so the
 *  prune valve's section parser treats the hint as a non-section piece. */
export const SKILLS_CATALOG_HINT_HEADER = "# Skills";

const SKILLS_CATALOG_HINT_CHUNK = `${SKILLS_CATALOG_HINT_HEADER}\n${SKILLS_INJECTION_CATALOG_HINT}`;

/**
 * Leading instruction line of the frozen `<memory>` block, byte-identical to
 * v2's `INJECTION_HEADER` (`memory/v2/injection.ts`) so the read affordance
 * the model already knows applies unchanged: every injected section carries a
 * `# memory/concepts/<slug>.md` path header it can `file_read`.
 */
export const V3_INJECTION_HEADER =
  'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.';

/**
 * Render the UNWRAPPED inner text of a frozen net-new injection block: the
 * v2-style instruction header followed by the rendered entries (sections and
 * capability content), blank-line separated. Returns `""` for an empty entry
 * list (the injector attaches no block and the caller persists nothing). The
 * caller wraps the result via `wrapMemoryBlock` exactly once at injection
 * time and persists the unwrapped form to message metadata, the same
 * wrap-on-use contract as v2's `memoryInjectedBlock`.
 */
export function renderInjectionBlockInner(entries: string[]): string {
  if (entries.length === 0) {
    return "";
  }
  const parts = [V3_INJECTION_HEADER];
  if (entries.some((entry) => entry.startsWith(SKILL_HEADER_PREFIX))) {
    parts.push(SKILLS_CATALOG_HINT_CHUNK);
  }
  parts.push(...entries);
  return parts.join("\n\n");
}

/** Opening line of the pointer block, telling the model what the listed paths
 *  are: sections that already sit in the frozen `<memory>` blocks above. */
export const MEMORY_POINTER_LEAD_LINE =
  "Already in context above, relevant again this turn:";

/**
 * Render the UNWRAPPED inner text of the ephemeral `<memory_pointer>` block:
 * the lead line plus one `memory/concepts/<slug>.md § <key>` line per
 * resident section (a lead entry is the bare path), in selection order. No
 * bodies: the sections themselves ride the frozen blocks earlier in history.
 * Returns `""` for an empty list (the injector attaches no block). The caller
 * wraps via `wrapMemoryPointerBlock`.
 */
export function renderPointerInner(entries: SectionRef[]): string {
  if (entries.length === 0) {
    return "";
  }
  return [
    MEMORY_POINTER_LEAD_LINE,
    ...entries.map((entry) => injectedSectionPath(entry.slug, entry.key)),
  ].join("\n");
}
