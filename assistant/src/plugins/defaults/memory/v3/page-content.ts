import { getWorkspaceDir } from "../paths.js";
import {
  escapeInjectedBody,
  injectedSectionHeader,
} from "../substrate/injected-block-slugs.js";
import { readPage } from "../substrate/page-store.js";
import type { ConceptPage } from "../substrate/types.js";
import { renderCapabilityContent } from "./capabilities.js";
import { renderCurrentLine } from "./card.js";
import { leadSectionOfBody, sectionBody } from "./sections.js";
import { type Section, sectionKey, type Slug } from "./types.js";

/**
 * Render one section for the v3 frozen `<memory>` block: the section's path
 * header (`# memory/concepts/<slug>.md § <key>` for a heading section, the
 * bare `# memory/concepts/<slug>.md` for the lead), for a lead the page's
 * `[current: …]` annotation when `frontmatter` carries one (directly under
 * the header, where the selector card shows it, so the live state that made
 * the page relevant reaches the model), then the section body. The body is
 * the indexed section text without the synthetic `<segment> - <title>` head
 * line the section index prepends for lexical matching; a lead body opens
 * with the page's own `# Title` line, so the lead reads like the page's head.
 * The body passes through `escapeInjectedBody`, so a line of page text can
 * never read as an injected-block chunk boundary. Returns `""` for a section
 * with neither body nor annotation (the injector attaches nothing and
 * records nothing for it).
 *
 * Pure text → text: capability slugs never reach here (they render their
 * injection form via `renderCapabilityContent`), and the header is the exact
 * grammar the prune valve's section parser and the fork seed scan key on.
 */
export function renderV3SectionInjection(
  slug: Slug,
  section: Section,
  frontmatter?: ConceptPage["frontmatter"],
): string {
  const lines = [injectedSectionHeader(slug, sectionKey(section))];
  if (section.title.length === 0 && frontmatter) {
    const current = renderCurrentLine(frontmatter);
    if (current !== null) {
      lines.push(current);
    }
  }
  const body = sectionBody(section).trim();
  if (body.length > 0) {
    lines.push(escapeInjectedBody(body));
  }
  return lines.length === 1 ? "" : lines.join("\n");
}

/** The concept page on disk, or `null` when it is missing or unreadable:
 *  the one disk read behind {@link renderV3InjectionEntry}, so tests with an
 *  in-memory corpus stub this seam alone. Capability slugs have no page and
 *  never resolve here. */
export async function readConceptPage(slug: Slug): Promise<ConceptPage | null> {
  try {
    return await readPage(getWorkspaceDir(), slug);
  } catch {
    return null;
  }
}

/**
 * Render one selected page's injection entry exactly as the live injector
 * attaches it: a capability slug renders its injection-form capability
 * content (its own `# Skill:` / `# CLI command:` header), a page with a
 * matched heading section renders that section, and a page whose injection
 * unit is its lead (selected without a match, or matched on the lead itself)
 * renders the lead with the page's `[current: …]` annotation, the lead built
 * from the page on disk by the same split rules as the lanes' section index
 * when no matched section supplies it. `""` when nothing resolves (a deleted
 * page, an unresolvable capability, an empty section): the injector attaches
 * and records nothing for it, and the inspector shows nothing.
 */
export async function renderV3InjectionEntry(
  slug: Slug,
  section: Section | undefined,
): Promise<string> {
  const capability = renderCapabilityContent(slug);
  if (capability !== null) {
    return capability;
  }
  if (section && section.title.length > 0) {
    return renderV3SectionInjection(slug, section);
  }
  const page = await readConceptPage(slug);
  const lead =
    section ?? (page ? leadSectionOfBody(slug, page.body) : undefined);
  return lead ? renderV3SectionInjection(slug, lead, page?.frontmatter) : "";
}
