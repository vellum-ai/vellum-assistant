import type { ContentBlock } from "../providers/types.js";

type NestedContentBlock = ContentBlock & {
  contentBlocks?: ContentBlock[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapWorkspaceRefAttachmentId(
  block: ContentBlock,
  attachmentIdMap: ReadonlyMap<string, string>,
): ContentBlock {
  if (block.type === "image" || block.type === "file") {
    const source: unknown = block.source;
    if (
      !isRecord(source) ||
      source.type !== "workspace_ref" ||
      typeof source.attachmentId !== "string"
    ) {
      return block;
    }
    const attachmentId = attachmentIdMap.get(source.attachmentId);
    if (!attachmentId || attachmentId === source.attachmentId) {
      return block;
    }
    return {
      ...block,
      source: { ...source, attachmentId },
    } as ContentBlock;
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
