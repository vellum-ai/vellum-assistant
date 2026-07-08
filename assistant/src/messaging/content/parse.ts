/**
 * Canonical markdown → mdast parsing for assistant replies.
 *
 * This is the channel-neutral "what": every channel adapter renders the same
 * mdast tree to its own native format. It uses the same remark/GFM parser the
 * web client renders markdown with (`unified` + `remark-parse` + `remark-gfm`),
 * so server-side channel rendering matches what users see in-app — and so we
 * never hand-roll a markdown scanner again.
 */

import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// `remark-gfm` registers its micromark + mdast extensions at `.use()` time, so
// `.parse()` produces GFM nodes (tables, strikethrough, autolinks, task lists).
const processor = unified().use(remarkParse).use(remarkGfm);

/** Parse markdown / plain text into a GFM mdast tree. */
export function parseMarkdown(text: string): Root {
  return processor.parse(text);
}
