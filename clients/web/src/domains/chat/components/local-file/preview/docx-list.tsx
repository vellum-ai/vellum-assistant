import type { ReactNode } from "react";

import type { DocxBlock } from "@/domains/chat/components/local-file/preview/ooxml";
import { PreviewRuns } from "@/domains/chat/components/local-file/preview/preview-runs";

export type DocxListItem = Extract<DocxBlock, { type: "listItem" }>;

/** Indent added per nesting level, matching the base list padding. */
const LEVEL_INDENT_REM = 1.5;

interface DocxListProps {
  ordered: boolean;
  items: DocxListItem[];
}

/**
 * A run of consecutive Word list items. Nesting is approximated with a
 * per-item indent rather than nested lists, because Word expresses depth
 * as a numbering level on otherwise sibling paragraphs.
 */
export function DocxList({ ordered, items }: DocxListProps): ReactNode {
  const shared =
    "mb-3 pl-6 text-body-medium-lighter text-[var(--content-default)] last:mb-0";
  const listItems = items.map((item, index) => (
    <li
      key={index}
      className="mb-0.5"
      style={{ marginLeft: `${item.level * LEVEL_INDENT_REM}rem` }}
    >
      <PreviewRuns runs={item.runs} />
    </li>
  ));

  if (ordered) {
    return <ol className={`list-decimal ${shared}`}>{listItems}</ol>;
  }
  return <ul className={`list-disc ${shared}`}>{listItems}</ul>;
}
