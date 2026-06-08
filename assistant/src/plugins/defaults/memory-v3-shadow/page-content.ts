import { readPage, renderPageContent } from "../../../memory/v2/page-store.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { renderCapabilityContent } from "./capabilities.js";
import type { Section, Slug } from "./types.js";

/**
 * Prefix `body` with the `# memory/concepts/<slug>.md` header marker the v3
 * `<memory>` block uses. Both the full-page and matched-section renderers emit
 * this exact marker, and the v2 stripper recognizes pages by it — so the two
 * call sites MUST stay byte-identical, which is why this lives in one place.
 */
function withConceptHeader(slug: Slug, body: string): string {
  return `# memory/concepts/${slug}.md\n${body}`;
}

/**
 * Render a selected page's full content for the v3 `<memory>` block. Mirrors
 * the v2 dynamic-memory layout (`# memory/concepts/<slug>.md\n<frontmatter+body>`)
 * so the working-set block reads like v2's. A missing page (or any read
 * failure) degrades to "" — `renderMemoryBlock` still emits a line for the
 * slug, and a blank section is preferable to throwing into the turn.
 *
 * Synthetic capability slugs (skills, `assistant` CLI commands) have no on-disk
 * page; they resolve through {@link renderCapabilityContent} instead of
 * `readPage`. A non-null result (including "") means the slug was a capability
 * slug and was handled here.
 *
 * Shared by the live injector (`shadow-plugin.ts`) and the inspector
 * selection-log store (`selection-log-store.ts`) so the inspector's rendered
 * block is byte-identical to what live injection produces.
 */
export async function renderV3PageContent(slug: Slug): Promise<string> {
  const capability = renderCapabilityContent(slug);
  if (capability !== null) return capability;
  try {
    const page = await readPage(getWorkspaceDir(), slug);
    if (!page) return "";
    const content = renderPageContent(page).trim();
    if (content.length === 0) return "";
    return withConceptHeader(slug, content);
  } catch {
    return "";
  }
}

/**
 * Render a slug's matched section for the v3 `<memory>` block (progressive
 * disclosure: inject only the section the lanes matched, not the full page).
 * Uses the same `# memory/concepts/<slug>.md` header marker as
 * {@link renderV3PageContent} so the block reads like v2's and the v2 stripper
 * recognizes it.
 *
 * - Capability slugs (skills, `assistant` CLI commands) have no on-disk
 *   section, so they always render their capability content via
 *   {@link renderCapabilityContent}, never a section.
 * - When `section` is undefined (e.g. a carry-forward page with no current
 *   match), fall back to {@link renderV3PageContent} (the full/lead page) so the
 *   slug still contributes content.
 */
export async function renderV3SectionContent(
  slug: Slug,
  section: Section | undefined,
): Promise<string> {
  const capability = renderCapabilityContent(slug);
  if (capability !== null) return capability;
  if (!section) return renderV3PageContent(slug);

  const text = section.text.trim();
  if (text.length === 0) return "";
  return withConceptHeader(slug, text);
}
