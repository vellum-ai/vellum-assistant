import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsIngressStatus,
} from "@/lib/backwards-compat/ingress-status-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function check(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  const { result } = renderHook(() => useSupportsIngressStatus());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// `false` means the status query never mounts, so a daemon without the
// route is never asked for it.
describe("useSupportsIngressStatus", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  // 0.11.5 was cut from a commit that predates the route, so its whole
  // line stays dark along with every earlier release.
  test("returns false for release lines without the route", () => {
    expect(check("0.11.5")).toBe(false);
    expect(check("0.11.5-staging.2")).toBe(false);
    expect(check("0.11.4")).toBe(false);
    expect(check("0.10.12")).toBe(false);
  });

  // Pre-0.11.6 dev builds are excluded even when cut after the route
  // landed: the floor trades them away for zero 404 noise.
  test("returns false for dev builds below the release floor", () => {
    expect(check("0.11.4-dev.202608211200.d77d014")).toBe(false);
    expect(check("0.11.5-dev.202608220000.fedcba9")).toBe(false);
  });

  test("returns true at the floor and beyond", () => {
    expect(check(MIN_VERSION)).toBe(true);
    expect(check("0.11.6-dev.202608220000.fedcba9")).toBe(true);
    expect(check("0.11.7")).toBe(true);
    expect(check("0.12.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.11")).toBe(false);
  });
});
