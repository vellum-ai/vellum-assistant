/**
 * Tests for the Stripe Checkout cancel return route.
 *
 * Strategy mirrors `AdjustPlanClient.test.tsx`: `bun test` cannot drive a real
 * DOM, so we patch `react.useEffect` to invoke effect callbacks synchronously
 * and use `renderToStaticMarkup` to exercise the redirect-on-mount behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const routerReplace = mock((..._args: unknown[]) => {});

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: routerReplace,
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const toastInfo = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast", () => ({
  toast: {
    info: toastInfo,
    error: () => {},
    success: () => {},
    warning: () => {},
  },
}));

// `renderToStaticMarkup` does not flush effects (SSR). Patch `useEffect` to
// invoke effect callbacks synchronously so we can assert on the toast +
// redirect side effects fired from the page's mount effect.
import * as React from "react";

mock.module("react", () => ({
  ...React,
  useEffect: (effect: () => void | (() => void), _deps?: unknown[]) => {
    effect();
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks above).
// ---------------------------------------------------------------------------

import { routes } from "@/lib/routes.js";

import UpgradeCancelPage from "@/domains/settings/billing/upgrade/cancel/page.js";

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  routerReplace.mockClear();
  toastInfo.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpgradeCancelPage", () => {
  test("calls toast.info with the cancel message on mount", () => {
    renderToStaticMarkup(<UpgradeCancelPage />);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo.mock.calls[0]![0]).toBe(
      "Upgrade canceled. No changes to your plan.",
    );
  });

  test("redirects to billing settings on mount", () => {
    renderToStaticMarkup(<UpgradeCancelPage />);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0]![0]).toBe(routes.settings.billing);
  });

  test("renders the placeholder copy", () => {
    const html = renderToStaticMarkup(<UpgradeCancelPage />);
    expect(html).toContain("Upgrade canceled");
    expect(html).toContain("Returning you to billing settings…");
  });
});
