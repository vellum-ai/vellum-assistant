import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useComposerStore } from "@/domains/chat/composer-store";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

const { useDeepLinkConsumer } = await import("./use-deep-link-consumer");

const renderConsumer = (composerInput: string) => {
  // Seed the composer store with the given input before rendering.
  useComposerStore.getState().setInput(composerInput);
  return renderHook(() => useDeepLinkConsumer());
};

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  useComposerStore.getState().fullReset();
  sentryBreadcrumbMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
  useComposerStore.getState().fullReset();
});

describe("pending message consumption", () => {
  test("pre-fills the composer when a pending message exists and input is empty", () => {
    // Stash a message before render — the consumer sees it on mount.
    usePendingDeepLinkStore.getState().setPendingComposerMessage("hello");

    renderConsumer("");

    expect(useComposerStore.getState().input).toBe("hello");
    // Consumed → store is cleared.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });

  test("preserves in-progress typing — drops with a Sentry breadcrumb", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerMessage("from link");

    renderConsumer("user already typing");

    expect(useComposerStore.getState().input).toBe("user already typing");
    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    // Message is consumed (cleared) either way — we don't want it to
    // sit and resurface on the next render.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });

  test("whitespace-only composer input counts as empty", () => {
    usePendingDeepLinkStore.getState().setPendingComposerMessage("hello");

    renderConsumer("   \n  ");

    expect(useComposerStore.getState().input).toBe("hello");
  });

  test("no-op when no message is pending", () => {
    renderConsumer("");

    expect(useComposerStore.getState().input).toBe("");
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
  });

  test("a pending message arriving after mount fires the effect on the next render", () => {
    renderConsumer("");
    expect(useComposerStore.getState().input).toBe("");

    // Simulate the global consumer parking a message after the
    // chat page is already mounted. The Zustand atomic selector
    // re-renders the hook and the effect fires.
    act(() => {
      usePendingDeepLinkStore
        .getState()
        .setPendingComposerMessage("late arrival");
    });

    expect(useComposerStore.getState().input).toBe("late arrival");
  });
});
