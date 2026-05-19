/**
 * Structural smoke tests for the onboarding HatchingScreen.
 *
 * The web workspace has no DOM renderer, so we render to a static HTML string
 * with `react-dom/server`. That path doesn't execute `useEffect`, so the
 * lifecycle (hatch call + polling) cannot be asserted end-to-end here — those
 * are covered indirectly by `useAssistantLifecycle.test.ts` and the unit tests
 * on `shouldRecoverFromHatchFailure` / `resolveAssistantLifecycleState` in
 * `@/lib/assistants`.
 *
 * Mocks:
 *   - `next/navigation` — `useRouter` requires a Next.js router context.
 *   - `@/lib/assistants/api` — not actually called during static render, but
 *     importing the real module pulls in the HeyAPI client which tries to
 *     touch the DOM for CSRF setup.
 *   - `@sentry/react` — defensive, in case init side-effects reach out to
 *     the network / window on import.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — must be registered before the subject module is imported.
// ---------------------------------------------------------------------------

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/lib/assistants/api.js", () => ({
  hatchAssistant: async () => ({ ok: true, status: 200, data: {} }),
  getAssistant: async () => ({ ok: false, status: 404, error: {} }),
}));

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
}));

// `useAuth` throws when called outside `AuthProvider`, so stub it for the
// static-markup path. The real hook is exercised via integration in the
// app; HatchingScreen only reads `userId` to scope the consent gate.
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

import { routes } from "@/lib/routes.js";

import {
  decideHatchGate,
  HatchingScreen,
  interpolateSegmentProgress,
} from "@/domains/onboarding/hatching/HatchingScreen.js";

describe("HatchingScreen", () => {
  test("renders the 'Waking up…' title with a real ellipsis character", () => {
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain("Waking up…");
  });

  test("renders the 'Hang tight' subtitle", () => {
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain("Hang tight");
  });

  test("renders a compositor avatar as a data-url img", () => {
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain("<img");
    // The compositor avatar is an inline SVG data URL.
    expect(html).toContain("data:image/svg+xml");
  });

  test("renders a ProgressBar (role='progressbar')", () => {
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
  });

  test("renders the initial 'Setting up your assistant…' phase label", () => {
    // The screen mounts in the `initializing` phase (a brief label shown
    // before provisioning begins). `renderToStaticMarkup` captures this
    // initial state; effects that would later transition to `provisioning`
    // / `connecting` / `ready` are skipped.
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain("Setting up your assistant…");
    expect(html).toContain('aria-valuenow="0"');
  });

  test("renders CreatureFooter via the login-background-characters.svg asset", () => {
    const html = renderToStaticMarkup(<HatchingScreen />);
    expect(html).toContain("login-background-characters.svg");
    expect(html).toContain('aria-hidden="true"');
  });
});

// ---------------------------------------------------------------------------
// Pure gate decision — unit-tested directly since `renderToStaticMarkup`
// skips the `useEffect` that applies the decision via `router.replace`.
// ---------------------------------------------------------------------------

describe("decideHatchGate", () => {
  const baseOk = {
    isAuthLoading: false,
    isLoggedIn: true,
    onboardingCompleted: false,
    tosAccepted: true,
    aiDataConsentAccepted: true,
    cameFromPrivacyScreen: false,
  };

  test("proceeds when both consent flags are set", () => {
    expect(decideHatchGate(baseOk)).toEqual({ kind: "proceed" });
  });

  test("redirects to /onboarding/privacy when only TOS is persisted but AI consent is missing", () => {
    // Apple Guideline 5.1.2(i) requires explicit, separate AI consent.
    // A partial-consent state on disk (TOS yes, AI no) should not be
    // treated as "consent given" — bounce back through the privacy screen.
    expect(
      decideHatchGate({
        ...baseOk,
        tosAccepted: true,
        aiDataConsentAccepted: false,
        cameFromPrivacyScreen: false,
      }),
    ).toEqual({ kind: "redirect", to: routes.onboarding.privacy });
  });

  test("redirects to /onboarding/privacy when only AI consent is persisted but TOS is missing", () => {
    expect(
      decideHatchGate({
        ...baseOk,
        tosAccepted: false,
        aiDataConsentAccepted: true,
        cameFromPrivacyScreen: false,
      }),
    ).toEqual({ kind: "redirect", to: routes.onboarding.privacy });
  });

  test("waits while auth is still loading (won't fire hatch with unknown session)", () => {
    expect(
      decideHatchGate({ ...baseOk, isAuthLoading: true }),
    ).toEqual({ kind: "wait" });
  });

  test("redirects to /account/login when the user isn't authenticated", () => {
    // Codex P2 regression guard: a signed-out visitor must not be allowed
    // to proceed into hatch/poll API calls — they'd only hit a generic
    // failure screen instead of being bounced to login.
    expect(
      decideHatchGate({ ...baseOk, isLoggedIn: false }),
    ).toEqual({ kind: "redirect", to: routes.account.login });
  });

  test("redirects to /assistant when onboarding is already completed", () => {
    expect(
      decideHatchGate({ ...baseOk, onboardingCompleted: true }),
    ).toEqual({ kind: "redirect", to: routes.assistant });
  });

  test("redirects to /onboarding/privacy when no consent signal is present", () => {
    expect(
      decideHatchGate({
        ...baseOk,
        tosAccepted: false,
        aiDataConsentAccepted: false,
        cameFromPrivacyScreen: false,
      }),
    ).toEqual({ kind: "redirect", to: routes.onboarding.privacy });
  });

  test("proceeds when the URL signal is present even if the persisted flags are absent (storage-disabled path — regression guard for the loop Codex flagged)", () => {
    expect(
      decideHatchGate({
        ...baseOk,
        tosAccepted: false,
        aiDataConsentAccepted: false,
        cameFromPrivacyScreen: true,
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("auth-loading takes precedence over not-logged-in (avoids a redirect flash during session resolve)", () => {
    expect(
      decideHatchGate({
        ...baseOk,
        isAuthLoading: true,
        isLoggedIn: false,
      }),
    ).toEqual({ kind: "wait" });
  });
});

// ---------------------------------------------------------------------------
// Cubic ease-out segment interpolator — exercised directly since the visual
// effect is driven by wall-clock and requestAnimationFrame, neither of
// which is easily observable via `renderToStaticMarkup`.
// ---------------------------------------------------------------------------

describe("interpolateSegmentProgress", () => {
  test("returns segmentStart at elapsed=0", () => {
    expect(interpolateSegmentProgress(0, 0.33, 0)).toBe(0);
    expect(interpolateSegmentProgress(0.33, 0.66, 0)).toBe(0.33);
  });

  test("returns exact target at elapsed=SEGMENT_DURATION (1500ms)", () => {
    // At t=1.0 the cubic easing is 1.0, so progress reaches the target.
    expect(interpolateSegmentProgress(0, 0.33, 1500)).toBeCloseTo(0.33, 10);
    expect(interpolateSegmentProgress(0.33, 0.66, 1500)).toBeCloseTo(0.66, 10);
    expect(interpolateSegmentProgress(0.66, 1.0, 1500)).toBeCloseTo(1.0, 10);
  });

  test("returns correct value at midpoint (750ms)", () => {
    // t=0.5, eased = 1 - (1-0.5)^3 = 1 - 0.125 = 0.875
    // progress = 0 + 0.33 * 0.875 = 0.28875
    const result = interpolateSegmentProgress(0, 0.33, 750);
    expect(result).toBeCloseTo(0.33 * 0.875, 5);
  });

  test("monotonically increases over time within a segment", () => {
    const a = interpolateSegmentProgress(0, 0.33, 200);
    const b = interpolateSegmentProgress(0, 0.33, 500);
    const c = interpolateSegmentProgress(0, 0.33, 1000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  test("clamps at target for elapsed > SEGMENT_DURATION", () => {
    // Past the segment duration, t is clamped to 1.0 so the value
    // stays at the target — no overshoot.
    expect(interpolateSegmentProgress(0, 0.33, 3000)).toBeCloseTo(0.33, 10);
    expect(interpolateSegmentProgress(0.33, 0.66, 5000)).toBeCloseTo(0.66, 10);
  });

  test("returns target when segmentStart >= target", () => {
    // Edge case: if the displayed value already equals or exceeds the
    // target (e.g. a phase was skipped), short-circuit to the target.
    expect(interpolateSegmentProgress(0.33, 0.33, 500)).toBe(0.33);
    expect(interpolateSegmentProgress(0.5, 0.33, 500)).toBe(0.33);
  });

  test("handles non-zero segment start (phase transition)", () => {
    // Simulates transitioning from provisioning (at 0.33) to connecting
    // (target 0.66). At t=1.0 should reach 0.66 exactly.
    expect(interpolateSegmentProgress(0.33, 0.66, 1500)).toBeCloseTo(0.66, 10);
    // At t=0.5, eased=0.875, progress = 0.33 + (0.66-0.33)*0.875 = 0.33 + 0.28875 = 0.61875
    expect(interpolateSegmentProgress(0.33, 0.66, 750)).toBeCloseTo(
      0.33 + 0.33 * 0.875,
      5,
    );
  });
});
