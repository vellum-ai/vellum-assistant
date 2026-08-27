/**
 * The per-surface switch fork: a browser navigates, a native mobile shell
 * swaps its own origin, and a shell too old to carry the plugin degrades to
 * the same navigation the browser takes.
 *
 * Self-contained mocks: run this file solo (`mock.module` leaks across a
 * shared `bun test` run).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { parseRemoteWebPairingParams } from "@vellumai/service-contracts/remote-web-pairing";

import type { RememberedOrigin } from "@/stores/remembered-origins-store";

let isNativeMobileValue = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeMobile: () => isNativeMobileValue,
}));

let nativeSwitchAccepts = true;
const nativeSwitchToOriginMock = mock(
  async (_url: string | null) => nativeSwitchAccepts,
);
const nativeSwitchToOriginPathMock = mock(
  async (_url: string | null, _path: string) => nativeSwitchAccepts,
);
mock.module("@/runtime/self-hosted-servers", () => ({
  nativeSwitchToOrigin: nativeSwitchToOriginMock,
  nativeSwitchToOriginPath: nativeSwitchToOriginPathMock,
}));

let remoteGatewayMode = false;
mock.module("@/lib/local-mode", () => ({
  isRemoteGatewayMode: () => remoteGatewayMode,
}));

let publicBaseUrl = "https://gateway.example/assistant-1";
mock.module("@/lib/auth/remote-gateway-session", () => ({
  remoteGatewayPublicBaseUrl: () => publicBaseUrl,
}));

const assignMock = mock((_url: string) => {});
Object.defineProperty(window.location, "assign", {
  configurable: true,
  value: assignMock,
});

// Every real deployment serves the SPA over https, which is the only scheme a
// remembered origin can carry; the harness default is http.
window.location.href = "https://app.example/select-assistant";

const { isCurrentOrigin, switchToOrigin } =
  await import("@/assistant/switch-origin");

function origin(url: string): RememberedOrigin {
  return { url, addedAt: "2026-01-01T00:00:00.000Z" };
}

/**
 * The route-path shape both Capacitor shells accept from `switchToPath`,
 * transcribed from their guards: iOS
 * `SelfHostedServersPlugin.switchToPath` rejects on
 * `!path.isEmpty, !path.hasPrefix("/"), !path.contains("://"), !path.contains("#")`,
 * and Android `SelfHostedServer.isRoutePathShape` applies the same four. A
 * path failing this is rejected by every shipped shell, so the swap never
 * happens and the caller falls out to a navigation off the app's own origin.
 */
function isShellRoutePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("://") &&
    !path.includes("#")
  );
}

beforeEach(() => {
  isNativeMobileValue = false;
  nativeSwitchAccepts = true;
  remoteGatewayMode = false;
  publicBaseUrl = "https://gateway.example/assistant-1";
  assignMock.mockClear();
  nativeSwitchToOriginMock.mockClear();
  nativeSwitchToOriginPathMock.mockClear();
});

describe("switchToOrigin", () => {
  test("navigates to the origin's SPA root on the web, without touching the bridge", async () => {
    await switchToOrigin(origin("https://host.example/assistant-1"));

    expect(assignMock).toHaveBeenCalledWith(
      "https://host.example/assistant-1/assistant",
    );
    expect(nativeSwitchToOriginMock).not.toHaveBeenCalled();
  });

  test("the web navigation is issued synchronously", () => {
    void switchToOrigin(origin("https://host.example"));

    expect(assignMock).toHaveBeenCalled();
  });

  test("a native mobile shell swaps its origin in place", async () => {
    isNativeMobileValue = true;

    await switchToOrigin(origin("https://host.example"));

    expect(nativeSwitchToOriginMock).toHaveBeenCalledWith(
      "https://host.example",
    );
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("a shell without the plugin falls back to plain navigation", async () => {
    isNativeMobileValue = true;
    nativeSwitchAccepts = false;

    await switchToOrigin(origin("https://host.example"));

    expect(assignMock).toHaveBeenCalledWith("https://host.example/assistant");
  });

  test("a device code lands on the origin's pair page carrying the code", async () => {
    await switchToOrigin(origin("https://host.example/assistant-1"), "CODE-1");

    expect(assignMock).toHaveBeenCalledWith(
      "https://host.example/assistant-1/assistant/pair#device_code=CODE-1",
    );
  });

  // The shells reject a fragment outright, so a fragment here is not a
  // cosmetic difference: it rejects, the swap never happens, and the app
  // webview navigates off `capacitor://localhost` to a remote origin instead.
  test("a native shell swaps origin and route together for a device code", async () => {
    isNativeMobileValue = true;

    await switchToOrigin(origin("https://host.example"), "CODE-1");

    expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
      "https://host.example",
      "pair?device_code=CODE-1",
    );
    expect(nativeSwitchToOriginMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("the native route path is one the shells accept, code intact", async () => {
    isNativeMobileValue = true;

    await switchToOrigin(origin("https://host.example"), "CODE-1");

    const path = nativeSwitchToOriginPathMock.mock.calls[0]?.[1] ?? "";
    expect(isShellRoutePath(path)).toBe(true);
    // The shells append the path to the assistant entry, keeping its query
    // verbatim, and the pair page parses `pathname + search + hash`.
    expect(parseRemoteWebPairingParams(path).deviceCode).toBe("CODE-1");
  });

  test("a device code needing escaping survives the native route path", async () => {
    isNativeMobileValue = true;

    await switchToOrigin(origin("https://host.example"), "CODE 1&2=3");

    const path = nativeSwitchToOriginPathMock.mock.calls[0]?.[1] ?? "";
    expect(isShellRoutePath(path)).toBe(true);
    expect(parseRemoteWebPairingParams(path).deviceCode).toBe("CODE 1&2=3");
  });

  test("a shell without path support still reaches the pair page", async () => {
    isNativeMobileValue = true;
    nativeSwitchAccepts = false;

    await switchToOrigin(origin("https://host.example"), "CODE-1");

    expect(assignMock).toHaveBeenCalledWith(
      "https://host.example/assistant/pair#device_code=CODE-1",
    );
  });
});

describe("isCurrentOrigin", () => {
  test("compares against the running deployment's base", () => {
    expect(isCurrentOrigin(origin("https://app.example"))).toBe(true);
    expect(isCurrentOrigin(origin("https://elsewhere.example"))).toBe(false);
  });

  test("remote-gateway mode compares against the public path prefix", () => {
    remoteGatewayMode = true;

    expect(isCurrentOrigin(origin("https://gateway.example/assistant-1"))).toBe(
      true,
    );
    expect(isCurrentOrigin(origin("https://gateway.example"))).toBe(false);
  });

  test("normalizes the running base, since stored urls are already canonical", () => {
    remoteGatewayMode = true;
    publicBaseUrl = "https://Gateway.Example/assistant-1/";

    expect(isCurrentOrigin(origin("https://gateway.example/assistant-1"))).toBe(
      true,
    );
  });
});
