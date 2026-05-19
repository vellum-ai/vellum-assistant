/**
 * Tests for `OfflineBanner` — verifies the component renders nothing on
 * non-native platforms and nothing when connected.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let isNativePlatformMock = false;
let connectedMock = true;

mock.module("@/lib/native-auth.js", () => ({
  isNativePlatform: () => isNativePlatformMock,
  useIsNativePlatform: () => isNativePlatformMock,
}));

mock.module("@/lib/network-status.js", () => ({
  useNetworkStatus: () => connectedMock,
}));

import { OfflineBanner } from "@/components/app/assistant/OfflineBanner/OfflineBanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  isNativePlatformMock = false;
  connectedMock = true;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OfflineBanner", () => {
  test("renders nothing on web (non-native)", () => {
    isNativePlatformMock = false;
    connectedMock = false;
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toBe("");
  });

  test("renders nothing when connected on native", () => {
    isNativePlatformMock = true;
    connectedMock = true;
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toBe("");
  });

  test("renders banner when offline on native", () => {
    isNativePlatformMock = true;
    connectedMock = false;
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toContain("offline");
  });
});
