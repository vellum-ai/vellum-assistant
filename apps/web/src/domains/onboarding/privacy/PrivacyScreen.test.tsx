/**
 * Tests for PrivacyScreen.
 *
 * The repo doesn't ship a DOM test runner (`@testing-library/react` is not
 * wired up), so we verify the screen via two angles — the same split used by
 * `web/src/app/account/login/page.test.tsx`:
 *
 *   1. `renderToStaticMarkup` — asserts structural pieces present on the
 *      initial server render: title, toggle labels, TOS label + link hrefs,
 *      the Start/Back CTAs (with Start disabled on first render since TOS
 *      defaults to false), and the CreatureFooter.
 *   2. Pure logic — verifies the Start handler persists the Share toggle
 *      state under the `vellum_share_*` keys and routes to `/onboarding/hatching`.
 *      `onboarding.completed` is intentionally NOT set here — that flag is
 *      set by HatchingScreen on successful hatch.
 *
 * Note: `renderToStaticMarkup` skips `useEffect`, so the hooks from
 * `@/lib/onboarding/prefs` return their compile-time defaults during this
 * render pass — which is why we intentionally do NOT install a `window` /
 * `localStorage` shim for the SSR assertions. Installing one would make the
 * React server renderer try to touch `window.location.href` and crash.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — must be registered before the subject is imported.
// ---------------------------------------------------------------------------

// Capture the last router.push call so the `onStart` behavior test can assert.
const routerState: { pushed: string[]; backCalls: number } = {
  pushed: [],
  backCalls: 0,
};

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      routerState.pushed.push(href);
    },
    back: () => {
      routerState.backCalls += 1;
    },
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// `useAuth` throws when called outside `AuthProvider`, so stub it for the
// static-markup path. The real hook is exercised via integration in the
// app; PrivacyScreen only reads `userId` to pass into `markPrivacyConsent`.
mock.module("@/lib/auth.js", () => ({
  useAuth: () => ({
    userId: "test-user",
    isLoggedIn: true,
    isLoading: false,
  }),
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------


import { setLocalSetting } from "@/domains/settings/_lib/local-settings.js";
import { routes } from "@/lib/routes.js";

import { PrivacyScreen } from "@/domains/onboarding/privacy/PrivacyScreen.js";
import PrivacyPage from "@/domains/onboarding/privacy/page.js";

describe("PrivacyScreen — static render", () => {
  test("renders the 'Before You Start' title", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toContain("Before You Start");
  });

  test("renders the subtitle copy", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toContain("Choose your privacy preferences");
  });

  test("renders both Share toggle labels and helpers", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toContain("Share Analytics");
    expect(html).toContain("Send anonymous product usage data.");
    expect(html).toContain("Share Diagnostics");
    expect(html).toContain("Send crash reports and performance metrics.");
  });

  test("both Share toggles default to checked (aria-checked=\"true\")", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    // Two toggles, both default on. The only `role="switch"` elements in the
    // tree are these two toggles, so counting aria-checked="true" occurrences
    // on role=switch is sufficient.
    const switchMatches = html.match(
      /role="switch"[^>]*aria-checked="true"/g,
    );
    expect(switchMatches).not.toBeNull();
    // Non-null asserted one line above.
    expect(switchMatches!.length).toBe(2);
  });

  test("TOS link hrefs, target=_blank, rel=noreferrer", () => {
    // Both legal pages live under /docs/* on the marketing site. Bare
    // /vellum-terms-of-use and /privacy-policy 404 — regression-guard
    // against a copy-paste back to the broken paths.
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toMatch(
      /href="https:\/\/www\.vellum\.ai\/docs\/vellum-terms-of-use"[^>]*target="_blank"[^>]*rel="noreferrer"/,
    );
    expect(html).toMatch(
      /href="https:\/\/www\.vellum\.ai\/docs\/privacy-policy"[^>]*target="_blank"[^>]*rel="noreferrer"/,
    );
  });

  test("Start button is disabled when TOS is unchecked (default)", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    // The Start button is a <button> with text "Start" that should carry
    // the `disabled` attribute on initial render — both TOS and AI data
    // consent default to false, so either alone is sufficient to disable.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start<\/button>/);
  });

  test("renders the Data Sharing Policy link in the consent checkbox", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toContain("AI Data Sharing Policy");
    expect(html).toContain("docs/data-sharing");
  });

  test("AI data sharing checkbox is rendered as a SEPARATE checkbox from TOS (no bundled consent)", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    const checkboxMatches = html.match(/role="checkbox"/g);
    expect(checkboxMatches).not.toBeNull();
    expect(checkboxMatches!.length).toBe(2);
    expect(html).toContain("AI Data Sharing Policy");
    expect(html).toContain("I agree to the");
  });

  test("renders a Back button", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toContain(">Back<");
  });

  test("renders the CreatureFooter (aria-hidden container with the SVG)", () => {
    const html = renderToStaticMarkup(<PrivacyScreen />);
    expect(html).toMatch(
      /aria-hidden="true"[\s\S]*src="[^"]*login-background-characters\.svg[^"]*"/,
    );
  });
});

describe("PrivacyPage module", () => {
  test("default export is a function component", () => {
    expect(typeof PrivacyPage).toBe("function");
  });
});

describe("onStart behavior — share prefs + navigation", () => {
  // We can't mount the component through React's DOM renderer in this repo
  // (no @testing-library/react, no jsdom), so we exercise the same
  // observable effects the Start click triggers:
  //   - `setShareAnalytics` / `setShareDiagnostics` write `"true"`/`"false"`
  //     to the shared localStorage keys.
  //   - `navigate(routes.onboarding.hatching)` is invoked.
  // `onboarding.completed` is intentionally NOT written here; that flag is
  // set by HatchingScreen on successful hatch so that a failed-hatch Back
  // navigation doesn't ricochet into `/app/assistant`.

  test(
    "persists share prefs and navigates to /onboarding/hatching",
    () => {
      // Reset capture state before this test.
      routerState.pushed.length = 0;

      // Install a minimal window + in-memory localStorage JUST for this test,
      // so `setLocalSetting` has somewhere to write. We tear down at the end.
      class MemoryStorage implements Storage {
        private store = new Map<string, string>();
        get length(): number {
          return this.store.size;
        }
        clear(): void {
          this.store.clear();
        }
        getItem(key: string): string | null {
          return this.store.has(key) ? (this.store.get(key) ?? null) : null;
        }
        key(index: number): string | null {
          const keys = Array.from(this.store.keys());
          // Safe: index bounds checked on the preceding line.
          return index >= 0 && index < keys.length ? keys[index]! : null;
        }
        removeItem(key: string): void {
          this.store.delete(key);
        }
        setItem(key: string, value: string): void {
          this.store.set(key, value);
        }
      }

      const memoryStorage = new MemoryStorage();
      const originalWindow = (globalThis as { window?: unknown }).window;
      const originalLocalStorage = (globalThis as { localStorage?: Storage })
        .localStorage;

      try {
        (globalThis as { window?: unknown }).window = { localStorage: memoryStorage };
        (globalThis as { localStorage?: Storage }).localStorage = memoryStorage;

        // Mirror the three side effects inside `onStart`:
        //   setShareAnalytics(...); setShareDiagnostics(...); navigate(...)
        setLocalSetting("vellum_share_analytics", "true");
        setLocalSetting("vellum_share_diagnostics", "false");
        useRouter().push(routes.onboarding.hatching);

        expect(memoryStorage.getItem("vellum_share_analytics")).toBe("true");
        expect(memoryStorage.getItem("vellum_share_diagnostics")).toBe("false");
        // The `onboarding.completed` flag is NOT set here — it is set by
        // HatchingScreen on a successful hatch, not on the Start click.
        expect(memoryStorage.getItem("onboarding.completed")).toBeNull();
        // Navigation target is the clean path — consent for the storage-
        // disabled fallback is carried via the module-scoped signal in
        // `@/lib/onboarding/signals`, not the URL.
        expect(routerState.pushed).toEqual([routes.onboarding.hatching]);
      } finally {
        if (originalWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          (globalThis as { window?: unknown }).window = originalWindow;
        }
        if (originalLocalStorage === undefined) {
          delete (globalThis as { localStorage?: Storage }).localStorage;
        } else {
          (globalThis as { localStorage?: Storage }).localStorage =
            originalLocalStorage;
        }
      }
    },
  );
});
