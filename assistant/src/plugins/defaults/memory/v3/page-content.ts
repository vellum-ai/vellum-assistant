import { getWorkspaceDir } from "../../../../util/platform.js";
import { injectedConceptHeader } from "../v2/injected-block-slugs.js";
import { readPage, renderPageContent } from "../v2/page-store.js";
import { renderCapabilityContent } from "./capabilities.js";
import { renderCard } from "./card.js";
import type { Section, Slug } from "./types.js";

/**
 * Prefix `body` with the `# memory/concepts/<slug>.md` header marker the v3
 * `<memory>` block uses (shared builder: `injectedConceptHeader`, so the
 * renderers, the card renderer, and the read-side parsers all agree on the
 * exact bytes).
 */
function withConceptHeader(slug: Slug, body: string): string {
  return `${injectedConceptHeader(slug)}\n${body}`;
}

/**
 * Render a selected page's full content for the v3 `<memory>` block. Mirrors
 * the v2 dynamic-memory layout (`# memory/concepts/<slug>.md\n<frontmatter+body>`)
 * so the v3 block reads like v2's. A missing page (or any read
 * failure) degrades to "" — `renderMemoryBlock` still emits a line for the
 * slug, and a blank section is preferable to throwing into the turn.
 *
 * Synthetic capability slugs (skills, `assistant` CLI commands) have no on-disk
 * page; they resolve through {@link renderCapabilityContent} instead of
 * `readPage`. A non-null result (including "") means the slug was a capability
 * slug and was handled here.
 *
 * INSPECTOR-ONLY (as the `renderV3SectionContent` fallback): live injection
 * freezes compact CARDS into history via {@link renderV3CardContent} — it no
 * longer renders full pages, so this output is an APPROXIMATE reconstruction
 * for the inspector selection log (`selection-log-store.ts`), not what the
 * model saw.
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
 * Render a selected page's compact CARD for the v3 frozen-injection layer:
 * the `# memory/concepts/<slug>.md` header, the page's head section, and a
 * one-line section TOC (see `card.ts`). Cards are the persistent injection
 * unit — frozen into history once and deduped by the everInjected store.
 *
 * - Capability slugs (skills, `assistant` CLI commands) have no on-disk page
 *   and no meaningful head/TOC split, so they render their full capability
 *   content via {@link renderCapabilityContent} (its own `# Skill:` /
 *   `# CLI command:` header) instead of a card.
 * - A missing page or any read failure degrades to "" — the injector skips
 *   empty cards rather than throwing into the turn.
 */
export async function renderV3CardContent(slug: Slug): Promise<string> {
  const capability = renderCapabilityContent(slug);
  if (capability !== null) return capability;
  try {
    const page = await readPage(getWorkspaceDir(), slug);
    if (!page) return "";
    return renderCard(slug, renderPageContent(page));
  } catch {
    return "";
  }
}

/**
 * Render a slug's matched section under the `# memory/concepts/<slug>.md`
 * header marker, the same marker as {@link renderV3PageContent}.
 *
 * INSPECTOR-ONLY: live injection freezes cards ({@link renderV3CardContent})
 * and re-renders the ephemeral spotlight separately; this per-section render
 * remains for the inspector selection log (`selection-log-store.ts`), which
 * reconstructs an approximate view of a turn's selection after the fact.
 *
 * - Capability slugs (skills, `assistant` CLI commands) have no on-disk
 *   section, so they always render their capability content via
 *   {@link renderCapabilityContent}, never a section.
 * - When `section` is undefined (e.g. an edge-only or stable-prefix page with
 *   no current match), fall back to {@link renderV3PageContent} (the full/lead
 *   page) so the slug still contributes content.
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
