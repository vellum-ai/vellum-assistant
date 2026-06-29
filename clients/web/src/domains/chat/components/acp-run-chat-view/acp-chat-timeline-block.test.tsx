import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AcpChatTimelineBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-timeline-block";

describe("AcpChatTimelineBlock", () => {
  test("renders the timeline dot and the child content", () => {
    const html = renderToStaticMarkup(
      <AcpChatTimelineBlock isLast={false}>
        <span>BLOCK_CONTENT</span>
      </AcpChatTimelineBlock>,
    );
    expect(html).toContain("acp-chat-timeline-dot");
    expect(html).toContain("BLOCK_CONTENT");
  });

  test("draws a trailing connector and spacing for a non-last block", () => {
    const html = renderToStaticMarkup(
      <AcpChatTimelineBlock isLast={false}>x</AcpChatTimelineBlock>,
    );
    expect(html).toContain("bg-[var(--border-element)]");
    expect(html).toContain("pb-4");
  });

  test("omits the connector and trailing spacing on the last block", () => {
    const html = renderToStaticMarkup(
      <AcpChatTimelineBlock isLast={true}>x</AcpChatTimelineBlock>,
    );
    expect(html).not.toContain("bg-[var(--border-element)]");
    expect(html).not.toContain("pb-4");
  });
});
