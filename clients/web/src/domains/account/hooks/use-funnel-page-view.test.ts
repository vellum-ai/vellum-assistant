import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

let native = false;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => native,
}));

const { useFunnelPageView } = await import(
  "@/domains/account/hooks/use-funnel-page-view"
);

const SIGNUP = "/account/signup";

let fetchMock: ReturnType<typeof mock>;
let originalFetch: typeof globalThis.fetch;
let originalLocation: PropertyDescriptor | undefined;

function setHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  native = false;
  // Captured before the first override so `afterEach` can put the real
  // `window.location` back. Leaking a vellum.ai hostname into the rest of the
  // suite makes every later auth-page test fire a real beacon.
  originalLocation ??= Object.getOwnPropertyDescriptor(window, "location");
  setHostname("www.vellum.ai");
  originalFetch = globalThis.fetch;
  fetchMock = mock(async () => new Response(null, { status: 204 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});

function bodyOf(call: unknown[]): { path?: string } {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as { path?: string };
}

describe("useFunnelPageView", () => {
  test("reports the arrival to the platform ledger endpoint", () => {
    renderHook(() => useFunnelPageView(SIGNUP, true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown[];
    expect(call[0]).toBe("/api/funnel/view");
    expect(bodyOf(call).path).toBe(SIGNUP);
  });

  test("sends cookies so the platform can resolve the HttpOnly visitor id", () => {
    renderHook(() => useFunnelPageView(SIGNUP, true));

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
  });

  test("survives the navigation to the OAuth provider", () => {
    renderHook(() => useFunnelPageView(SIGNUP, true));

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.keepalive).toBe(true);
  });

  test("does not report until the visitor actually reaches the screen", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useFunnelPageView(SIGNUP, enabled),
      { initialProps: { enabled: false } },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("one arrival is one ledger entry across re-renders", () => {
    const { rerender } = renderHook(() => useFunnelPageView(SIGNUP, true));

    rerender();
    rerender();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("stays out of the native funnel, which resolves a different origin", () => {
    native = true;

    renderHook(() => useFunnelPageView(SIGNUP, true));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["assistant.acme-corp.internal", "localhost"])(
    "skips %s, where the platform endpoint does not exist",
    (hostname) => {
      setHostname(hostname);

      renderHook(() => useFunnelPageView(SIGNUP, true));

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("a failed beacon never surfaces to the auth screen", () => {
    fetchMock = mock(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    expect(() =>
      renderHook(() => useFunnelPageView(SIGNUP, true)),
    ).not.toThrow();
  });
});
