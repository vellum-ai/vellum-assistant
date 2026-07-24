import type { ContentBlock } from "../providers/types.js";

type NestedContentBlock = ContentBlock & {
  contentBlocks?: ContentBlock[];
};

function remapWorkspaceRefAttachmentId(
  block: ContentBlock,
  attachmentIdMap: ReadonlyMap<string, string>,
): ContentBlock {
  if (
    (block.type === "image" || block.type === "file") &&
    block.source.type === "workspace_ref"
  ) {
    const attachmentId = attachmentIdMap.get(block.source.attachmentId);
    if (!attachmentId || attachmentId === block.source.attachmentId) {
      return block;
    }
    return {
      ...block,
      source: { ...block.source, attachmentId },
    };
  }

  if (block.type !== "tool_result" && block.type !== "web_search_tool_result") {
    return block;
  }
  const nestedBlock = block as NestedContentBlock;
  if (!Array.isArray(nestedBlock.contentBlocks)) {
    return block;
  }
  const contentBlocks = remapWorkspaceRefAttachmentIds(
    nestedBlock.contentBlocks,
    attachmentIdMap,
  );
  return contentBlocks === nestedBlock.contentBlocks
    ? block
    : ({ ...block, contentBlocks } as ContentBlock);
}

export function remapWorkspaceRefAttachmentIds(
  content: ContentBlock[],
  attachmentIdMap: ReadonlyMap<string, string>,
): ContentBlock[] {
  if (attachmentIdMap.size === 0) {
    return content;
  }
  let remapped: ContentBlock[] | null = null;
  for (const [index, block] of content.entries()) {
    const nextBlock = remapWorkspaceRefAttachmentId(block, attachmentIdMap);
    if (!remapped && nextBlock !== block) {
      remapped = content.slice(0, index);
    }
    remapped?.push(nextBlock);
  }
  return remapped ?? content;
}
