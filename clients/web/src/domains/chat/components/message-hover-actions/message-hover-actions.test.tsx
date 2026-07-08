import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Drive flag values via a module stub (never setState — SSR renders read
// the store through `use.*` selector hooks). `summarizeUpToHere` defaults
// ON so the presence-gating tests exercise the callback dimension; the
// flag-off test flips it.
const summarizeFlagRef = { value: true };

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    bookmarks: () => false,
    summarizeUpToHere: () => summarizeFlagRef.value,
  };
  return { useClientFeatureFlagStore: store };
});

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
    const html = renderToStaticMarkup(<MessageHoverActions message={message} />);

    expect(html).not.toContain('title="Summarize up to here"');
  });

  test("omits summarize action when the feature flag is off even with a callback", () => {
    summarizeFlagRef.value = false;
    try {
      const message: DisplayMessage = {
        id: "m5",
        role: "assistant",
        timestamp: Date.UTC(2026, 0, 2, 12, 34),
        ...textBody("hello"),
      };
      const html = renderToStaticMarkup(
        <MessageHoverActions
          message={message}
          onSummarizeUpToHere={() => {}}
        />,
      );

      expect(html).not.toContain('title="Summarize up to here"');
    } finally {
      summarizeFlagRef.value = true;
    }
  });
});
