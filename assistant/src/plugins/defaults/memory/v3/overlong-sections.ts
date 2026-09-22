import { getPageIndex } from "../substrate/page-index.js";
import { readPage } from "../substrate/page-store.js";
import type {
  OverlongSection,
  OverlongSectionsReport,
} from "../substrate/prompts/consolidation.js";
import { isCapabilitySlug } from "./capabilities.js";
import {
  rawSectionChunkCount,
  SECTION_CHUNK_CHARS,
  sectionHeadLine,
  splitIntoRawSections,
} from "./sections.js";
import type { Slug } from "./types.js";

/** Inputs for {@link listOverlongSections}, injectable for tests. */
export interface OverlongSectionsDeps {
  /** Concept-page slugs to scan. */
  listSlugs: () => Promise<Slug[]>;
  /** A page's frontmatter-stripped body; a missing or failed read reads as "". */
  readPageBody: (slug: Slug) => Promise<string>;
}

function defaultDeps(workspaceDir: string): OverlongSectionsDeps {
  return {
    // Capability rows (skills, CLI commands) render from their catalog
    // entries, not from pages, so there is nothing on disk to split.
    listSlugs: async () =>
      (await getPageIndex(workspaceDir)).entries
        .map((entry) => entry.slug)
        .filter((slug) => !isCapabilitySlug(slug)),
    readPageBody: async (slug) => {
      try {
        const page = await readPage(workspaceDir, slug);
        return page?.body ?? "";
      } catch {
        return "";
      }
    },
  };
}

/**
 * Every concept-page section the section chunker splits, for the
 * consolidation prompt's over-long-sections repair step. A section (or lead)
 * whose text exceeds `SECTION_CHUNK_CHARS` with its head line is indexed and
 * injected as separate chunks, and the only lasting fix is the page itself.
 * The scan applies the same split the section index applies, so the list is
 * exactly the set of headings that carry `~<n>` chunk keys.
 */
export async function listOverlongSections(
  workspaceDir: string,
  deps: OverlongSectionsDeps = defaultDeps(workspaceDir),
): Promise<OverlongSectionsReport> {
  const sections: OverlongSection[] = [];
  for (const slug of await deps.listSlugs()) {
    const body = await deps.readPageBody(slug);
    const raws = splitIntoRawSections(body);
    // A title that repeats on its page is told apart by occurrence, as the
    // section index keys it (`title#<n>`), the first included, so the agent
    // edits the right one.
    const totals = new Map<string, number>();
    for (const raw of raws) {
      totals.set(raw.title, (totals.get(raw.title) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const raw of raws) {
      const occurrence = seen.get(raw.title) ?? 0;
      seen.set(raw.title, occurrence + 1);
      if (rawSectionChunkCount(slug, raw) > 1) {
        sections.push({
          slug,
          title: raw.title,
          // The size the window applies to: the head line, a newline, and
          // the body.
          chars: sectionHeadLine(slug, raw.title).length + 1 + raw.body.length,
          ...((totals.get(raw.title) ?? 0) > 1 ? { occurrence } : {}),
        });
      }
    }
  }
  return { windowChars: SECTION_CHUNK_CHARS, sections };
}
