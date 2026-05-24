import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  supportsFlagPush,
  useFlagQueryFreshness,
} from "@/lib/feature-flags/flag-query-freshness.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("supportsFlagPush", () => {
  test("returns false for null version", () => {
    expect(supportsFlagPush(null)).toBe(false);
  });

  test("returns false for unparseable version", () => {
    expect(supportsFlagPush("not-a-version")).toBe(false);
    expect(supportsFlagPush("0.8")).toBe(false);
  });

  test("returns false for versions below 0.8.5", () => {
    expect(supportsFlagPush("0.8.4")).toBe(false);
    expect(supportsFlagPush("0.8.0")).toBe(false);
    expect(supportsFlagPush("0.7.99")).toBe(false);
    expect(supportsFlagPush("0.0.1")).toBe(false);
  });

  test("returns true for 0.8.5 and later", () => {
    expect(supportsFlagPush("0.8.5")).toBe(true);
    expect(supportsFlagPush("0.8.6")).toBe(true);
    expect(supportsFlagPush("0.9.0")).toBe(true);
    expect(supportsFlagPush("1.0.0")).toBe(true);
  });

  test("ignores pre-release suffixes — 0.8.5-rc.1 counts as push-capable", () => {
    expect(supportsFlagPush("0.8.5-rc.1")).toBe(true);
    expect(supportsFlagPush("0.8.5-alpha")).toBe(true);
    expect(supportsFlagPush("0.9.0-beta.3")).toBe(true);
  });

  test("strips leading 'v' prefix", () => {
    expect(supportsFlagPush("v0.8.5")).toBe(true);
    expect(supportsFlagPush("v0.8.4")).toBe(false);
  });
});

describe("useFlagQueryFreshness", () => {
  test("returns poll options when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 5_000,
      refetchInterval: 5_000,
    });
  });

  test("returns poll options for assistants on 0.8.4", () => {
    setVersion("0.8.4");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 5_000,
      refetchInterval: 5_000,
    });
  });

  test("returns push options for assistants on 0.8.5+", () => {
    setVersion("0.8.5");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current).toEqual({
      staleTime: 60_000,
      refetchInterval: false,
    });
  });

  test("re-renders when version flips poll → push", () => {
    setVersion("0.8.4");
    const { result } = renderHook(() => useFlagQueryFreshness(), { wrapper });
    expect(result.current.refetchInterval).toBe(5_000);
    act(() => setVersion("0.8.5"));
    expect(result.current.refetchInterval).toBe(false);
    expect(result.current.staleTime).toBe(60_000);
  });
});
