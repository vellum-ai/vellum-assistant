import { beforeEach, describe, expect, mock, test } from "bun:test";

type AppUrlOpenHandler = (payload: { url: string }) => void;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

let capacitorPlatform = "ios";
mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorPlatform,
  },
}));

let urlOpenHandler: AppUrlOpenHandler | null = null;
let launchUrl: string | undefined;
const addListenerMock = mock(
  (_event: "appUrlOpen", handler: AppUrlOpenHandler) => {
    urlOpenHandler = handler;
    return Promise.resolve({ remove: async () => {} });
  },
);
const getLaunchUrlMock = mock(async () =>
  launchUrl === undefined ? undefined : { url: launchUrl },
);

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
    getLaunchUrl: getLaunchUrlMock,
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

// The dynamic `import("@capacitor/app")` can resolve on a loader turn before
// its promise chain queues listener registration. Flush both queues before
// driving the captured handler.
const flushAsyncWork = async (rounds = 4) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  capacitorPlatform = "ios";
  urlOpenHandler = null;
  launchUrl = undefined;
  addListenerMock.mockClear();
  getLaunchUrlMock.mockClear();
  captureErrorMock.mockClear();
});

// The platform guard, unsubscribe races, and failure reporting are the
// `subscribeCapacitorListener` contract, covered by
// `runtime/capacitor-listener.test.ts`. This suite covers only this
// source's wiring: URL routing and its error context.
describe("publishCapacitorDeepLinksSource", () => {
  test("routes the launch URL when a deep link cold-starts Android", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );
    launchUrl =
      "vellum-assistant://billing/checkout-complete?status=success&session_id=cs_test_a1B2";
    capacitorPlatform = "android";

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork(6);

      expect(received).toEqual([
        { status: "success", sessionId: "cs_test_a1B2", flow: "subscription" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("does not replay the retained launch URL on iOS", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );
    launchUrl =
      "vellum-assistant://billing/checkout-complete?status=success&session_id=cs_test_a1B2";

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      expect(getLaunchUrlMock).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    } finally {
      unsubscribeBus();
    }
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
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

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

  test("publishes deeplink.billingCheckoutComplete for a successful checkout return", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=success&session_id=cs_test_a1B2",
      });

      // No `flow` param: released clients and current Pro links omit it, so
      // it must default to the subscription flow.
      expect(received).toEqual([
        { status: "success", sessionId: "cs_test_a1B2", flow: "subscription" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("publishes a cancel checkout return with no session id", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=cancel",
      });

      expect(received).toEqual([
        { status: "cancel", sessionId: null, flow: "subscription" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("carries flow=top_up through on both statuses", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=success&session_id=cs_test_a1B2&flow=top_up",
      });
      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=cancel&flow=top_up",
      });

      expect(received).toEqual([
        { status: "success", sessionId: "cs_test_a1B2", flow: "top_up" },
        { status: "cancel", sessionId: null, flow: "top_up" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("an unrecognized flow value degrades to the subscription flow", async () => {
    const received: unknown[] = [];
    const unsubscribeBus = subscribe(
      "deeplink.billingCheckoutComplete",
      (payload) => {
        received.push(payload);
      },
    );

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=cancel&flow=bogus",
      });

      expect(received).toEqual([
        { status: "cancel", sessionId: null, flow: "subscription" },
      ]);
    } finally {
      unsubscribeBus();
    }
  });

  test("a malformed session id falls through to unknown rather than reaching billing", async () => {
    const checkouts: unknown[] = [];
    const unknowns: { url: string }[] = [];
    const unsubCheckout = subscribe("deeplink.billingCheckoutComplete", (p) => {
      checkouts.push(p);
    });
    const unsubUnknown = subscribe("deeplink.unknown", (p) => {
      unknowns.push(p);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({
        url: "vellum-assistant://billing/checkout-complete?status=success&session_id=not-a-session",
      });

      expect(checkouts).toEqual([]);
      // The query is stripped on the fallback, so the bad id can't reach
      // telemetry.
      expect(unknowns).toEqual([
        { url: "vellum-assistant://billing/checkout-complete" },
      ]);
    } finally {
      unsubCheckout();
      unsubUnknown();
    }
  });

  test("publishes deeplink.startVoice, keeping the mode the unknown fallback would strip", async () => {
    const starts: unknown[] = [];
    const unknowns: unknown[] = [];
    const unsubStart = subscribe("deeplink.startVoice", (p) => {
      starts.push(p);
    });
    const unsubUnknown = subscribe("deeplink.unknown", (p) => {
      unknowns.push(p);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({ url: "vellum-assistant://voice?mode=resume" });

      expect(starts).toEqual([{ mode: "resume", prompt: null }]);
      expect(unknowns).toEqual([]);
    } finally {
      unsubStart();
      unsubUnknown();
    }
  });

  test("a look-alike scheme falls through to unknown rather than starting voice", async () => {
    const starts: unknown[] = [];
    const unknowns: unknown[] = [];
    const unsubStart = subscribe("deeplink.startVoice", (p) => {
      starts.push(p);
    });
    const unsubUnknown = subscribe("deeplink.unknown", (p) => {
      unknowns.push(p);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

      urlOpenHandler!({ url: "vellum-assistant-evil://voice?mode=new" });

      expect(starts).toEqual([]);
      expect(unknowns).toEqual([{ url: "vellum-assistant-evil://voice" }]);
    } finally {
      unsubStart();
      unsubUnknown();
    }
  });

  test("publishes deeplink.unknown on the bus for a non-OAuth URL", async () => {
    const received: { url: string }[] = [];
    const unsubscribeBus = subscribe("deeplink.unknown", (payload) => {
      received.push(payload);
    });

    try {
      publishCapacitorDeepLinksSource();
      await flushAsyncWork();

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
      await flushAsyncWork();

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
      await flushAsyncWork();

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
    await flushAsyncWork();

    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "capacitor_deep_links",
      level: "warning",
    });
  });
});
