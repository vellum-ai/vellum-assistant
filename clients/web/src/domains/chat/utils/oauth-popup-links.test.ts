import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject module is imported so the
// internal `Capacitor` and `openUrl` references resolve to these stubs.
// ---------------------------------------------------------------------------

let isNativePlatformMock = false;
let openUrlMock = mock((_url: string) => Promise.resolve());

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock,
  },
}));

mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

import {
  getHttpUrl,
  getSameOriginRoutePath,
  openOAuthUrlInPopup,
  shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import { routes } from "@/utils/routes";

const originalWindow = globalThis.window;

interface MockWindowOptions {
  origin?: string;
  open?: ((url?: string, target?: string, features?: string) => Window | null) | null;
}

function setMockWindow({
  origin = "https://app.vellum.ai",
  open,
}: MockWindowOptions = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin },
      open,
    },
  });
}

beforeEach(() => {
  isNativePlatformMock = false;
  openUrlMock = mock((_url: string) => Promise.resolve());
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("oauth popup links", () => {
  test("detects OAuth authorization URLs", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(false);
    expect(shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com")).toBe(false);
  });

  test("resolves same-origin app routes for client-side navigation", () => {
    const origin = "https://app.vellum.ai";
    setMockWindow({ origin });

    expect(
      getSameOriginRoutePath(
        `${origin}${routes.settings.integrations}?provider=gmail#top`,
      ),
    ).toBe(`${routes.settings.integrations}?provider=gmail#top`);
    expect(getSameOriginRoutePath(routes.settings.integrations)).toBe(
      routes.settings.integrations,
    );
    expect(getSameOriginRoutePath("https://example.com/docs")).toBeNull();
  });

  test("normalizes relative HTTP URLs and rejects unsupported schemes", () => {
    const origin = "https://app.vellum.ai";
    setMockWindow({ origin });

    expect(getHttpUrl(routes.settings.integrations)).toBe(
      `${origin}${routes.settings.integrations}`,
    );
    expect(getHttpUrl("x-apple.systempreferences:com.apple.preference.security")).toBeNull();
  });

  describe("openOAuthUrlInPopup", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    test("returns false and skips both surfaces for non-OAuth URLs", () => {
      const open = mock((_url?: string, _target?: string, _features?: string) => null);
      setMockWindow({ open });

      expect(openOAuthUrlInPopup("https://example.com/docs")).toBe(false);
      expect(openUrlMock).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    test("opens a sized popup on web and reports success", () => {
      const popup = { focus: mock(() => {}) } as unknown as Window;
      const open = mock(() => popup);
      setMockWindow({ open });

      expect(openOAuthUrlInPopup(oauthUrl)).toBe(true);
      expect(open).toHaveBeenCalledWith(oauthUrl, "_blank", "width=500,height=600");
      expect(openUrlMock).not.toHaveBeenCalled();
    });

    test("returns false on web when the popup is blocked", () => {
      const open = mock(() => null);
      setMockWindow({ open });

      expect(openOAuthUrlInPopup(oauthUrl)).toBe(false);
      expect(openUrlMock).not.toHaveBeenCalled();
    });

    test("routes through openUrl on Capacitor native instead of window.open", () => {
      isNativePlatformMock = true;
      const open = mock(() => null);
      setMockWindow({ open });

      expect(openOAuthUrlInPopup(oauthUrl)).toBe(true);
      expect(openUrlMock).toHaveBeenCalledTimes(1);
      expect(openUrlMock).toHaveBeenCalledWith(oauthUrl);
      expect(open).not.toHaveBeenCalled();
    });

    test("returns false on Capacitor native when the URL fails to normalize", () => {
      isNativePlatformMock = true;
      setMockWindow({ open: null });

      // Non-http(s) scheme — the OAuth heuristic is satisfied lexically by the
      // query string, but `getHttpUrl` rejects the scheme so we never dispatch.
      expect(
        openOAuthUrlInPopup(
          "x-apple.systempreferences:foo?response_type=code&client_id=bar&redirect_uri=http%3A%2F%2Flocalhost",
        ),
      ).toBe(false);
      expect(openUrlMock).not.toHaveBeenCalled();
    });
  });
});
