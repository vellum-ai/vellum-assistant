import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

let canUseInternalThreadActions = false;
mock.module("@/lib/auth/internal-thread-actions", () => ({
  useCanUseInternalThreadActions: () => canUseInternalThreadActions,
}));

const { MessageHoverActions } = await import(
  "@/domains/chat/components/message-hover-actions/message-hover-actions"
);

afterEach(() => {
  canUseInternalThreadActions = false;
});

describe("MessageHoverActions", () => {
  test("renders the timestamp even when no actions are available", () => {
    const message: DisplayMessage = {
      id: "m1",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody(""),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain("title=");
    expect(html).toContain("select-none");
  });

  test("omits the copy action for a row deleted on its channel", () => {
    const message: DisplayMessage = {
      id: "m-deleted",
      role: "user",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("text the channel no longer shows"),
      deletedAt: 1725100001000,
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} onInspect={() => {}} />,
    );

    expect(html).not.toContain('title="Copy"');
    expect(html).not.toContain('title="Read aloud"');
    expect(html).toContain('title="Inspect"');
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

  test("renders summarize action when the callback is provided", () => {
    const message: DisplayMessage = {
      id: "m3",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} onSummarizeUpToHere={() => {}} />,
    );

    expect(html).toContain('title="Summarize up to here"');
  });

  test("omits summarize action when the callback is absent", () => {
    const message: DisplayMessage = {
      id: "m4",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).not.toContain('title="Summarize up to here"');
  });

  test("renders retry action when the callback is provided", () => {
    const message: DisplayMessage = {
      id: "m5",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} onRetry={() => {}} />,
    );

    expect(html).toContain('title="Retry"');
  });

  test("omits retry action when the callback is absent", () => {
    const message: DisplayMessage = {
      id: "m6",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).not.toContain('title="Retry"');
  });

  test("renders copy for a copyable message without read aloud when the internal gate is off", () => {
    const message: DisplayMessage = {
      id: "m7",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain('title="Copy"');
    expect(html).not.toContain('title="Read aloud"');
  });

  test("renders read aloud when the internal thread actions gate is on", () => {
    canUseInternalThreadActions = true;
    const message: DisplayMessage = {
      id: "m7-read",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain('title="Copy"');
    expect(html).toContain('title="Read aloud"');
  });

  test("omits copy and read aloud when the message has no text", () => {
    canUseInternalThreadActions = true;
    const message: DisplayMessage = {
      id: "m8",
      role: "assistant",
      timestamp: Date.UTC(2026, 0, 2, 12, 34),
      ...textBody(""),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).not.toContain('title="Copy"');
    expect(html).not.toContain('title="Read aloud"');
  });
});
