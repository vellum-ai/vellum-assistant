/**
 * The per-surface switch fork: a browser navigates, a native mobile shell
 * swaps its own origin, and a shell too old to carry the plugin degrades to
 * the same navigation the browser takes.
 *
 * Self-contained mocks: run this file solo (`mock.module` leaks across a
 * shared `bun test` run).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RememberedOrigin } from "@/stores/remembered-origins-store";

let isNativeMobileValue = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeMobile: () => isNativeMobileValue,
}));

let nativeSwitchAccepts = true;
const nativeSwitchToOriginMock = mock(
  async (_url: string | null) => nativeSwitchAccepts,
);
mock.module("@/runtime/self-hosted-servers", () => ({
  nativeSwitchToOrigin: nativeSwitchToOriginMock,
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

beforeEach(() => {
  isNativeMobileValue = false;
  nativeSwitchAccepts = true;
  remoteGatewayMode = false;
  publicBaseUrl = "https://gateway.example/assistant-1";
  assignMock.mockClear();
  nativeSwitchToOriginMock.mockClear();
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
