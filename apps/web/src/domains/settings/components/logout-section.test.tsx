/**
 * Tests for `LogOutSection`.
 *
 * Uses `renderToStaticMarkup` (SSR) to assert the visibility gate: the Log Out
 * card shows whenever we are not in pure local mode, and is hidden in local
 * mode without a platform session.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isLocalModeRef = { value: false };
const hasPlatformSessionRef = { value: false };

mock.module("react-router", () => ({
  useNavigate: () => () => {},
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => isLocalModeRef.value,
}));

mock.module("@/stores/auth-store", () => ({
  useHasPlatformSession: () => hasPlatformSessionRef.value,
}));

mock.module("@/lib/auth/handle-logout", () => ({
  handleLogout: async () => {},
}));

import { LogOutSection } from "@/domains/settings/components/logout-section";

beforeEach(() => {
  isLocalModeRef.value = false;
  hasPlatformSessionRef.value = false;
});

describe("LogOutSection", () => {
  test("renders the Log Out card when not in local mode", () => {
    isLocalModeRef.value = false;
    const html = renderToStaticMarkup(createElement(LogOutSection));
    expect(html).toContain("Log Out");
  });

  test("renders nothing in pure local mode without a platform session", () => {
    isLocalModeRef.value = true;
    hasPlatformSessionRef.value = false;
    const html = renderToStaticMarkup(createElement(LogOutSection));
    expect(html).toBe("");
  });

  test("renders the Log Out card in local mode when a platform session exists", () => {
    isLocalModeRef.value = true;
    hasPlatformSessionRef.value = true;
    const html = renderToStaticMarkup(createElement(LogOutSection));
    expect(html).toContain("Log Out");
  });
});
