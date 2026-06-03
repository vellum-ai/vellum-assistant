import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { resolveLocalOnboardingRoute } from "@/utils/local-onboarding-route";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const initialAuthState = useAuthStore.getState();
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

afterEach(() => {
  jest.useRealTimers();
  useAuthStore.setState(initialAuthState, true);
});

describe("resolveLocalOnboardingRoute", () => {
  test("waits for the probe to settle before choosing a route", async () => {
    useAuthStore.setState({
      hasPlatformSession: false,
      platformSessionResolved: false,
    });

    const captured: { route: string | null } = { route: null };
    const pending = resolveLocalOnboardingRoute().then((route) => {
      captured.route = route;
    });

    // Probe in flight: the bare `false` must not be read as "no session".
    await tick();
    expect(captured.route).toBeNull();

    useAuthStore.setState({
      hasPlatformSession: true,
      platformSessionResolved: true,
    });
    await pending;
    expect(captured.route).toBe(routes.onboarding.hosting);
  });

  test("routes to hosting for a resolved platform session", async () => {
    useAuthStore.setState({
      hasPlatformSession: true,
      platformSessionResolved: true,
    });
    expect(await resolveLocalOnboardingRoute()).toBe(routes.onboarding.hosting);
  });

  test("routes to welcome once resolved with no platform session", async () => {
    useAuthStore.setState({
      hasPlatformSession: false,
      platformSessionResolved: true,
    });
    expect(await resolveLocalOnboardingRoute()).toBe(routes.onboarding.welcome);
  });

  test("falls back to welcome when the probe never settles within the timeout", async () => {
    jest.useFakeTimers();
    useAuthStore.setState({
      hasPlatformSession: false,
      platformSessionResolved: false,
    });

    const pending = resolveLocalOnboardingRoute();
    // A hung probe must not block navigation forever; once the timeout
    // elapses the still-unconfirmed session resolves to the safe default.
    jest.advanceTimersByTime(5_000);
    expect(await pending).toBe(routes.onboarding.welcome);
  });
});
