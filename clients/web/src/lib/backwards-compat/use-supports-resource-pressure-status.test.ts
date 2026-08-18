import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsResourcePressureStatus,
} from "@/lib/backwards-compat/use-supports-resource-pressure-status";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsResourcePressureStatus());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// `false` means the monitor never mounts its poll loop, so a daemon
// without the route is never asked for it.
describe("useSupportsResourcePressureStatus", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  // The 0.11.4 release branch was cut from main before the route
  // landed, so the whole 0.11.4 line (staging builds included) must
  // stay dark along with every earlier release.
  test("returns false for release lines without the route", () => {
    expect(check("0.11.4")).toBe(false);
    expect(check("0.11.4-staging.3")).toBe(false);
    expect(check("0.11.3")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  // Pre-0.11.5 dev builds are excluded even when cut after the route
  // landed: the floor trades them away for zero 404 noise against the
  // routeless 0.11.4 line.
  test("returns false for dev builds below the release floor", () => {
    expect(check("0.11.3-dev.202608181912.d77d014")).toBe(false);
    expect(check("0.11.4-dev.202608190000.fedcba9")).toBe(false);
  });

  test("returns true at the floor and beyond", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.11.5-dev.202608190000.fedcba9")).toBe(true);
    expect(check("0.11.6")).toBe(true);
    expect(check("0.12.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
