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
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    expect(html).toContain("title=");
    expect(html).toContain("select-none");
  });

  test("dates a Slack row from its origin ts, not the row's write time", () => {
    // A backfilled row is written when the import runs, so `timestamp` is
    // today while the message itself is weeks old. The tooltip must follow
    // the Slack ts or old history reads as having just arrived.
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

    // Computed with the component's own options so the assertion holds in
    // any locale; only the source of the epoch is under test.
    const expectedDay = new Date(sentAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(html).toContain(expectedDay);
    expect(html).not.toContain("Today");
  });

  test("falls back to the row's own timestamp when no Slack ts is present", () => {
    const message: DisplayMessage = {
      id: "m-plain",
      role: "user",
      timestamp: Date.UTC(2026, 6, 8, 9, 15),
      ...textBody("hello"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    const expectedDay = new Date(
      Date.UTC(2026, 6, 8, 9, 15),
    ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(html).toContain(expectedDay);
  });

  test("dates a reaction from its arrival, not the message it reacts to", () => {
    // A reaction row carries the reacted message's ts in `channelTs`, so
    // reading it would date a reaction added today by a six-week-old message.
    const message: DisplayMessage = {
      id: "m-reaction",
      role: "user",
      timestamp: Date.UTC(2026, 7, 20, 12, 32),
      slackMessage: {
        channelId: "D0BFXBJE1QV",
        channelTs: String(Date.UTC(2026, 6, 8, 9, 15) / 1000),
        eventKind: "reaction",
        reaction: {
          emoji: "eyes",
          op: "added",
          targetChannelTs: String(Date.UTC(2026, 6, 8, 9, 15) / 1000),
        },
      },
      ...textBody("[reaction]"),
    };
    const html = renderToStaticMarkup(
      <MessageHoverActions message={message} />,
    );

    const reactedDay = new Date(Date.UTC(2026, 6, 8, 9, 15)).toLocaleDateString(
      undefined,
      { month: "short", day: "numeric" },
    );
    expect(html).not.toContain(reactedDay);
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

    const expectedDay = new Date(rowWrittenAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(html).toContain(expectedDay);
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
