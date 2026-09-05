import { getWorkspaceDir } from "../paths.js";
import {
  escapeInjectedBody,
  injectedSectionHeader,
} from "../substrate/injected-block-slugs.js";
import { readPage } from "../substrate/page-store.js";
import { renderCapabilityContent } from "./capabilities.js";
import { leadSectionOfBody, sectionBody } from "./sections.js";
import { type Section, sectionKey, type Slug } from "./types.js";

/**
 * Render one section for the v3 frozen `<memory>` block: the section's path
 * header (`# memory/concepts/<slug>.md § <key>` for a heading section, the
 * bare `# memory/concepts/<slug>.md` for the lead) followed by the section
 * body. The body is the indexed section text without the synthetic
 * `<segment> — <title>` head line the section index prepends for lexical
 * matching; a lead body opens with the page's own `# Title` line, so the lead
 * reads like the page's head. The body passes through `escapeInjectedBody`,
 * so a line of page text can never read as an injected-block chunk boundary.
 * Returns `""` for a section with no body (the injector attaches nothing and
 * records nothing for it).
 *
 * Pure text → text: capability slugs never reach here (they render their
 * injection form via `renderCapabilityContent`), and the header is the exact
 * grammar the prune valve's section parser and the fork seed scan key on.
 */
export function renderV3SectionInjection(slug: Slug, section: Section): string {
  const body = sectionBody(section).trim();
  if (body.length === 0) {
    return "";
  }
  return `${injectedSectionHeader(slug, sectionKey(section))}\n${escapeInjectedBody(body)}`;
}

/**
 * The lead section (ordinal 0) of a concept page, built from the page on disk
 * by the same split rules as the lanes' section index so its text and key
 * match what a finder hit on that lead would carry. `undefined` when the page
 * is missing or unreadable. Capability slugs have no page and never resolve
 * here; callers route them through `renderCapabilityContent`.
 */
export async function leadSectionOf(slug: Slug): Promise<Section | undefined> {
  try {
    const page = await readPage(getWorkspaceDir(), slug);
    return page ? leadSectionOfBody(slug, page.body) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render one selected page's injection entry exactly as the live injector
 * attaches it: a capability slug renders its injection-form capability
 * content (its own `# Skill:` / `# CLI command:` header), a page with a
 * matched section renders that section, and a page selected without a match
 * renders its lead. `""` when nothing resolves (a deleted page, an
 * unresolvable capability, an empty section): the injector attaches and
 * records nothing for it, and the inspector shows nothing.
 */
export async function renderV3InjectionEntry(
  slug: Slug,
  section: Section | undefined,
): Promise<string> {
  const capability = renderCapabilityContent(slug);
  if (capability !== null) {
    return capability;
  }
  const resolved = section ?? (await leadSectionOf(slug));
  return resolved ? renderV3SectionInjection(slug, resolved) : "";
}
