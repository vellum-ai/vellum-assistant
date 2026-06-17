import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

describe("MessageHoverActions", () => {
  test("renders the timestamp even when no actions are available", () => {
    const message: DisplayMessage = {
      id: "m1",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody(""),
    };
    const html = renderToStaticMarkup(<MessageHoverActions message={message} />);

    expect(html).toContain("title=");
    expect(html).toContain("select-none");
  });

  test("renders inspect action for user messages when provided", () => {
    const message: DisplayMessage = {
      id: "m2",
      role: "user",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} onInspect={() => {}} />,
    );

    expect(html).toContain('title="Inspect"');
  });
});
