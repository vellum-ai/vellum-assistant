import { beforeEach, describe, expect, mock, test } from "bun:test";

type AppUrlOpenHandler = (payload: { url: string }) => void;

let isNative = true;
const isNativePlatformMock = mock(() => isNative);
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: isNativePlatformMock,
}));

let urlOpenHandler: AppUrlOpenHandler | null = null;
const handleRemoveMock = mock(async () => {});
let addListenerResolver:
  ((value: { remove: typeof handleRemoveMock }) => void) | null = null;
let addListenerRejecter: ((err: Error) => void) | null = null;

const addListenerMock = mock(
  (_event: "appUrlOpen", handler: AppUrlOpenHandler) => {
    urlOpenHandler = handler;
    return new Promise<{ remove: typeof handleRemoveMock }>(
      (resolve, reject) => {
        addListenerResolver = resolve;
        addListenerRejecter = reject;
      },
    );
  },
);

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
  },
}));

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

import { subscribe } from "@/lib/event-bus";
import {
  buildOAuthCompleteDeepLink,
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";

const { publishCapacitorDeepLinksSource } =
  await import("@/runtime/event-sources/capacitor-deep-links");

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};
const resolveAddListener = async () => {
  // The dynamic `import("@capacitor/app")` and its `.then` chain each
  // queue a microtask, so the source's `addListenerMock` call lags
  // synchronous test code. Flush before resolving the pending promise,
  // then flush again so the `.then` that stores the `handle` runs.
  await flushMicrotasks();
  addListenerResolver?.({ remove: handleRemoveMock });
  await flushMicrotasks();
};

beforeEach(() => {
  isNative = true;
  urlOpenHandler = null;
  addListenerResolver = null;
  addListenerRejecter = null;
  isNativePlatformMock.mockClear();
  addListenerMock.mockClear();
  handleRemoveMock.mockClear();
  captureErrorMock.mockClear();
});

describe("publishCapacitorDeepLinksSource", () => {
  test("is a no-op off Capacitor iOS (returns a no-op unsubscribe, never imports the plugin)", () => {
    isNative = false;

    const unsubscribe = publishCapacitorDeepLinksSource();
    unsubscribe();

    expect(addListenerMock).not.toHaveBeenCalled();
  });

  test("dispatches the OAuth-complete window CustomEvent for an oauth-complete deep link", async () => {
    const received: OAuthCompleteDeepLinkPayload[] = [];
    const windowListener = (
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) => {
      received.push(event.detail);
    };
    window.addEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, windowListener);

    try {
      const unsubscribe = publishCapacitorDeepLinksSource();
      await resolveAddListener();

      const payload: OAuthCompleteDeepLinkPayload = {
        requestId: "req-123",
        oauthStatus: "success",
        oauthProvider: "google",
        oauthCode: "code-abc",
      };
      urlOpenHandler!({
        url: buildOAuthCompleteDeepLink("vellum-assistant", payload),
      });

      expect(received).toEqual([payload]);
      unsubscribe();
    } finally {
      window.removeEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        windowListener,
      );
    }
  });

  test("publishes deeplink.unknown on the bus for a non-OAuth URL", async () => {
    const received: { url: string }[] = [];
    const unsubscribeBus = subscribe("deeplink.unknown", (payload) => {
      received.push(payload);
    });

    try {
      const unsubscribe = publishCapacitorDeepLinksSource();
      await resolveAddListener();

      urlOpenHandler!({ url: "vellum-assistant://some-future-link?x=1" });

      expect(received).toEqual([
        { url: "vellum-assistant://some-future-link?x=1" },
      ]);
      unsubscribe();
    } finally {
      unsubscribeBus();
    }
  });

  test("returned unsubscribe removes the listener once it resolves", async () => {
    const unsubscribe = publishCapacitorDeepLinksSource();

    await resolveAddListener();
    expect(handleRemoveMock).not.toHaveBeenCalled();

    unsubscribe();
    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe BEFORE the lazy import resolves still removes the just-registered listener", async () => {
    const unsubscribe = publishCapacitorDeepLinksSource();

    unsubscribe();
    await resolveAddListener();

    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("reports a lazy-import failure instead of throwing", async () => {
    publishCapacitorDeepLinksSource();

    await flushMicrotasks();
    const err = new Error("plugin missing");
    addListenerRejecter?.(err);
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "capacitor_deep_links",
      level: "warning",
    });
  });
});
