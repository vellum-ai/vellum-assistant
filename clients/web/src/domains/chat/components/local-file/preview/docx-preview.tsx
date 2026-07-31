/**
 * Read-only preview of a Word document, rendered from content extracted in the
 * browser by `parseDocx`. Meant to sit inside a scrollable host: this component
 * lays out a plain block flow and never scrolls itself.
 */

import { Fragment, type ReactNode } from "react";

import {
  Typography,
  type TypographyAs,
  type TypographyVariant,
} from "@vellumai/design-library";

import {
  DocxList,
  type DocxListItem,
} from "@/domains/chat/components/local-file/preview/docx-list";
import { DocxTable } from "@/domains/chat/components/local-file/preview/docx-table";
import type { DocxBlock } from "@/domains/chat/components/local-file/preview/ooxml";
import { parseDocx } from "@/domains/chat/components/local-file/preview/ooxml";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewRuns } from "@/domains/chat/components/local-file/preview/preview-runs";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useOoxmlParse } from "@/domains/chat/components/local-file/preview/use-ooxml-parse";

/** Consecutive list items collapse into one list; every other block stands alone. */
type DocxRenderItem =
  | { kind: "block"; block: DocxBlock }
  | { kind: "list"; ordered: boolean; items: DocxListItem[] };

const HEADING_TAGS: readonly TypographyAs[] = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];

export interface DocxPreviewProps {
  blob: Blob;
  filename: string;
}

function headingTag(level: number): TypographyAs {
  return HEADING_TAGS[Math.min(Math.max(level, 1), 6) - 1] ?? "h3";
}

function headingVariant(level: number): TypographyVariant {
  if (level <= 1) {
    return "title-large";
  }
  if (level === 2) {
    return "title-medium";
  }
  if (level === 3) {
    return "title-small";
  }
  return "body-medium-default";
}

function groupBlocks(blocks: DocxBlock[]): DocxRenderItem[] {
  const items: DocxRenderItem[] = [];
  for (const block of blocks) {
    if (block.type !== "listItem") {
      items.push({ kind: "block", block });
      continue;
    }
    const previous = items[items.length - 1];
    if (
      previous !== undefined &&
      previous.kind === "list" &&
      previous.ordered === block.ordered
    ) {
      previous.items.push(block);
      continue;
    }
    items.push({ kind: "list", ordered: block.ordered, items: [block] });
  }
  return items;
}

function renderBlock(
  block: DocxBlock,
  mediaUrls: Map<string, string>,
): ReactNode {
  switch (block.type) {
    case "heading":
      return (
        <Typography
          as={headingTag(block.level)}
          variant={headingVariant(block.level)}
          className="mb-2 mt-4 text-[var(--content-default)] first:mt-0"
        >
          <PreviewRuns runs={block.runs} />
        </Typography>
      );
    case "paragraph":
      // Runs keep the tabs and line breaks Word encoded inside the paragraph.
      return (
        <p className="mb-3 whitespace-pre-wrap text-body-medium-lighter text-[var(--content-default)] last:mb-0">
          <PreviewRuns runs={block.runs} />
        </p>
      );
    case "table":
      return <DocxTable rows={block.rows} />;
    case "image": {
      const url = mediaUrls.get(block.mediaPath);
      if (url === undefined) {
        return null;
      }
      return <img src={url} alt="" className="mb-3 max-w-full rounded" />;
    }
    case "listItem":
      return <DocxList ordered={block.ordered} items={[block]} />;
  }
}

export function DocxPreview({ blob, filename }: DocxPreviewProps): ReactNode {
  const state = useOoxmlParse(blob, parseDocx);

  if (state.status === "loading") {
    return <PreviewSkeleton />;
  }
  if (state.status === "error") {
    return <PreviewError filename={filename} />;
  }
  if (state.content.blocks.length === 0) {
    return (
      <p className="p-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        This document has no readable content.
      </p>
    );
  }

  return (
    <div className="px-1 py-2">
      {groupBlocks(state.content.blocks).map((item, index) => (
        <Fragment key={index}>
          {item.kind === "list" ? (
            <DocxList ordered={item.ordered} items={item.items} />
          ) : (
            renderBlock(item.block, state.mediaUrls)
          )}
        </Fragment>
      ))}
    </div>
  );
}
