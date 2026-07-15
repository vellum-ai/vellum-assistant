import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsAcpConnect } from "@/lib/backwards-compat/use-supports-acp-connect";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function check(version: string | null): boolean {
  setVersion(version);
  const { result } = renderHook(() => useSupportsAcpConnect());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsAcpConnect", () => {
  test("returns false when the version is unknown (conservative)", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.10.10)", () => {
    expect(check("0.10.10")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.10.10-dev.202607151252.abc1234")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.10.11")).toBe(true);
    expect(check("0.11.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.10.9")).toBe(false);
    expect(check("0.9.0")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.10")).toBe(false);
  });
});
