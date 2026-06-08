import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };

let activeCallback: ((link: DeepLink) => void) | null = null;
let pendingFixture: DeepLink[] = [];
let drainError: Error | null = null;
const unsubscribeMock = mock(() => {
  activeCallback = null;
});
const subscribeToDeepLinksMock = mock((cb: (link: DeepLink) => void) => {
  activeCallback = cb;
  return unsubscribeMock;
});
const drainPendingDeepLinksMock = mock(async (): Promise<DeepLink[]> => {
  if (drainError) throw drainError;
  const drained = pendingFixture;
  pendingFixture = [];
  return drained;
});

mock.module("@/runtime/deep-links", () => ({
  drainPendingDeepLinks: drainPendingDeepLinksMock,
  subscribeToDeepLinks: subscribeToDeepLinksMock,
}));

const captureExceptionMock = mock(() => {});
// Full Sentry surface — `mock.module` is process-global in bun, so a
// partial shape would shadow `addBreadcrumb` (used by other modules
// transitively loaded in this run) for every later test file. Both
// methods are kept here so the mock can satisfy any consumer that
// happens to load Sentry through our module under test.
mock.module("@sentry/browser", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));
mock.module("@sentry/react", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));

import * as eventBus from "@/lib/event-bus";

const publishSpy = spyOn(eventBus, "publish");

const { publishElectronDeepLinksSource } = await import(
  "@/runtime/event-sources/electron-deep-links"
);

beforeEach(() => {
  activeCallback = null;
  pendingFixture = [];
  drainError = null;
  subscribeToDeepLinksMock.mockClear();
  drainPendingDeepLinksMock.mockClear();
  unsubscribeMock.mockClear();
  captureExceptionMock.mockClear();
  publishSpy.mockClear();
});

describe("publishElectronDeepLinksSource", () => {
  test("maps each DeepLink kind onto its typed bus event for live links", () => {
    publishElectronDeepLinksSource();

    activeCallback!({ kind: "send", message: "hi" });
    activeCallback!({ kind: "openThread", threadId: "t-1" });
    activeCallback!({ kind: "unknown", url: "javascript:alert(1)" });

    expect(publishSpy.mock.calls).toEqual([
      ["deeplink.send", { message: "hi" }],
      ["deeplink.openThread", { threadId: "t-1" }],
      ["deeplink.unknown", { url: "javascript:alert(1)" }],
    ]);
  });

  test("subscribes BEFORE draining — covers the in-flight race", async () => {
    publishElectronDeepLinksSource();

    expect(subscribeToDeepLinksMock).toHaveBeenCalled();
    expect(drainPendingDeepLinksMock).toHaveBeenCalled();
    const subscribeOrder =
      subscribeToDeepLinksMock.mock.invocationCallOrder[0]!;
    const drainOrder = drainPendingDeepLinksMock.mock.invocationCallOrder[0]!;
    expect(subscribeOrder).toBeLessThan(drainOrder);
  });

  test("publishes drained links once the drain promise settles", async () => {
    pendingFixture = [
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "thread-1" },
    ];

    publishElectronDeepLinksSource();
    await Promise.resolve();
    await Promise.resolve();

    expect(publishSpy.mock.calls).toEqual([
      ["deeplink.send", { message: "one" }],
      ["deeplink.openThread", { threadId: "thread-1" }],
    ]);
  });

  test("reports a drain failure to Sentry instead of propagating", async () => {
    drainError = new Error("ipc transport failed");

    publishElectronDeepLinksSource();
    await Promise.resolve();
    await Promise.resolve();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(drainError, {
      level: "warning",
      tags: { context: "deep_link_drain" },
    });
  });

  test("returns the subscribe-side unsubscribe so cleanup detaches the live bridge", () => {
    const unsubscribe = publishElectronDeepLinksSource();

    expect(unsubscribeMock).not.toHaveBeenCalled();
    unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
