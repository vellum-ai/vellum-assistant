/**
 * `ThinkingDetailMarkdown` parses block by block only while its text streams
 * in live. Recorded text takes the full parse, the only one that resolves a
 * reference link or footnote defined in another paragraph.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

let liveText: string | null = null;

mock.module("@/domains/chat/hooks/use-live-thinking-text", () => ({
  useLiveThinkingText: () => liveText,
}));

// Reads back what the body was asked to render and how.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({
    content,
    incremental,
  }: {
    content: string;
    incremental?: boolean;
  }) => (
    <div data-testid="markdown" data-incremental={String(Boolean(incremental))}>
      {content}
    </div>
  ),
}));

import { ThinkingDetailMarkdown } from "@/domains/chat/components/thinking-detail-markdown";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  liveText = null;
});
afterAll(() => {
  mock.restore();
});

const RECORDED_TEXT = "See [the notes][1].\n\n[1]: https://example.com/notes";

const RECORDED: ToolDetailPayload = {
  toolCallId: "",
  toolName: "",
  title: "Thinking",
  activity: "",
  input: {},
  status: "completed",
  kind: "thinking",
  thinkingText: RECORDED_TEXT,
};

describe("ThinkingDetailMarkdown", () => {
  test("renders recorded text as one document", () => {
    render(<ThinkingDetailMarkdown detail={RECORDED} />);

    const body = screen.getByTestId("markdown");
    expect(body.getAttribute("data-incremental")).toBe("false");
    expect(body.textContent).toBe(RECORDED_TEXT);
  });

  test("renders live text block by block", () => {
    liveText = "Still thinking about the notes.";
    render(<ThinkingDetailMarkdown detail={RECORDED} />);

    const body = screen.getByTestId("markdown");
    expect(body.getAttribute("data-incremental")).toBe("true");
    expect(body.textContent).toBe("Still thinking about the notes.");
  });
});
