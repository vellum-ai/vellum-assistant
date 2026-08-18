import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { RemoteWebPairingTokenResult } from "@/lib/auth/remote-gateway-session";

let remoteGatewayMode = false;
let injectedAssistantName: string | undefined;
let injectedHubUrl: string | undefined;
let nativePlatform = false;
let nativePlatformName: "ios" | "android" = "ios";
const nativeSwitchToOriginPathMock = mock(
  async (_url: string | null, _path: string) => false,
);

mock.module("@/lib/local-mode", () => ({
  isRemoteGatewayMode: () => remoteGatewayMode,
  getRemoteGatewayAssistantName: () => injectedAssistantName,
  getRemoteGatewayHubUrl: () => injectedHubUrl,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));

mock.module("@/runtime/self-hosted-servers", () => ({
  nativeSwitchToOriginPath: nativeSwitchToOriginPathMock,
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => (nativePlatform ? nativePlatformName : "web"),
  },
}));

const ORIGINAL_USER_AGENT = navigator.userAgent;
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

function androidIntentQuery(href: string): URLSearchParams {
  return new URLSearchParams(
    href.slice(href.indexOf("?") + 1, href.indexOf("#Intent;")),
  );
}

function androidIntentFallback(href: string): string {
  const encoded = /;S\.browser_fallback_url=([^;]+);end$/.exec(href)?.[1];
  return decodeURIComponent(encoded ?? "");
}

const exchangeRemoteWebPairingTokenMock = mock(
  async (
    _deviceCode: string,
    _signal?: AbortSignal,
  ): Promise<RemoteWebPairingTokenResult> => ({
    status: "pending",
    expiresAt: "2026-06-16T12:00:00.000Z",
    intervalSeconds: 5,
  }),
);
const createRemoteWebPairingChallengeMock = mock(
  async (_signal?: AbortSignal) => ({
    deviceCode: "created-device",
    userCode: "B8C2-S2J3",
    verificationUri: "http://localhost:3000/assistant/pair",
    expiresAt: "2026-06-16T12:00:00.000Z",
    expiresInSeconds: 600,
    intervalSeconds: 5,
  }),
);
const activateRemoteGatewaySessionMock = mock((_session: unknown) => {});

const APPROVED_RESULT: RemoteWebPairingTokenResult = {
  status: "approved",
  accessToken: "access-token",
  accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
  refreshAfter: "2999-01-01T00:00:00.000Z",
  guardianId: "guardian-1",
  assistantId: "assistant-1",
};

class MockRemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

mock.module("@/lib/auth/remote-gateway-session", () => ({
  activateRemoteGatewaySession: activateRemoteGatewaySessionMock,
  createRemoteWebPairingChallenge: createRemoteWebPairingChallengeMock,
  exchangeRemoteWebPairingToken: exchangeRemoteWebPairingTokenMock,
  parseRemoteWebPairingParams: (value: string) => {
    const url = new URL(value, "http://localhost:3000");
    return {
      deviceCode: url.searchParams.get("deviceCode"),
      userCode: url.searchParams.get("userCode"),
    };
  },
  remoteGatewayPublicBaseUrl: () => {
    const { origin, pathname } = window.location;
    const match = /\/assistant(?:\/|$)/.exec(pathname);
    const prefix =
      match && match.index > 0
        ? pathname.slice(0, match.index).replace(/\/+$/, "")
        : "";
    return `${origin}${prefix}`;
  },
  RemoteWebPairingError: MockRemoteWebPairingError,
}));

const { RemoteWebPairingPage } =
  await import("@/domains/remote-web/pairing-page");

afterEach(() => {
  cleanup();
  remoteGatewayMode = false;
  injectedAssistantName = undefined;
  injectedHubUrl = undefined;
  nativePlatform = false;
  nativePlatformName = "ios";
  setUserAgent(ORIGINAL_USER_AGENT);
  exchangeRemoteWebPairingTokenMock.mockClear();
  createRemoteWebPairingChallengeMock.mockClear();
  activateRemoteGatewaySessionMock.mockClear();
  nativeSwitchToOriginPathMock.mockReset();
  nativeSwitchToOriginPathMock.mockImplementation(async () => false);
});

describe("RemoteWebPairingPage", () => {
  test("renders NotFound outside remote-gateway mode", () => {
    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Page not found")).not.toBeNull();
    expect(createRemoteWebPairingChallengeMock).not.toHaveBeenCalled();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("polls for a token in remote-gateway mode", async () => {
    remoteGatewayMode = true;

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
      "device-1",
    );
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[1]).toBeInstanceOf(
      AbortSignal,
    );
    expect(createRemoteWebPairingChallengeMock).not.toHaveBeenCalled();
  });

  test("cancel leaves the origin for the hub chooser", async () => {
    remoteGatewayMode = true;
    injectedHubUrl = "https://hub.example.com/assistant";
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      // An in-app navigate would be bounced back here by the remote-gateway
      // pairing guard, so cancelling must cross to the hub's own origin.
      await waitFor(() => {
        expect(assignMock.mock.calls[0]?.[0]).toBe(
          "https://hub.example.com/assistant/select-assistant?noAutoSkip=1",
        );
      });
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("cancel uses the native origin switch when available", async () => {
    remoteGatewayMode = true;
    injectedHubUrl = "https://hub.example.com/assistant";
    nativePlatform = true;
    nativeSwitchToOriginPathMock.mockResolvedValueOnce(true);
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
          null,
          "select-assistant?noAutoSkip=1",
        );
      });
      expect(assignMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("cancel falls back when the native shell lacks path switching", async () => {
    remoteGatewayMode = true;
    injectedHubUrl = "https://hub.example.com/assistant";
    nativePlatform = true;
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
          null,
          "select-assistant?noAutoSkip=1",
        );
        expect(assignMock.mock.calls[0]?.[0]).toBe(
          "https://hub.example.com/assistant/select-assistant?noAutoSkip=1",
        );
      });
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("cancel is hidden when the served config names no hub", async () => {
    remoteGatewayMode = true;
    injectedHubUrl = undefined;

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  test("shows progress state while creating a challenge", () => {
    remoteGatewayMode = true;
    createRemoteWebPairingChallengeMock.mockImplementationOnce(
      async () => new Promise<never>(() => {}),
    );

    const { container } = render(
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Starting pairing")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(
      container.querySelector('[class*="--system-negative-strong"]'),
    ).toBeNull();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("creates a challenge when opened without a device code", async () => {
    remoteGatewayMode = true;

    render(
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("B8C2-S2J3")).not.toBeNull();
    expect(
      createRemoteWebPairingChallengeMock.mock.calls[0]?.[0],
    ).toBeInstanceOf(AbortSignal);
    // The token-exchange poll fires in an effect after the challenge resolves
    // and `pairing` is set, so it lands a tick after the user code renders.
    await waitFor(() => {
      expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
        "created-device",
      );
    });
  });

  test("surfaces guardian-repair guidance on a repair-required exchange failure", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
        "GUARDIAN_REPAIR_REQUIRED",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/trust database needs repair/)).not.toBeNull();
    expect(screen.getByText(/retry this same pairing link/)).not.toBeNull();
    expect(screen.queryByText(/starting a new pairing/)).toBeNull();
  });

  test("keeps new-pairing guidance for other exchange failures", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/Try starting a new pairing/)).not.toBeNull();
    expect(screen.queryByText(/trust database needs repair/)).toBeNull();
  });

  test("goes straight to paired for a pre-approved code, without flashing the approval code", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(
      async () => APPROVED_RESULT,
    );

    render(
      <MemoryRouter
        initialEntries={[
          "/assistant/pair?deviceCode=fast-code&userCode=WXYZ-1234",
        ]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Connected")).not.toBeNull();
    expect(activateRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    // The pre-approved arrival never shows the approval-code / waiting UI.
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(screen.queryByText("Pairing code")).toBeNull();
    expect(screen.queryByText("WXYZ-1234")).toBeNull();
  });

  test("still shows the waiting state and code when the code is not yet approved", async () => {
    remoteGatewayMode = true;
    // Default mock returns pending — the not-pre-approved device-code path.

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=slow-code&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(screen.getByText("ABCD")).not.toBeNull();
    expect(screen.getByText("Pairing code")).not.toBeNull();
  });

  test("clears the device-code fragment from the URL after a successful exchange", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(
      async () => APPROVED_RESULT,
    );
    const replaceStateSpy = mock(
      (_data: unknown, _unused: string, _url?: string | URL | null) => {},
    );
    const originalReplaceState = window.history.replaceState;
    Object.defineProperty(window.history, "replaceState", {
      configurable: true,
      value: replaceStateSpy,
    });

    try {
      render(
        <MemoryRouter initialEntries={["/assistant/pair?deviceCode=fast-code"]}>
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      await screen.findByText("Connected");
      expect(replaceStateSpy).toHaveBeenCalled();
      // The replacement URL carries no fragment.
      const clearedWithoutHash = replaceStateSpy.mock.calls.some(
        (call) => !String(call?.[2] ?? "").includes("#"),
      );
      expect(clearedWithoutHash).toBe(true);
    } finally {
      Object.defineProperty(window.history, "replaceState", {
        configurable: true,
        value: originalReplaceState,
      });
    }
  });

  test("offers the app handoff for a device code in an iOS browser without burning the code", async () => {
    remoteGatewayMode = true;
    setUserAgent(IPHONE_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Vellum app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("vellum-assistant://connect?")).toBe(true);
    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("url")).toBe(window.location.origin);
    expect(query.get("code")).toBe("device-1");
    // The served config carries no assistant name, so the link omits it.
    expect(query.has("name")).toBe(false);

    // The single-use code stays unspent while the choice is pending.
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
    expect(createRemoteWebPairingChallengeMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Continue in this browser" }),
    ).not.toBeNull();
  });

  test("offers the same app handoff in an Android browser", async () => {
    remoteGatewayMode = true;
    setUserAgent(ANDROID_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={[
          "/assistant/pair?deviceCode=android-device&userCode=ABCD",
        ]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Vellum app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("intent://connect?")).toBe(true);
    const intentIndex = href.indexOf("#Intent;");
    const query = androidIntentQuery(href);
    expect(query.get("url")).toBe(window.location.origin);
    expect(query.get("code")).toBe("android-device");
    expect(href.slice(intentIndex)).toContain(
      "#Intent;scheme=vellum-assistant;package=ai.vellum.assistant;",
    );
    expect(androidIntentFallback(href)).toBe(window.location.href);
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("the app handoff url carries the assistant name from the served config", async () => {
    remoteGatewayMode = true;
    injectedAssistantName = "My Homelab";
    setUserAgent(IPHONE_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Vellum app",
    });
    const href = link.getAttribute("href") ?? "";
    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("name")).toBe("My Homelab");
    expect(query.get("code")).toBe("device-1");
    // Spaces are percent-encoded, not form-encoded: iOS URLComponents keeps
    // a raw `+` as a literal plus.
    expect(href).toContain("name=My%20Homelab");
  });

  test("the Android app handoff url carries the assistant name too", async () => {
    remoteGatewayMode = true;
    injectedAssistantName = "My Homelab";
    setUserAgent(ANDROID_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Vellum app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(androidIntentQuery(href).get("name")).toBe("My Homelab");
  });

  test("the app handoff url keeps a served path prefix", async () => {
    remoteGatewayMode = true;
    setUserAgent(IPHONE_USER_AGENT);
    // The real window location carries the served path in production; the
    // in-memory router below only controls the route, not window.location.
    window.history.pushState(null, "", "/assistant-123/assistant/pair");

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      const link = await screen.findByRole("link", {
        name: "Open in the Vellum app",
      });
      const href = link.getAttribute("href") ?? "";
      const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
      expect(query.get("url")).toBe(`${window.location.origin}/assistant-123`);
    } finally {
      window.history.pushState(null, "", "/");
    }
  });

  test("the Android app handoff url preserves encoded codes", async () => {
    remoteGatewayMode = true;
    setUserAgent(ANDROID_USER_AGENT);
    const deviceCode = "code & # / 🚀";
    const pairingQuery = new URLSearchParams({
      deviceCode,
      userCode: "ABCD",
    });

    render(
      <MemoryRouter
        initialEntries={[`/assistant/pair?${pairingQuery.toString()}`]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Vellum app",
    });
    const href = link.getAttribute("href") ?? "";
    const query = androidIntentQuery(href);
    expect(query.get("code")).toBe(deviceCode);
  });

  test("exchanges immediately for a device code in a desktop browser", async () => {
    remoteGatewayMode = true;
    // The default happy-dom user agent is a desktop browser.

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
        "device-1",
      );
    });
    expect(
      screen.queryByRole("link", { name: "Open in the Vellum app" }),
    ).toBeNull();
  });

  test("keeps browser pairing available when an app handoff fails", async () => {
    remoteGatewayMode = true;
    setUserAgent(ANDROID_USER_AGENT);
    window.history.pushState(
      null,
      "",
      "/assistant/pair?deviceCode=device-1&userCode=ABCD",
    );

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      const link = await screen.findByRole("link", {
        name: "Open in the Vellum app",
      });
      const href = link.getAttribute("href") ?? "";
      expect(androidIntentFallback(href)).toBe(window.location.href);

      const continueButton = screen.getByRole("button", {
        name: "Continue in this browser",
      });
      expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();

      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
          "device-1",
        );
      });
      expect(
        screen.queryByRole("link", { name: "Open in the Vellum app" }),
      ).toBeNull();
    } finally {
      window.history.pushState(null, "", "/");
    }
  });

  test.each([
    ["iOS", "ios", IPHONE_USER_AGENT],
    ["Android", "android", ANDROID_USER_AGENT],
  ] as const)(
    "skips the app handoff inside the native %s shell",
    async (_, platform, userAgent) => {
      remoteGatewayMode = true;
      setUserAgent(userAgent);
      nativePlatform = true;
      nativePlatformName = platform;

      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
          "device-1",
        );
      });
      expect(
        screen.queryByRole("link", { name: "Open in the Vellum app" }),
      ).toBeNull();
    },
  );
});
