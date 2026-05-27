import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";

describe("MessageHoverActions", () => {
  test("renders the timestamp even when no actions are available", () => {
    const html = renderToStaticMarkup(
      <MessageHoverActions
        content=""
        timestamp={Date.UTC(2026, 0, 2, 12, 34)}
        role="assistant"
      />,
    );

    expect(html).toContain("title=");
    expect(html).toContain("select-none");
  });

  test("hides while the message is streaming", () => {
    const html = renderToStaticMarkup(
      <MessageHoverActions
        content=""
        timestamp={Date.UTC(2026, 0, 2, 12, 34)}
        role="assistant"
        isStreaming
      />,
    );

    expect(html).toBe("");
  });

  test("renders inspect action for user messages when provided", () => {
    const html = renderToStaticMarkup(
      <MessageHoverActions
        content="hello"
        timestamp={Date.UTC(2026, 0, 2, 12, 34)}
        role="user"
        onInspect={() => {}}
      />,
    );

    expect(html).toContain('title="Inspect"');
  });
});
