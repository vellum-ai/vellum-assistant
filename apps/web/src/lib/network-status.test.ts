/**
 * Tests for `useNetworkStatus` — the Capacitor Network plugin hook.
 *
 * Covers the web fallback path: always returns `true` when not on a native
 * platform, and does not call any Network APIs.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject module is imported.
// ---------------------------------------------------------------------------

let isNativePlatformMock = false;
let getStatusMock = mock(() => Promise.resolve({ connected: true }));
let addListenerMock = mock(() => Promise.resolve({ remove: mock(() => {}) }));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock,
  },
  registerPlugin: () => ({}),
  WebPlugin: class {},
}));

mock.module("@capacitor/network", () => ({
  Network: {
    getStatus: () => getStatusMock(),
    addListener: () => addListenerMock(),
  },
}));

import { useNetworkStatus } from "@/lib/network-status.js";

// ---------------------------------------------------------------------------
// Helpers — render the hook via a tiny wrapper component + renderToStaticMarkup
// so we don't need @testing-library/react.
// ---------------------------------------------------------------------------

function HookConsumer() {
  const connected = useNetworkStatus();
  return createElement("span", null, String(connected));
}

beforeEach(() => {
  isNativePlatformMock = false;
  getStatusMock = mock(() => Promise.resolve({ connected: true }));
  addListenerMock = mock(() => Promise.resolve({ remove: mock(() => {}) }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useNetworkStatus", () => {
  test("returns true on web (non-native platform)", () => {
    isNativePlatformMock = false;
    const html = renderToStaticMarkup(createElement(HookConsumer));
    expect(html).toBe("<span>true</span>");
  });

  test("returns true as default on native (SSR snapshot)", () => {
    isNativePlatformMock = true;
    const html = renderToStaticMarkup(createElement(HookConsumer));
    expect(html).toBe("<span>true</span>");
  });
});
