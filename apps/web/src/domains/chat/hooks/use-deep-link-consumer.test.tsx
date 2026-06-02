import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

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

const renderConsumer = (
  composerInput: string,
  setComposerInput: (next: string) => void,
) =>
  renderHook(
    ({ input, set }: { input: string; set: (next: string) => void }) =>
      useDeepLinkConsumer({ composerInput: input, setComposerInput: set }),
    { initialProps: { input: composerInput, set: setComposerInput } },
  );

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  sentryBreadcrumbMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
});

describe("pending message consumption", () => {
  test("pre-fills the composer when a pending message exists and input is empty", () => {
    const setComposerInput = mock((_next: string) => undefined);
    // Stash a message before render — the consumer sees it on mount.
    usePendingDeepLinkStore.getState().setPendingComposerMessage("hello");

    renderConsumer("", setComposerInput);

    expect(setComposerInput).toHaveBeenCalledWith("hello");
    // Consumed → store is cleared.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });

  test("preserves in-progress typing — drops with a Sentry breadcrumb", () => {
    const setComposerInput = mock((_next: string) => undefined);
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerMessage("from link");

    renderConsumer("user already typing", setComposerInput);

    expect(setComposerInput).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    // Message is consumed (cleared) either way — we don't want it to
    // sit and resurface on the next render.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });

  test("whitespace-only composer input counts as empty", () => {
    const setComposerInput = mock((_next: string) => undefined);
    usePendingDeepLinkStore.getState().setPendingComposerMessage("hello");

    renderConsumer("   \n  ", setComposerInput);

    expect(setComposerInput).toHaveBeenCalledWith("hello");
  });

  test("no-op when no message is pending", () => {
    const setComposerInput = mock((_next: string) => undefined);

    renderConsumer("", setComposerInput);

    expect(setComposerInput).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
  });

  test("a pending message arriving after mount fires the effect on the next render", () => {
    const setComposerInput = mock((_next: string) => undefined);
    renderConsumer("", setComposerInput);
    expect(setComposerInput).not.toHaveBeenCalled();

    // Simulate the global consumer parking a message after the
    // chat page is already mounted. The Zustand atomic selector
    // re-renders the hook and the effect fires.
    act(() => {
      usePendingDeepLinkStore
        .getState()
        .setPendingComposerMessage("late arrival");
    });

    expect(setComposerInput).toHaveBeenCalledWith("late arrival");
  });
});
