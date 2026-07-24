import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../providers/types.js";
import { remapWorkspaceRefAttachmentIds } from "./media-reference-content.js";

function referencedImage(attachmentId: string): ContentBlock {
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: "image/png",
      attachmentId,
      sizeBytes: 10,
    },
  };
}

describe("remapWorkspaceRefAttachmentIds", () => {
  test("remaps root and nested references while preserving unknown fields", () => {
    const root = {
      ...referencedImage("source-root"),
      customBlockField: true,
    } as unknown as ContentBlock;
    const nestedTool = {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "generated image",
      customToolField: "kept",
      contentBlocks: [referencedImage("source-tool")],
    } as unknown as ContentBlock;
    const nestedWebSearch = {
      type: "web_search_tool_result",
      tool_use_id: "search-1",
      content: [],
      customSearchField: "kept",
      contentBlocks: [referencedImage("source-search")],
    } as unknown as ContentBlock;
    const content = [root, nestedTool, nestedWebSearch];

    const remapped = remapWorkspaceRefAttachmentIds(
      content,
      new Map([
        ["source-root", "fork-root"],
        ["source-tool", "fork-tool"],
        ["source-search", "fork-search"],
      ]),
    );

    expect(remapped).not.toBe(content);
    expect(JSON.stringify(remapped)).not.toContain("source-");
    expect(JSON.stringify(remapped)).toContain("fork-root");
    expect(JSON.stringify(remapped)).toContain("fork-tool");
    expect(JSON.stringify(remapped)).toContain("fork-search");
    expect(
      (remapped[0] as unknown as Record<string, unknown>).customBlockField,
    ).toBe(true);
    expect(
      (remapped[1] as unknown as Record<string, unknown>).customToolField,
    ).toBe("kept");
    expect(
      (remapped[2] as unknown as Record<string, unknown>).customSearchField,
    ).toBe("kept");
    expect(content[0]).toBe(root);
    expect(JSON.stringify(content)).toContain("source-root");
  });

  test("preserves array and block identity when no reference changes", () => {
    const content = [referencedImage("source-root")];

    const remapped = remapWorkspaceRefAttachmentIds(
      content,
      new Map([["different-source", "fork-root"]]),
    );

    expect(remapped).toBe(content);
    expect(remapped[0]).toBe(content[0]);
  });

  test("preserves malformed root and nested media blocks by identity", () => {
    const malformedBlocks = [
      { type: "image" },
      { type: "file", source: null },
      { type: "image", source: "workspace_ref" },
      { type: "file", source: { type: "workspace_ref" } },
      {
        type: "image",
        source: { type: "workspace_ref", attachmentId: 42 },
      },
    ] as unknown as ContentBlock[];
    const nestedTool = {
      type: "tool_result",
      tool_use_id: "tool-malformed",
      content: "historical media",
      contentBlocks: malformedBlocks,
    } as unknown as ContentBlock;
    const content = [...malformedBlocks, nestedTool];

    const remapped = remapWorkspaceRefAttachmentIds(
      content,
      new Map([["source-attachment", "fork-attachment"]]),
    );

    expect(remapped).toBe(content);
    for (const [index, block] of remapped.entries()) {
      expect(block).toBe(content[index]);
    }
    expect(
      (remapped.at(-1) as unknown as { contentBlocks?: ContentBlock[] })
        .contentBlocks,
    ).toBe(malformedBlocks);
  });
});
