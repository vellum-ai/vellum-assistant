import { getWorkspaceDir } from "../../util/platform.js";
import { readPage, renderPageContent } from "../v2/page-store.js";
import type { Slug } from "./types.js";

/**
 * Render a selected page's full content for the v3 `<memory>` block. Mirrors
 * the v2 dynamic-memory layout (`# memory/concepts/<slug>.md\n<frontmatter+body>`)
 * so the working-set block reads like v2's. A missing page (or any read
 * failure) degrades to "" — `renderMemoryBlock` still emits a line for the
 * slug, and a blank section is preferable to throwing into the turn.
 *
 * Shared by the live injector (`shadow-plugin.ts`) and the inspector
 * selection-log store (`selection-log-store.ts`) so the inspector's rendered
 * block is byte-identical to what live injection produces.
 */
export async function renderV3PageContent(slug: Slug): Promise<string> {
  try {
    const page = await readPage(getWorkspaceDir(), slug);
    if (!page) return "";
    const content = renderPageContent(page).trim();
    if (content.length === 0) return "";
    return `# memory/concepts/${slug}.md\n${content}`;
  } catch {
    return "";
  }
}
