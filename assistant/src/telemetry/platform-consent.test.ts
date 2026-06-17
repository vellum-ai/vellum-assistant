import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Controllable fake platform client. `clientResult` is what
// `VellumPlatformClient.create()` resolves to; `fetchImpl` is the client's
// `fetch`. `fetchCount` tracks calls for single-flight / backoff assertions.
let fetchImpl: (path: string) => Promise<Response> = () =>
  Promise.resolve(new Response("{}", { status: 200 }));
let clientResult: unknown = null;
let fetchCount = 0;

function makeFakeClient() {
  return {
    platformAssistantId: "asst-123",
    fetch: (path: string) => {
      fetchCount += 1;
      return fetchImpl(path);
    },
  };
}

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => Promise.resolve(clientResult),
  },
}));

import {
  _resetPlatformConsentCacheForTests,
  productImprovementConsentFromServer,
  refreshPlatformConsent,
} from "./platform-consent.js";

function consentResponse(value: unknown): Response {
  return new Response(JSON.stringify({ share_product_improvement: value }), {
    status: 200,
  });
}

describe("platform-consent", () => {
  beforeEach(() => {
    _resetPlatformConsentCacheForTests();
    fetchCount = 0;
    clientResult = makeFakeClient();
    fetchImpl = () => Promise.resolve(consentResponse(true));
  });

  test("fails closed before any fetch", () => {
    expect(productImprovementConsentFromServer()).toBe(false);
  });

  test("an affirmative fetch flips the synchronous read on", async () => {
    fetchImpl = () => Promise.resolve(consentResponse(true));
    await refreshPlatformConsent();
    expect(productImprovementConsentFromServer()).toBe(true);
  });

  test("a negative fetch keeps the read off", async () => {
    fetchImpl = () => Promise.resolve(consentResponse(false));
    await refreshPlatformConsent();
    expect(productImprovementConsentFromServer()).toBe(false);
  });

  test("hits the assistant-scoped consent path", async () => {
    let seenPath = "";
    fetchImpl = (path: string) => {
      seenPath = path;
      return Promise.resolve(consentResponse(true));
    };
    await refreshPlatformConsent();
    expect(seenPath).toBe("/v1/assistants/asst-123/consent/");
  });

  describe("fail-closed paths", () => {
    test("no platform client (not logged in) ⇒ off", async () => {
      clientResult = null;
      await refreshPlatformConsent();
      expect(productImprovementConsentFromServer()).toBe(false);
    });

    test("non-2xx response ⇒ off", async () => {
      fetchImpl = () => Promise.resolve(new Response("nope", { status: 500 }));
      await refreshPlatformConsent();
      expect(productImprovementConsentFromServer()).toBe(false);
    });

    test("missing/non-boolean field ⇒ off", async () => {
      fetchImpl = () =>
        Promise.resolve(
          new Response(JSON.stringify({ other: 1 }), { status: 200 }),
        );
      await refreshPlatformConsent();
      expect(productImprovementConsentFromServer()).toBe(false);
    });

    test("fetch throws ⇒ off", async () => {
      fetchImpl = () => Promise.reject(new Error("network down"));
      await refreshPlatformConsent();
      expect(productImprovementConsentFromServer()).toBe(false);
    });
  });

  test("is single-flight: concurrent refreshes share one fetch", async () => {
    fetchImpl = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(consentResponse(true)), 10),
      );
    await Promise.all([
      refreshPlatformConsent(),
      refreshPlatformConsent(),
      refreshPlatformConsent(),
    ]);
    expect(fetchCount).toBe(1);
    expect(productImprovementConsentFromServer()).toBe(true);
  });

  test("TTL-gates repeat fetches within the window", async () => {
    await refreshPlatformConsent();
    expect(fetchCount).toBe(1);
    // A second call immediately after a success is within the TTL — no fetch.
    await refreshPlatformConsent();
    expect(fetchCount).toBe(1);
  });

  test("a successful affirmative then a failure: read stays on until TTL, then off", async () => {
    fetchImpl = () => Promise.resolve(consentResponse(true));
    await refreshPlatformConsent();
    expect(productImprovementConsentFromServer()).toBe(true);
    // Even if a later fetch would fail, the cached affirmative is trusted
    // within the TTL (no new fetch happens — TTL-gated).
    fetchImpl = () => Promise.reject(new Error("later failure"));
    await refreshPlatformConsent();
    expect(productImprovementConsentFromServer()).toBe(true);
  });
});
