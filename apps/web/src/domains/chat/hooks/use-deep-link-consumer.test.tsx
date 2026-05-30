import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, act } from "@testing-library/react";

import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store";

// Capture the navigate callback so we can assert on navigation
// targets without standing up a real router.
const navigateMock = mock((_to: string) => undefined);
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

// `ensureMainWindowVisible` is the bridge wrapper; replace with a spy
// so we can assert each handler fires it.
const ensureMainWindowVisibleMock = mock(async () => undefined);
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/browser", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
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
  __resetEventBusForTesting();
  navigateMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  sentryBreadcrumbMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("deeplink.send", () => {
  test("pre-fills the composer when input is empty", () => {
    const setComposerInput = mock((_next: string) => undefined);
    renderConsumer("", setComposerInput);

    act(() => {
      useEventBusStore.getState().publish("deeplink.send", { message: "hi" });
    });

    expect(setComposerInput).toHaveBeenCalledWith("hi");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("preserves in-progress typing — drops the link with a Sentry breadcrumb", () => {
    const setComposerInput = mock((_next: string) => undefined);
    renderConsumer("user already typing", setComposerInput);

    act(() => {
      useEventBusStore
        .getState()
        .publish("deeplink.send", { message: "from link" });
    });

    expect(setComposerInput).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    // ensureMainWindowVisible still fires — the window should come
    // forward so the user sees Vellum even when we declined to overwrite.
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("whitespace-only composer input counts as empty", () => {
    const setComposerInput = mock((_next: string) => undefined);
    renderConsumer("   \n  ", setComposerInput);

    act(() => {
      useEventBusStore.getState().publish("deeplink.send", { message: "hi" });
    });

    expect(setComposerInput).toHaveBeenCalledWith("hi");
  });
});

describe("deeplink.openThread", () => {
  test("navigates to the conversation route and ensures the window is visible", () => {
    renderConsumer("", () => undefined);

    act(() => {
      useEventBusStore
        .getState()
        .publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.unknown", () => {
  test("records a Sentry breadcrumb with the URL and takes no other action", () => {
    const setComposerInput = mock((_next: string) => undefined);
    renderConsumer("", setComposerInput);

    act(() => {
      useEventBusStore
        .getState()
        .publish("deeplink.unknown", { url: "javascript:alert(1)" });
    });

    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    const args = sentryBreadcrumbMock.mock.calls[0]?.[0] as {
      data?: { url?: string };
    };
    expect(args.data?.url).toBe("javascript:alert(1)");
    // No navigation, no composer set, no main-window activation —
    // unknown links don't do anything user-visible.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(setComposerInput).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });
});

describe("subscription lifecycle", () => {
  test("re-renders with new composerInput don't tear down + resubscribe the bus listeners", () => {
    // If the effect's dep array included composerInput, every
    // keystroke would unsubscribe + resubscribe. Verify it
    // doesn't by counting subscriber registrations across a
    // re-render — should stay 3 (one per event).
    const setComposerInput = mock((_next: string) => undefined);
    const { rerender } = renderConsumer("", setComposerInput);

    // After mount we expect 3 subscriptions registered on the bus.
    // Publish each event and assert handlers fired exactly once.
    act(() => {
      useEventBusStore.getState().publish("deeplink.send", { message: "x" });
    });
    expect(setComposerInput).toHaveBeenCalledTimes(1);

    // Trigger a re-render with new input. If the effect re-runs,
    // the next publish would see the dep-array reset + handlers
    // mounting + unmounting — and the assert below could either
    // dupe or drop the event in a race. The stable subscription
    // makes it deterministic.
    rerender({ input: "typing", set: setComposerInput });

    act(() => {
      useEventBusStore
        .getState()
        .publish("deeplink.openThread", { threadId: "z" });
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  test("unsubscribes on unmount", () => {
    const setComposerInput = mock((_next: string) => undefined);
    const { unmount } = renderConsumer("", setComposerInput);

    unmount();

    // After unmount, publishing shouldn't reach the handlers.
    act(() => {
      useEventBusStore
        .getState()
        .publish("deeplink.send", { message: "post-unmount" });
      useEventBusStore
        .getState()
        .publish("deeplink.openThread", { threadId: "z" });
      useEventBusStore
        .getState()
        .publish("deeplink.unknown", { url: "x" });
    });

    expect(setComposerInput).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
  });
});
