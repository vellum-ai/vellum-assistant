import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

/**
 * The day portion the component renders for an epoch, computed with its own
 * `Intl` options so assertions hold in any locale. Only the choice of epoch
 * is under test.
 */
function renderedDay(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

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

  test("dates a Slack row from its origin ts, not the row's write time", () => {
    const sentAt = Date.UTC(2026, 6, 8, 9, 15);
    const message: DisplayMessage = {
      id: "m-backfilled",
      role: "user",
      timestamp: Date.UTC(2026, 7, 20, 12, 32),
      slackMessage: {
        channelId: "D0BFXBJE1QV",
        channelTs: String(sentAt / 1000),
      },
      ...textBody("older message"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain(renderedDay(sentAt));
    expect(html).not.toContain("Today");
  });

  test("falls back to the row's own timestamp when no Slack ts is present", () => {
    const rowWrittenAt = Date.UTC(2026, 6, 8, 9, 15);
    const message: DisplayMessage = {
      id: "m-plain",
      role: "user",
      timestamp: rowWrittenAt,
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain(renderedDay(rowWrittenAt));
  });

  test("dates a reaction from its arrival, not the message it reacts to", () => {
    // A reaction row carries the reacted message's ts in `channelTs`, not
    // its own arrival.
    const reactedAt = Date.UTC(2026, 6, 8, 9, 15);
    const reactedTs = String(reactedAt / 1000);
    const message: DisplayMessage = {
      id: "m-reaction",
      role: "user",
      timestamp: Date.UTC(2026, 7, 20, 12, 32),
      slackMessage: {
        channelId: "D0BFXBJE1QV",
        channelTs: reactedTs,
        eventKind: "reaction",
        reaction: { emoji: "eyes", op: "added", targetChannelTs: reactedTs },
      },
      ...textBody("[reaction]"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).not.toContain(renderedDay(reactedAt));
  });

  test("ignores a malformed Slack ts rather than inventing an origin time", () => {
    // `parseFloat` accepts a numeric prefix, so a partial parse would render
    // a fabricated date instead of falling back to the row's own timestamp.
    const rowWrittenAt = Date.UTC(2026, 7, 20, 12, 32);
    const message: DisplayMessage = {
      id: "m-malformed",
      role: "user",
      timestamp: rowWrittenAt,
      slackMessage: {
        channelId: "D0BFXBJE1QV",
        channelTs: "1783514100.123junk",
      },
      ...textBody("older message"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain(renderedDay(rowWrittenAt));
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
});
