import { beforeEach, describe, expect, mock, test } from "bun:test";

type AppUrlOpenHandler = (payload: { url: string }) => void;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

let urlOpenHandler: AppUrlOpenHandler | null = null;
const addListenerMock = mock(
  (_event: "appUrlOpen", handler: AppUrlOpenHandler) => {
    urlOpenHandler = handler;
    return Promise.resolve({ remove: async () => {} });
  },
);

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
  },
}));

// Warm the module cache so the source's lazy `import("@capacitor/app")`
// resolves within microtasks instead of a full loader turn.
await import("@capacitor/app");

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

// The dynamic `import("@capacitor/app")` and its `.then` chain each
// queue a microtask, so listener registration lags synchronous test
// code — flush before driving the captured handler.
const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  urlOpenHandler = null;
  addListenerMock.mockClear();
  captureErrorMock.mockClear();
});

// The platform guard, unsubscribe races, and failure reporting are the
// `subscribeCapacitorListener` contract, covered by
// `runtime/capacitor-listener.test.ts`. This suite covers only this
// source's wiring: URL routing and its error context.
describe("publishCapacitorDeepLinksSource", () => {
  test("dispatches the OAuth-complete window CustomEvent for an oauth-complete deep link", async () => {
    const received: OAuthCompleteDeepLinkPayload[] = [];
    const windowListener = (
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) => {
      received.push(event.detail);
    };
    window.addEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, windowListener);

    try {
      publishCapacitorDeepLinksSource();
      await flushMicrotasks();

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
      publishCapacitorDeepLinksSource();
      await flushMicrotasks();

      urlOpenHandler!({ url: "vellum-assistant://some-future-link" });

      expect(received).toEqual([
        { url: "vellum-assistant://some-future-link" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("strips the query and fragment from unknown URLs before publishing (auth codes must not reach telemetry)", async () => {
    const received: { url: string }[] = [];
    const unsubscribeBus = subscribe("deeplink.unknown", (payload) => {
      received.push(payload);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushMicrotasks();

      urlOpenHandler!({
        url: "vellum-assistant://oauth-done/path?oauth_code=secret-code&x=1#frag-token",
      });

      expect(received).toEqual([{ url: "vellum-assistant://oauth-done/path" }]);
    } finally {
      unsubscribeBus();
    }
  });

  test("truncates unparseable unknown URLs at the first ? or #", async () => {
    const received: { url: string }[] = [];
    const unsubscribeBus = subscribe("deeplink.unknown", (payload) => {
      received.push(payload);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushMicrotasks();

      urlOpenHandler!({ url: "::not-a-parseable-url?oauth_code=secret" });

      expect(received).toEqual([{ url: "::not-a-parseable-url" }]);
    } finally {
      unsubscribeBus();
    }
  });

  test("reports listener-registration failures under the 'capacitor_deep_links' context", async () => {
    const err = new Error("plugin missing");
    addListenerMock.mockImplementationOnce(() => Promise.reject(err));

    publishCapacitorDeepLinksSource();
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "capacitor_deep_links",
      level: "warning",
    });
  });
});
